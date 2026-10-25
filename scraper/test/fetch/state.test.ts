// Port of haqita tests/scrapers/test_state_persistence.py — state
// round-trip, MD5 novelty, dedupe, filenames, size/dimension gates.

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  classifyImages,
  filenameFromUrl,
  loadState,
  md5Hash,
  probeImageDimensions,
  saveState,
} from '../../src/fetch/state.js'

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
    const state = await loadState(path.join(dir, 'state.json'))
    expect(state).toEqual({ lastRun: null, processed: [] })
  })

  it('saves and reloads state', async () => {
    const dir = await tempDir()
    const stateFile = path.join(dir, 'state.json')
    await saveState(
      {
        lastRun: '2026-05-14T12:00:00',
        processed: [
          {
            filename: 'img1.jpg',
            md5: 'abc123',
            imageUrl: 'https://example.com/1.jpg',
            brochureUrl: 'https://example.com',
            downloadedAt: '2026-05-14T12:00:00',
          },
        ],
      },
      stateFile
    )
    const loaded = await loadState(stateFile)
    expect(loaded.lastRun).toBe('2026-05-14T12:00:00')
    expect(loaded.processed).toHaveLength(1)
    expect(loaded.processed[0]!.md5).toBe('abc123')
  })

  it('tolerates malformed JSON by failing loudly', async () => {
    const dir = await tempDir()
    const stateFile = path.join(dir, 'state.json')
    await writeFile(stateFile, 'not valid json', 'utf8')
    await expect(loadState(stateFile)).rejects.toThrow()
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

describe('classifyImages', () => {
  async function setup() {
    const imagesDir = await tempDir()
    const big = fakeJpeg(640, 480, 60 * 1024) // passes size + dimension gates
    const fetcher = {
      fetchBytes: (url: string) => {
        if (url.includes('small-file')) return Promise.resolve(new Uint8Array(100))
        if (url.includes('small-dim')) return Promise.resolve(fakeJpeg(100, 100, 60 * 1024))
        if (url.includes('same-a') || url.includes('same-b')) return Promise.resolve(big)
        if (url.includes('broken')) return Promise.reject(new Error('boom'))
        return Promise.resolve(big)
      },
    }
    return { imagesDir, fetcher, big }
  }

  const opts = { minImageSizeKb: 50, minDimensionPx: 300 }

  it('classifies new vs existing by MD5 and skips rejects', async () => {
    const { imagesDir, fetcher, big } = await setup()
    const state = {
      lastRun: null,
      processed: [
        {
          filename: 'known.jpg',
          md5: md5Hash(big),
          imageUrl: 'https://example.com/known.jpg',
          brochureUrl: 'https://example.com',
          downloadedAt: '2026-01-01T00:00:00',
        },
      ],
    }
    const result = await classifyImages(
      [
        { imageUrl: 'https://example.com/new.jpg', brochureUrl: 'https://example.com/katalog' },
        { imageUrl: 'https://example.com/same-a.jpg', brochureUrl: 'https://example.com/katalog' },
        { imageUrl: 'https://example.com/same-b.jpg', brochureUrl: 'https://example.com/katalog' },
        {
          imageUrl: 'https://example.com/small-file.jpg',
          brochureUrl: 'https://example.com/katalog',
        },
        {
          imageUrl: 'https://example.com/small-dim.jpg',
          brochureUrl: 'https://example.com/katalog',
        },
        { imageUrl: 'https://example.com/broken.jpg', brochureUrl: 'https://example.com/katalog' },
      ],
      state,
      { ...opts, imagesDir, fetcher }
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
    const fetcherAlt = { fetchBytes: () => Promise.resolve(alt) }
    const result = await classifyImages(
      [{ imageUrl: 'https://example.com/alt.jpg', brochureUrl: 'https://example.com/katalog' }],
      { lastRun: null, processed: [] },
      { ...opts, imagesDir, fetcher: fetcherAlt }
    )
    expect(result.newImages).toHaveLength(1)
    const entry = result.newImages[0]!
    expect(entry.filename).toContain('alt_')
    const written = await readFile(entry.filePath)
    expect(md5Hash(new Uint8Array(written))).toBe(entry.md5)
    expect(entry.brochureUrl).toBe('https://example.com/katalog')
  })
})
