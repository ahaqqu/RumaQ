// Novelty detection (port of haqita base_scraper.py state + classify loop):
// URL+MD5 state.json so unchanged brochure pages are never re-OCR'd or
// re-published — bytes are still downloaded once per run to compute the MD5
// (Gemini quota guard, docs/plan/haqita-integration.md §9).

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { BrochurePage } from '../stores/types.js'
import type { StoreFetcher } from './strategy.js'

export interface ProcessedImage {
  filename: string
  md5: string
  imageUrl: string
  brochureUrl: string
  downloadedAt: string
}

export interface ScraperState {
  lastRun: string | null
  processed: ProcessedImage[]
}

export function md5Hash(data: Uint8Array): string {
  return createHash('md5').update(data).digest('hex')
}

export async function loadState(stateFile: string): Promise<ScraperState> {
  try {
    const raw = await readFile(stateFile, 'utf8')
    const parsed = JSON.parse(raw) as Partial<ScraperState>
    return { lastRun: parsed.lastRun ?? null, processed: parsed.processed ?? [] }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { lastRun: null, processed: [] }
    throw error
  }
}

export async function saveState(state: ScraperState, stateFile: string): Promise<void> {
  await mkdir(path.dirname(stateFile), { recursive: true })
  await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8')
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

export interface ClassifyOptions {
  /** Directory images are written to. */
  imagesDir: string
  minImageSizeKb: number
  minDimensionPx: number
  fetcher: Pick<StoreFetcher, 'fetchBytes'>
  log?: (message: string) => void
}

export interface ClassifiedImage extends ProcessedImage {
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
 * cheap and OCR only ever sees new pages.
 */
export async function classifyImages(
  pages: BrochurePage[],
  state: ScraperState,
  options: ClassifyOptions
): Promise<ClassifyResult> {
  const knownHashes = new Set(state.processed.map((entry) => entry.md5))
  const seenThisRun = new Set<string>()
  const result: ClassifyResult = { newImages: [], existingImages: [], skipped: [] }
  const minSize = options.minImageSizeKb * 1024
  const log = options.log ?? (() => {})

  await mkdir(options.imagesDir, { recursive: true })

  for (const page of pages) {
    let data: Uint8Array
    try {
      data = await options.fetcher.fetchBytes(page.imageUrl)
    } catch (error) {
      result.skipped.push({ imageUrl: page.imageUrl, reason: `download_failed: ${String(error)}` })
      continue
    }

    if (data.byteLength < minSize) {
      const reason = `too_small_file: ${data.byteLength} bytes`
      log(`[SKIP] ${path.basename(page.imageUrl)} — ${reason}`)
      result.skipped.push({ imageUrl: page.imageUrl, reason })
      continue
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
      continue
    }

    const hash = md5Hash(data)
    if (seenThisRun.has(hash)) {
      result.skipped.push({ imageUrl: page.imageUrl, reason: 'duplicate_content' })
      continue
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
      filePath,
    }
    if (knownHashes.has(hash)) {
      result.existingImages.push(entry)
      log(`[SKIP] ${filename} — already processed (MD5 match)`)
    } else {
      await writeFile(filePath, data)
      result.newImages.push(entry)
      log(`[NEW] ${filename}`)
    }
  }

  return result
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
export async function pruneImages(
  imagesRoot: string,
  options: PruneImagesOptions = {}
): Promise<string[]> {
  const nowMs = (options.now ?? new Date()).getTime()
  const maxAgeMs = (options.maxAgeDays ?? IMAGE_RETENTION_DAYS) * 24 * 60 * 60 * 1000
  const log = options.log ?? (() => {})

  let entries
  try {
    entries = await readdir(imagesRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const pruned: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{8}$/.test(entry.name)) continue
    const dirDate = parseDateDir(entry.name)
    if (!dirDate || nowMs - dirDate.getTime() <= maxAgeMs) continue
    await rm(path.join(imagesRoot, entry.name), { recursive: true, force: true })
    pruned.push(entry.name)
    log(`[prune] removed images/${entry.name}`)
  }
  return pruned
}
