// Pipeline orchestration test — full scrape → novelty → OCR → publish flow
// with every IO boundary injected (fixture HTML, fake JPEG bytes, stub
// Gemini client, dry-run publish).

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vite-plus/test'

import { runPipeline } from '../src/pipeline.js'
import type { GeminiClient } from '../src/ocr/gemini.js'
import { md5Hash } from '../src/fetch/state.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Same fake JPEG shape as test/fetch/state.test.ts, padded past the size gate. */
function fakeJpegBytes(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(64 + 60 * 1024)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 0xffd8)
  view.setUint8(2, 0xff)
  view.setUint8(3, 0xe0)
  view.setUint16(4, 16)
  view.setUint8(20, 0xff)
  view.setUint8(21, 0xc0)
  view.setUint16(22, 17)
  view.setUint8(24, 8)
  view.setUint16(25, 800)
  view.setUint16(27, 600)
  bytes.fill(0xee, 29)
  return bytes
}

describe('runPipeline', () => {
  it('runs the superindo flow end to end in dry-run mode', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const katalogHtml = await readFile(
      path.join(__dirname, 'fixtures/superindo/katalog-super-hemat.html'),
      'utf8'
    )
    const koranHtml = await readFile(
      path.join(__dirname, 'fixtures/superindo/promo-koran.html'),
      'utf8'
    )
    const jpeg = fakeJpegBytes()

    const fetchMock = async (
      url: string,
      init?: RequestInit & { proxy?: string }
    ): Promise<Response> => {
      expect(init?.headers).toBeDefined()
      if (url.includes('katalog-super-hemat')) {
        return new Response(katalogHtml, { status: 200 })
      }
      if (url.includes('promo-koran')) {
        return new Response(koranHtml, { status: 200 })
      }
      // Any image URL → the same fake brochure page.
      return new Response(jpeg, { status: 200 })
    }

    const ocrItems = [
      {
        name: 'Gula Pasir',
        brand: null,
        unit: '1 kg',
        price: 17000,
        promo: null,
        period: '22 - 28 Okt 2026',
      },
      { name: 'B', brand: null, unit: null, price: 5000, promo: null, period: null }, // name_too_short
    ]
    const ocrClient: GeminiClient = {
      models: {
        generateContent: async () => ({ text: JSON.stringify(ocrItems) }),
      },
    }

    const status = await runPipeline({
      stateDir,
      dryRun: true,
      fetch: fetchMock,
      ocrClient,
      now: () => new Date('2026-10-24T23:00:05Z'),
      log: () => {},
    })

    expect(status.stage).toBe('done')
    const entry = status.stores['superindo']!
    expect(entry.pagesFound).toBeGreaterThanOrEqual(1)
    expect(entry.newImages).toBeGreaterThanOrEqual(1)
    expect(entry.itemsExtracted).toBeGreaterThanOrEqual(1)
    expect(entry.itemsRejected).toBeGreaterThanOrEqual(1)

    // Dry-run payload written, valid, and dated by scrapedAt.
    const payloadFile = path.join(stateDir, 'payload-2026-10-24T23-00-05-000Z.json')
    const payload = JSON.parse(await readFile(payloadFile, 'utf8'))
    expect(payload.schemaVersion).toBe(1)
    expect(payload.items.length).toBe(entry.itemsExtracted)
    expect(payload.items[0]!.productKey).toBe('gula-pasir----1-kg')
    expect(payload.items[0]!.validFrom).toBe('2026-10-22')

    // Rejected item logged for VPS inspection.
    const rejected = await readFile(path.join(stateDir, 'rejected-items.log'), 'utf8')
    expect(rejected).toContain('name_too_short')

    // Status file reflects the run.
    const statusFile = JSON.parse(await readFile(path.join(stateDir, 'status.json'), 'utf8'))
    expect(statusFile.stage).toBe('done')

    // Second run: novelty state marks the same bytes as existing → no new OCR.
    const status2 = await runPipeline({
      stateDir,
      dryRun: true,
      fetch: fetchMock,
      ocrClient,
      now: () => new Date('2026-10-25T23:00:05Z'),
      log: () => {},
    })
    const entry2 = status2.stores['superindo']!
    expect(entry2.newImages).toBe(0)
    expect(entry2.existingImages).toBeGreaterThanOrEqual(1)
    expect(entry2.itemsExtracted).toBe(0)

    // State file persisted the processed hashes.
    const stateJson = JSON.parse(
      await readFile(path.join(stateDir, 'superindo', 'state.json'), 'utf8')
    )
    expect(stateJson.processed.length).toBeGreaterThanOrEqual(1)
    expect(stateJson.processed[0]!.md5).toBe(md5Hash(jpeg))

    // Run items file: one JSON line per OCR'd image.
    const runItems = await readFile(
      path.join(stateDir, 'superindo', 'run-2026-10-24T23-00-05-000Z.jsonl'),
      'utf8'
    )
    const lines = runItems
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines).toHaveLength(entry.itemsExtracted > 0 ? stateJson.processed.length : 0)
    expect(lines[0]!.storeSlug).toBe('superindo')
    expect(lines[0]!.products[0]!.name).toBe('Gula Pasir')
  })

  it('checkpoints novelty state per image when the quota dies mid-run', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const katalogHtml = await readFile(
      path.join(__dirname, 'fixtures/superindo/katalog-super-hemat.html'),
      'utf8'
    )
    const koranHtml = await readFile(
      path.join(__dirname, 'fixtures/superindo/promo-koran.html'),
      'utf8'
    )
    // Two distinct brochure pages so the run has two NEW images.
    const jpegA = fakeJpegBytes()
    const jpegB = (() => {
      const bytes = fakeJpegBytes()
      bytes.fill(0xdd, 29)
      return bytes
    })()
    const seenUrls = new Map<string, Uint8Array<ArrayBuffer>>()
    const fetchMock = async (
      url: string,
      init?: RequestInit & { proxy?: string }
    ): Promise<Response> => {
      expect(init?.headers).toBeDefined()
      if (url.includes('katalog-super-hemat')) return new Response(katalogHtml, { status: 200 })
      if (url.includes('promo-koran')) return new Response(koranHtml, { status: 200 })
      // First distinct image URL → page A, second → page B, rest repeat.
      if (!seenUrls.has(url)) {
        seenUrls.set(url, seenUrls.size === 0 ? jpegA : jpegB)
      }
      return new Response(seenUrls.get(url)!, { status: 200 })
    }

    const items = [
      { name: 'Gula Pasir', brand: null, unit: '1 kg', price: 17000, promo: null, period: null },
    ]
    let ocrCalls = 0
    const ocrClient: GeminiClient = {
      models: {
        generateContent: async () => {
          ocrCalls++
          if (ocrCalls > 1) {
            throw new Error('429 Quota exceeded for quota metric GenerateRequests per day')
          }
          return { text: JSON.stringify(items) }
        },
      },
    }

    const now = () => new Date('2026-10-24T23:00:05Z')
    let failure: unknown
    try {
      await runPipeline({
        stateDir,
        dryRun: true,
        fetch: fetchMock,
        ocrClient,
        now,
        log: () => {},
      })
    } catch (error) {
      failure = error
    }

    // Quota kill → exit code 2.
    expect(String(failure)).toMatch(/Daily quota exhausted/)
    expect((failure as { exitCode?: number }).exitCode).toBe(2)
    expect(ocrCalls).toBe(2)

    // The first image's progress survived: its hash is in state.json and its
    // items are on disk, so the next run does not re-OCR (re-pay) it.
    const stateJson = JSON.parse(
      await readFile(path.join(stateDir, 'superindo', 'state.json'), 'utf8')
    )
    expect(stateJson.processed).toHaveLength(1)
    expect(stateJson.processed[0]!.md5).toBe(md5Hash(jpegA))

    const runItems = await readFile(
      path.join(stateDir, 'superindo', 'run-2026-10-24T23-00-05-000Z.jsonl'),
      'utf8'
    )
    const lines = runItems
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines).toHaveLength(1)
    expect(lines[0]!.products[0]!.name).toBe('Gula Pasir')
  })
})
