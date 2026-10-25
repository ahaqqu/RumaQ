// Novelty detection (port of haqita base_scraper.py state + classify loop):
// URL+MD5 state.json so unchanged brochure pages are never re-OCR'd or
// re-published — bytes are still downloaded once per run to compute the MD5
// (Gemini quota guard, docs/plan/haqita-integration.md §9).

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Cause, Data, Effect } from 'effect'

import type { BrochurePage } from '../stores/types.js'
import { writeFileAtomic, wrapIo } from '../util/io.js'
import type { DownloadedImage, StoreFetcher } from './strategy.js'

export class StateIo extends Data.TaggedError('StateIo')<{
  op: string
  path: string
  cause: unknown
  message: string
}> {}

const io = wrapIo(StateIo)

export interface ScraperState {
  lastRun: string | null
  /**
   * MD5 hashes of processed brochure images, oldest first. Entries are bare
   * hashes — novelty only ever reads the md5, and a compact list keeps the
   * per-image state.json rewrite cheap; legacy object entries are compacted
   * on load. Bounded by MAX_PROCESSED_HASHES (FIFO eviction).
   */
  processed: string[]
}

/**
 * Novelty retention cap: at most this many md5 hashes are kept (evicted
 * oldest-first). ~40 images/run/day ≈ 15k entries/year, so 50k covers years
 * of brochures while keeping state.json bounded; a page unseen for that long
 * is a genuinely new observation if it ever reappears.
 */
export const MAX_PROCESSED_HASHES = 50_000

/** Record a processed md5 in state, evicting the oldest beyond the cap. */
export function rememberProcessed(state: ScraperState, md5: string): void {
  state.processed.push(md5)
  if (state.processed.length > MAX_PROCESSED_HASHES) {
    state.processed.splice(0, state.processed.length - MAX_PROCESSED_HASHES)
  }
}

/**
 * Normalize `processed` entries: legacy state files recorded full objects
 * ({ filename, md5, imageUrl, ... }) — compact them to the md5 novelty
 * reads. Unknown junk entries are dropped rather than crashing the run.
 */
function compactProcessed(entries: unknown): string[] {
  if (!Array.isArray(entries)) return []
  return entries.flatMap((entry) => {
    if (typeof entry === 'string') return [entry]
    const md5 = (entry as { md5?: unknown } | null)?.md5
    return typeof md5 === 'string' ? [md5] : []
  })
}

export function md5Hash(data: Uint8Array): string {
  return createHash('md5').update(data).digest('hex')
}

export function loadState(stateFile: string): Effect.Effect<ScraperState, StateIo> {
  return io('read', stateFile, async () => {
    let parsed: { lastRun?: string | null; processed?: unknown }
    try {
      parsed = JSON.parse(await readFile(stateFile, 'utf8')) as {
        lastRun?: string | null
        processed?: unknown
      }
    } catch (cause) {
      // Corrupt JSON (e.g. truncated by a crash before saves were atomic)
      // starts fresh — re-OCR of one run's images — instead of bricking the
      // nightly job until a human deletes the file. Real IO errors keep
      // their typed mapping.
      if ((cause as NodeJS.ErrnoException)?.code) throw cause
      return { lastRun: null, processed: [] }
    }
    return {
      lastRun: parsed.lastRun ?? null,
      processed: compactProcessed(parsed.processed),
    }
  }).pipe(
    Effect.catchIf(
      (error) => (error.cause as NodeJS.ErrnoException)?.code === 'ENOENT',
      () => Effect.succeed<ScraperState>({ lastRun: null, processed: [] })
    )
  )
}

export function saveState(state: ScraperState, stateFile: string): Effect.Effect<void, StateIo> {
  return io('ensure-dir', path.dirname(stateFile), () =>
    mkdir(path.dirname(stateFile), { recursive: true })
  ).pipe(
    Effect.flatMap(() =>
      // Atomic (temp + rename): a kill mid-save must never leave a truncated
      // state.json behind (same idiom as the catalog/embedding saves).
      io('write', stateFile, () =>
        writeFileAtomic(stateFile, JSON.stringify(state, null, 2) + '\n')
      )
    )
  )
}

/**
 * Extract a safe filename from a URL. Adds an MD5 prefix so the same
 * basename with different content never overwrites.
 */
export function filenameFromUrl(url: string, md5Prefix = ''): string {
  let name = path.basename(new URL(url).pathname)
  if (!name || !name.includes('.')) {
    name = `promo_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.jpg`
  }
  if (md5Prefix) {
    const ext = path.extname(name)
    name = `${path.basename(name, ext)}_${md5Prefix.slice(0, 8)}${ext}`
  }
  return name
}

export interface ImageDimensions {
  width: number
  height: number
}

/** Minimal JPEG (SOF) / PNG (IHDR) dimension probe; null when unparseable. */
export function probeImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let offset = 2
    while (offset + 9 < view.byteLength) {
      if (view.getUint8(offset) !== 0xff) {
        offset++
        continue
      }
      const marker = view.getUint8(offset + 1)
      // SOF0..SOF15 minus DHT (C4), JPG (C8), DAC (CC) carry dimensions.
      const isStartOfFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isStartOfFrame) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      offset += 2 + view.getUint16(offset + 2)
    }
  }
  return null
}

const EXTENSION_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}

/** Inline-image types Gemini's vision API accepts — anything else is clamped. */
const GEMINI_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
])

/**
 * Best-effort content type of downloaded brochure bytes — Gemini's
 * inlineData needs the true type, and a wrong declaration risks an API 400
 * or degraded extraction. Magic bytes win for the sniffable pair (a lying
 * header must not override the actual bytes), then the server's image/*
 * declaration, then the URL extension; every guess is clamped to the types
 * Gemini actually accepts, falling back to jpeg (the only format stores
 * have served so far). Dependency-free by design.
 */
export function imageMimeType(input: {
  contentTypeHeader?: string | null
  bytes: Uint8Array
  url?: string
}): string {
  if (
    input.bytes.length > 4 &&
    input.bytes[0] === 0x89 &&
    input.bytes[1] === 0x50 &&
    input.bytes[2] === 0x4e &&
    input.bytes[3] === 0x47
  ) {
    return 'image/png'
  }
  if (input.bytes.length > 2 && input.bytes[0] === 0xff && input.bytes[1] === 0xd8) {
    return 'image/jpeg'
  }
  const header = input.contentTypeHeader?.split(';')[0]?.trim().toLowerCase()
  if (header && GEMINI_IMAGE_TYPES.has(header)) return header
  if (input.url) {
    try {
      const byExtension = EXTENSION_MIME[path.extname(new URL(input.url).pathname).toLowerCase()]
      if (byExtension) return byExtension
    } catch {
      // Malformed URL — fall through to the default.
    }
  }
  return 'image/jpeg'
}

export interface ClassifyOptions {
  /** Directory images are written to. */
  imagesDir: string
  minImageSizeKb: number
  minDimensionPx: number
  fetcher: Pick<StoreFetcher, 'fetchBytes'>
  log?: (message: string) => void
}

export interface ClassifiedImage {
  filename: string
  md5: string
  imageUrl: string
  brochureUrl: string
  downloadedAt: string
  /**
   * Content type derived at download time (magic bytes, then server
   * declaration, then URL extension — clamped to Gemini's supported types)
   * — threaded to Gemini so inlineData never misdeclares a PNG page as jpeg.
   */
  contentType: string
  /**
   * Absolute path the file is written to. Only NEW images are written to
   * disk — existing entries are classified without re-writing their bytes.
   */
  filePath: string
}

export interface ClassifyResult {
  newImages: ClassifiedImage[]
  existingImages: ClassifiedImage[]
  /** Skipped in this run: too small, duplicate content, or failed download. */
  skipped: { imageUrl: string; reason: string }[]
}

/**
 * Download brochure pages, filter by size/dimension/novelty, and classify
 * against known MD5s. Mirrors haqita download_and_classify: an image is
 * "existing" when its content hash was already processed, so re-runs are
 * cheap and OCR only ever sees new pages. Download failures are skipped,
 * never fatal — one bad image must not block the daily snapshot.
 */
export function classifyImages(
  pages: BrochurePage[],
  state: ScraperState,
  options: ClassifyOptions
): Effect.Effect<ClassifyResult, StateIo> {
  const knownHashes = new Set(state.processed)
  const seenThisRun = new Set<string>()
  const result: ClassifyResult = { newImages: [], existingImages: [], skipped: [] }
  const minSize = options.minImageSizeKb * 1024
  const log = options.log ?? (() => {})

  const download = (page: BrochurePage): Effect.Effect<DownloadedImage | null> =>
    options.fetcher.fetchBytes(page.imageUrl).pipe(
      // Total recovery: a failed download is a skip, never a run failure —
      // one bad image must not block the daily snapshot.
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const error = Cause.squash(cause)
          result.skipped.push({
            imageUrl: page.imageUrl,
            reason: `download_failed: ${error instanceof Error ? error.message : String(error)}`,
          })
          return null
        })
      )
    )

  const classifyBytes = (
    page: BrochurePage,
    downloaded: DownloadedImage
  ): Effect.Effect<void, StateIo> =>
    Effect.suspend(() => {
      const data = downloaded.bytes
      if (data.byteLength < minSize) {
        const reason = `too_small_file: ${data.byteLength} bytes`
        log(`[SKIP] ${path.basename(page.imageUrl)} — ${reason}`)
        result.skipped.push({ imageUrl: page.imageUrl, reason })
        return Effect.succeed(undefined)
      }

      // Unparseable images pass the dimension check, like haqita's PIL fallback.
      const dimensions = probeImageDimensions(data)
      if (
        dimensions &&
        dimensions.width < options.minDimensionPx &&
        dimensions.height < options.minDimensionPx
      ) {
        const reason = `too_small_image: ${dimensions.width}x${dimensions.height}`
        log(`[SKIP] ${path.basename(page.imageUrl)} — ${reason}`)
        result.skipped.push({ imageUrl: page.imageUrl, reason })
        return Effect.succeed(undefined)
      }

      const hash = md5Hash(data)
      if (seenThisRun.has(hash)) {
        result.skipped.push({ imageUrl: page.imageUrl, reason: 'duplicate_content' })
        return Effect.succeed(undefined)
      }
      seenThisRun.add(hash)

      const filename = filenameFromUrl(page.imageUrl, hash)
      const filePath = path.join(options.imagesDir, filename)
      const entry: ClassifiedImage = {
        filename,
        md5: hash,
        imageUrl: page.imageUrl,
        brochureUrl: page.brochureUrl,
        downloadedAt: new Date().toISOString(),
        contentType: imageMimeType({
          contentTypeHeader: downloaded.contentType,
          bytes: data,
          url: page.imageUrl,
        }),
        filePath,
      }
      if (knownHashes.has(hash)) {
        result.existingImages.push(entry)
        log(`[SKIP] ${filename} — already processed (MD5 match)`)
        return Effect.succeed(undefined)
      }
      return io('write', filePath, () => writeFile(filePath, data)).pipe(
        Effect.map(() => {
          result.newImages.push(entry)
          log(`[NEW] ${filename}`)
        })
      )
    })

  const classifyPage = (page: BrochurePage): Effect.Effect<void, StateIo> =>
    download(page).pipe(
      Effect.flatMap((downloaded) =>
        downloaded === null ? Effect.succeed(undefined) : classifyBytes(page, downloaded)
      )
    )

  return io('ensure-dir', options.imagesDir, () =>
    mkdir(options.imagesDir, { recursive: true })
  ).pipe(
    Effect.flatMap(() => Effect.forEach(pages, (page) => classifyPage(page))),
    Effect.flatMap(() => Effect.succeed(result))
  )
}

/** Brochure images are kept this many days after the run that published them (plan §6). */
export const IMAGE_RETENTION_DAYS = 7

function parseDateDir(name: string): Date | null {
  const year = Number(name.slice(0, 4))
  const month = Number(name.slice(4, 6))
  const day = Number(name.slice(6, 8))
  if (!year || !month || !day) return null
  // Dated dirs are scrapedAt UTC prefixes — validate via UTC round-trip.
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null
}

export interface PruneImagesOptions {
  /** Injectable clock so tests are deterministic. */
  now?: Date
  maxAgeDays?: number
  log?: (message: string) => void
}

/**
 * Delete dated image directories under `imagesRoot` older than
 * `maxAgeDays` (plan §6: images are pruned 7 days after the run that
 * published them — the VPS state dir must not grow without bound). Only
 * `YYYYMMDD` directories are considered, so state.json and the run items
 * files elsewhere in the state dir are never touched.
 */
export function pruneImages(
  imagesRoot: string,
  options: PruneImagesOptions = {}
): Effect.Effect<string[], StateIo> {
  const nowMs = (options.now ?? new Date()).getTime()
  const maxAgeMs = (options.maxAgeDays ?? IMAGE_RETENTION_DAYS) * 24 * 60 * 60 * 1000
  const log = options.log ?? (() => {})

  return Effect.suspend(() =>
    io('readdir', imagesRoot, () => readdir(imagesRoot, { withFileTypes: true })).pipe(
      Effect.catchIf(
        (error) => (error.cause as NodeJS.ErrnoException)?.code === 'ENOENT',
        () => Effect.succeed([])
      ),
      Effect.flatMap((entries) =>
        Effect.forEach(entries, (entry) =>
          Effect.suspend(() => {
            if (!entry.isDirectory() || !/^\d{8}$/.test(entry.name)) return Effect.succeed(null)
            const dirDate = parseDateDir(entry.name)
            if (!dirDate || nowMs - dirDate.getTime() <= maxAgeMs) return Effect.succeed(null)
            return io('rm', path.join(imagesRoot, entry.name), () =>
              rm(path.join(imagesRoot, entry.name), { recursive: true, force: true })
            ).pipe(
              Effect.map(() => {
                log(`[prune] removed images/${entry.name}`)
                return entry.name
              })
            )
          })
        ).pipe(Effect.map((names) => names.filter((name): name is string => name !== null)))
      )
    )
  )
}
