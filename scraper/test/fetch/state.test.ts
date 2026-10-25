// Port of haqita tests/scrapers/test_state_persistence.py — state
// round-trip, MD5 novelty, dedupe, filenames, size/dimension gates. The
// fs-back functions are Effects — driven through Effect.runPromise.

import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vite-plus/test'
import { Data, Effect } from 'effect'

import { FetchTransport } from '../../src/fetch/strategy.js'
import {
  classifyImages,
  filenameFromUrl,
  imageMimeType,
  loadState,
  MAX_PROCESSED_HASHES,
  md5Hash,
  pruneImages,
  probeImageDimensions,
  rememberProcessed,
  saveState,
} from '../../src/fetch/state.js'

class Boom extends Data.TaggedError('Boom')<{ message: string }> {}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'rumaq-scraper-'))
}

/** Minimal JPEG with an SOF0 frame carrying the given dimensions. */
function fakeJpeg(width: number, height: number, padding = 0): Uint8Array {
  const bytes = new Uint8Array(64 + padding)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 0xffd8) // SOI
  view.setUint8(2, 0xff)
  view.setUint8(3, 0xe0) // APP0 marker
  view.setUint16(4, 16) // APP0 segment length → next marker at offset 20
  view.setUint8(20, 0xff)
  view.setUint8(21, 0xc0) // SOF0
  view.setUint16(22, 17) // SOF length
  view.setUint8(24, 8) // precision
  view.setUint16(25, height)
  view.setUint16(27, width)
  bytes.fill(0xee, 29) // entropy-ish tail so the file passes size gates
  return bytes
}

function fakePng(width: number, height: number, padding = 0): Uint8Array {
  const bytes = new Uint8Array(32 + padding)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13) // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12) // "IHDR"
  view.setUint32(16, width)
  view.setUint32(20, height)
  bytes.fill(0xbb, 24)
  return bytes
}

describe('state persistence', () => {
  it('loads empty state when no file exists', async () => {
    const dir = await tempDir()
    const state = await Effect.runPromise(loadState(path.join(dir, 'state.json')))
    expect(state).toEqual({ lastRun: null, processed: [] })
  })

  it('saves and reloads state', async () => {
    const dir = await tempDir()
    const stateFile = path.join(dir, 'state.json')
    await Effect.runPromise(
      saveState({ lastRun: '2026-05-14T12:00:00', processed: ['abc123'] }, stateFile)
    )
    const loaded = await Effect.runPromise(loadState(stateFile))
    expect(loaded.lastRun).toBe('2026-05-14T12:00:00')
    expect(loaded.processed).toEqual(['abc123'])
  })

  it('compacts legacy object entries to bare md5 hashes on load', async () => {
    const dir = await tempDir()
    const stateFile = path.join(dir, 'state.json')
    await writeFile(
      stateFile,
      JSON.stringify({
        lastRun: '2026-05-14T12:00:00',
        processed: [
          'bare-hash',
          {
            filename: 'img1.jpg',
            md5: 'abc123',
            imageUrl: 'https://example.com/1.jpg',
            brochureUrl: 'https://example.com',
            downloadedAt: '2026-05-14T12:00:00',
          },
          { no_md5_here: true },
        ],
      }),
      'utf8'
    )
    const loaded = await Effect.runPromise(loadState(stateFile))
    expect(loaded.processed).toEqual(['bare-hash', 'abc123'])
  })

  it('bounds processed hashes with FIFO eviction beyond the retention cap', () => {
    const state = { lastRun: null as string | null, processed: [] as string[] }
    for (let i = 0; i < MAX_PROCESSED_HASHES + 10; i++) {
      rememberProcessed(state, `hash-${i}`)
    }
    expect(state.processed).toHaveLength(MAX_PROCESSED_HASHES)
    expect(state.processed[0]).toBe('hash-10') // oldest ten evicted
    expect(state.processed.at(-1)).toBe(`hash-${MAX_PROCESSED_HASHES + 9}`)
  })

  it('tolerates malformed JSON by failing loudly', async () => {
    const dir = await tempDir()
    const stateFile = path.join(dir, 'state.json')
    await writeFile(stateFile, 'not valid json', 'utf8')
    await expect(Effect.runPromise(loadState(stateFile))).rejects.toThrow()
  })
})

describe('md5Hash', () => {
  it('is deterministic and content-sensitive', () => {
    expect(md5Hash(new TextEncoder().encode('hello world'))).toBe(
      md5Hash(new TextEncoder().encode('hello world'))
    )
    expect(md5Hash(new TextEncoder().encode('hello world'))).not.toBe(
      md5Hash(new TextEncoder().encode('different content'))
    )
  })
})

describe('filenameFromUrl', () => {
  it('uses the URL basename', () => {
    const name = filenameFromUrl('http://example.com/promo.jpg')
    expect(name.startsWith('promo')).toBe(true)
    expect(name.endsWith('.jpg')).toBe(true)
  })

  it('embeds the md5 prefix', () => {
    const name = filenameFromUrl('http://example.com/promo.jpg', 'abcdef1234')
    expect(name).toContain('abcdef12')
  })

  it('falls back to a timestamped .jpg name', () => {
    expect(filenameFromUrl('http://example.com/promo').endsWith('.jpg')).toBe(true)
  })

  it('strips query params', () => {
    const name = filenameFromUrl('http://example.com/images/2026/05/promo-flyer-001.JPG?w=800')
    expect(name.toLowerCase().startsWith('promo-flyer-001')).toBe(true)
    expect(name.includes('?')).toBe(false)
  })
})

describe('probeImageDimensions', () => {
  it('reads JPEG SOF dimensions', () => {
    expect(probeImageDimensions(fakeJpeg(640, 480))).toEqual({ width: 640, height: 480 })
  })

  it('reads PNG IHDR dimensions', () => {
    expect(probeImageDimensions(fakePng(800, 600))).toEqual({ width: 800, height: 600 })
  })

  it('returns null for unknown formats', () => {
    expect(probeImageDimensions(new TextEncoder().encode('not an image'))).toBeNull()
  })
})

describe('imageMimeType', () => {
  it('trusts an image/* content-type header over everything else', () => {
    expect(
      imageMimeType({
        contentTypeHeader: 'image/webp; charset=binary',
        bytes: fakePng(10, 10),
        url: 'https://example.com/a.jpg',
      })
    ).toBe('image/webp')
  })

  it('sniffs PNG magic when the header is generic octet-stream', () => {
    expect(
      imageMimeType({
        contentTypeHeader: 'application/octet-stream',
        bytes: fakePng(10, 10),
      })
    ).toBe('image/png')
  })

  it('sniffs JPEG magic when the header is missing', () => {
    expect(imageMimeType({ contentTypeHeader: null, bytes: fakeJpeg(10, 10) })).toBe('image/jpeg')
  })

  it('falls back to the URL extension when header and magic bytes say nothing', () => {
    expect(
      imageMimeType({ bytes: new Uint8Array(8), url: 'https://example.com/pages/001.PNG?w=800' })
    ).toBe('image/png')
  })

  it('defaults to jpeg when nothing identifies the bytes', () => {
    expect(imageMimeType({ bytes: new Uint8Array(8) })).toBe('image/jpeg')
  })
})

describe('classifyImages', () => {
  async function setup() {
    const imagesDir = await tempDir()
    const big = fakeJpeg(640, 480, 60 * 1024) // passes size + dimension gates
    const fetcher = {
      fetchBytes: (url: string) => {
        if (url.includes('small-file'))
          return Effect.succeed({ bytes: new Uint8Array(100), contentType: 'image/jpeg' })
        if (url.includes('small-dim'))
          return Effect.succeed({ bytes: fakeJpeg(100, 100, 60 * 1024), contentType: 'image/jpeg' })
        if (url.includes('broken'))
          return Effect.fail(
            new FetchTransport({ url, cause: new Boom({ message: 'boom' }), message: 'boom' })
          )
        return Effect.succeed({ bytes: big, contentType: 'image/jpeg' })
      },
    }
    return { imagesDir, fetcher, big }
  }

  const opts = { minImageSizeKb: 50, minDimensionPx: 300 }

  it('classifies new vs existing by MD5 and skips rejects', async () => {
    const { imagesDir, fetcher, big } = await setup()
    const state = { lastRun: null, processed: [md5Hash(big)] }
    const result = await Effect.runPromise(
      classifyImages(
        [
          { imageUrl: 'https://example.com/new.jpg', brochureUrl: 'https://example.com/katalog' },
          {
            imageUrl: 'https://example.com/same-a.jpg',
            brochureUrl: 'https://example.com/katalog',
          },
          {
            imageUrl: 'https://example.com/same-b.jpg',
            brochureUrl: 'https://example.com/katalog',
          },
          {
            imageUrl: 'https://example.com/small-file.jpg',
            brochureUrl: 'https://example.com/katalog',
          },
          {
            imageUrl: 'https://example.com/small-dim.jpg',
            brochureUrl: 'https://example.com/katalog',
          },
          {
            imageUrl: 'https://example.com/broken.jpg',
            brochureUrl: 'https://example.com/katalog',
          },
        ],
        state,
        { ...opts, imagesDir, fetcher }
      )
    )

    expect(result.existingImages).toHaveLength(1) // MD5 already known
    expect(result.skipped).toEqual([
      { imageUrl: 'https://example.com/same-a.jpg', reason: 'duplicate_content' },
      { imageUrl: 'https://example.com/same-b.jpg', reason: 'duplicate_content' },
      {
        imageUrl: 'https://example.com/small-file.jpg',
        reason: expect.stringContaining('too_small_file'),
      },
      {
        imageUrl: 'https://example.com/small-dim.jpg',
        reason: expect.stringContaining('too_small_image'),
      },
      {
        imageUrl: 'https://example.com/broken.jpg',
        reason: expect.stringContaining('download_failed'),
      },
    ])
    // "new.jpg" fetched the same bytes as the known image → existing, not new.
    expect(result.newImages).toHaveLength(0)
  })

  it('marks unseen content as new and writes files', async () => {
    const { imagesDir } = await setup()
    const alt = fakeJpeg(1024, 768, 70 * 1024)
    const fetcherAlt = {
      fetchBytes: () => Effect.succeed({ bytes: alt, contentType: 'image/jpeg' }),
    }
    const result = await Effect.runPromise(
      classifyImages(
        [{ imageUrl: 'https://example.com/alt.jpg', brochureUrl: 'https://example.com/katalog' }],
        { lastRun: null, processed: [] },
        { ...opts, imagesDir, fetcher: fetcherAlt }
      )
    )
    expect(result.newImages).toHaveLength(1)
    const entry = result.newImages[0]!
    expect(entry.filename).toContain('alt_')
    const written = await readFile(entry.filePath)
    expect(md5Hash(new Uint8Array(written))).toBe(entry.md5)
    expect(entry.brochureUrl).toBe('https://example.com/katalog')
  })

  it('carries the derived content type on new images (PNG must not be declared jpeg)', async () => {
    const imagesDir = await tempDir()
    const png = fakePng(800, 600, 60 * 1024)
    const fetcherPng = {
      fetchBytes: () => Effect.succeed({ bytes: png, contentType: 'application/octet-stream' }),
    }
    const result = await Effect.runPromise(
      classifyImages(
        [{ imageUrl: 'https://example.com/page-001.png', brochureUrl: 'https://example.com/k' }],
        { lastRun: null, processed: [] },
        { ...opts, imagesDir, fetcher: fetcherPng }
      )
    )
    expect(result.newImages).toHaveLength(1)
    expect(result.newImages[0]!.contentType).toBe('image/png') // magic-byte sniff
  })

  it('does not re-write already-processed images to disk', async () => {
    const { imagesDir, fetcher, big } = await setup()
    const result = await Effect.runPromise(
      classifyImages(
        [{ imageUrl: 'https://example.com/known.jpg', brochureUrl: 'https://example.com/katalog' }],
        { lastRun: null, processed: [md5Hash(big)] },
        { ...opts, imagesDir, fetcher }
      )
    )
    expect(result.existingImages).toHaveLength(1)
    expect(result.newImages).toHaveLength(0)
    // Classified as existing, but nothing was written — the disk copy from
    // the original run stays the only one.
    expect(await readdir(imagesDir)).toEqual([])
  })
})

describe('pruneImages', () => {
  async function seed(root: string) {
    for (const dir of ['20260101', '20261024', 'not-a-date']) {
      await mkdir(path.join(root, dir), { recursive: true })
      await writeFile(path.join(root, dir, 'img.jpg'), 'x')
    }
    await writeFile(path.join(root, 'loose-file.jpg'), 'x')
  }

  it('removes date dirs older than the retention window and keeps the rest', async () => {
    const root = await tempDir()
    await seed(root)
    // 20261024 is exactly 7 days old here — kept (pruned only when older).
    const pruned = await Effect.runPromise(
      pruneImages(root, { now: new Date('2026-10-31T00:00:00Z') })
    )
    expect(pruned).toEqual(['20260101'])
    await expect(stat(path.join(root, '20260101'))).rejects.toThrow()
    // Recent dir, non-date entries, and loose files are untouched.
    expect((await stat(path.join(root, '20261024'))).isDirectory()).toBe(true)
    expect(await readdir(path.join(root, 'not-a-date'))).toEqual(['img.jpg'])
    expect(await readdir(root)).toContain('loose-file.jpg')
  })

  it('honors a custom maxAgeDays', async () => {
    const root = await tempDir()
    await seed(root)
    const pruned = await Effect.runPromise(
      pruneImages(root, { now: new Date('2026-11-01T00:00:00Z'), maxAgeDays: 3 })
    )
    expect(pruned).toEqual(['20260101', '20261024'])
    expect(await readdir(root)).toEqual(['loose-file.jpg', 'not-a-date'])
  })

  it('returns [] when the images root does not exist', async () => {
    const pruned = await Effect.runPromise(
      pruneImages(path.join(await tempDir(), 'nope', 'images'), {
        now: new Date('2026-11-01T00:00:00Z'),
      })
    )
    expect(pruned).toEqual([])
  })
})
