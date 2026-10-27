// Pipeline orchestration test — full scrape → novelty → OCR → publish flow
// with every IO boundary injected (fixture HTML, fake JPEG bytes, stub
// Gemini client, mocked publish). runPipeline is an Effect.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import { runPipeline } from '../src/pipeline.js'
import { exitError, fakeBrowserLauncher } from './helpers.js'
import type { GeminiClient } from '../src/ocr/gemini.js'
import type { EmbeddingClient } from '../src/match/embedding.js'
import { md5Hash } from '../src/fetch/state.js'
import type { IngestPayload, RunReport } from '@rumaq/contract'

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

const noSleep = async () => {}

// Lotte rides the Tier-2 ladder in every pipeline run now; by default its
// listing page yields no promo images so the Superindo scenarios stay
// focused.
const emptyLotte = fakeBrowserLauncher('<html><body></body></html>')

// Deterministic Gemini stubs — a dev machine with GEMINI_API_KEY in the
// environment must never make the test suite call the real API.
const stubEmbedClient: EmbeddingClient = {
  models: {
    embedContent: async () => ({ embeddings: [{ values: [1, 0] }] }),
  },
}
const stubVerifyClient: GeminiClient = {
  models: { generateContent: async () => ({ text: 'YES' }) },
}

function makeFetchMock(katalogHtml: string, koranHtml: string, jpeg: Uint8Array<ArrayBuffer>) {
  return async (url: string, init?: RequestInit & { proxy?: string }): Promise<Response> => {
    expect(init?.headers).toBeDefined()
    if (url.includes('katalog-super-hemat')) return new Response(katalogHtml, { status: 200 })
    if (url.includes('promo-koran')) return new Response(koranHtml, { status: 200 })
    return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })
  }
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
    const fetchMock = makeFetchMock(katalogHtml, koranHtml, jpeg)

    const inlineMimes: string[] = []
    const ocrClient: GeminiClient = {
      models: {
        generateContent: async (args) => {
          for (const part of args.contents[0]!.parts) {
            if (part.inlineData) inlineMimes.push(part.inlineData.mimeType)
          }
          return { text: JSON.stringify(ocrItems) }
        },
      },
    }

    const status = await Effect.runPromise(
      runPipeline({
        launcher: emptyLotte.launcher,
        embedClient: stubEmbedClient,
        verifyClient: stubVerifyClient,
        stateDir,
        dryRun: true,
        fetch: fetchMock,
        ocrClient,
        sleep: noSleep,
        now: () => new Date('2026-10-24T23:00:05Z'),
        log: () => {},
      })
    )

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

    // Second run: novelty state marks the same bytes as existing → no new OCR…
    const status2 = await Effect.runPromise(
      runPipeline({
        launcher: emptyLotte.launcher,
        embedClient: stubEmbedClient,
        verifyClient: stubVerifyClient,
        stateDir,
        dryRun: true,
        fetch: fetchMock,
        ocrClient,
        sleep: noSleep,
        now: () => new Date('2026-11-05T23:00:05Z'),
        log: () => {},
      })
    )
    const entry2 = status2.stores['superindo']!
    expect(entry2.newImages).toBe(0)
    expect(entry2.existingImages).toBeGreaterThanOrEqual(1)
    expect(entry2.itemsExtracted).toBe(0)

    // …but the dry-run never consumed the outbox, so run 2's payload still
    // replays run 1's extracted items (nothing stranded, nothing re-OCR'd).
    const payload2: IngestPayload = JSON.parse(
      await readFile(path.join(stateDir, 'payload-2026-11-05T23-00-05-000Z.json'), 'utf8')
    )
    expect(payload2.items.map((item) => item.productKey)).toContain('gula-pasir----1-kg')

    // Post-publish prune: the first run's image dir is 12 days old → removed
    // (plan §6 keeps images 7 days after the run that published them).
    expect(existsSync(path.join(stateDir, 'superindo', 'images', '20261024'))).toBe(false)

    // State file persisted the processed hashes (compacted to bare md5s).
    const stateJson = JSON.parse(
      await readFile(path.join(stateDir, 'superindo', 'state.json'), 'utf8')
    )
    expect(stateJson.processed.length).toBeGreaterThanOrEqual(1)
    expect(stateJson.processed[0]).toBe(md5Hash(jpeg))

    // Run items file: one JSON line per OCR'd image, stamped with the
    // extracting run's scrapedAt so a later replay keeps the observed date.
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
    expect(lines[0]!.scrapedAt).toBe('2026-10-24T23:00:05.000Z')

    // The mock serves image/jpeg — the inlineData declaration must match.
    expect(inlineMimes.length).toBeGreaterThanOrEqual(1)
    expect(inlineMimes.every((mime) => mime === 'image/jpeg')).toBe(true)
  })

  it('replays and retires the outbox across a failed then successful publish', async () => {
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
    const fetchMock = makeFetchMock(katalogHtml, koranHtml, jpeg)
    const ocrClient: GeminiClient = {
      models: { generateContent: async () => ({ text: JSON.stringify(ocrItems) }) },
    }

    // Run 1: OCR succeeds, the ingest POST always 500s → run fails, but the
    // extracted items are checkpointed in the outbox (and novelty state).
    const failingPublish = async () => new Response('boom', { status: 500 })
    const failure = await Effect.runPromiseExit(
      runPipeline({
        launcher: emptyLotte.launcher,
        embedClient: stubEmbedClient,
        verifyClient: stubVerifyClient,
        stateDir,
        dryRun: false,
        fetch: fetchMock,
        ocrClient,
        publishFetch: failingPublish,
        ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
        ingestSecret: 's3cret',
        sleep: noSleep,
        now: () => new Date('2026-10-24T23:00:05Z'),
        log: () => {},
      })
    )
    expect(failure._tag).toBe('Failure')
    const error = exitError(failure) as Error & { exitCode?: number }
    expect(error.message).toContain('HTTP 500')
    expect(error.exitCode).toBe(1)

    const runFiles = (await readdir(path.join(stateDir, 'superindo'))).filter((name) =>
      name.startsWith('run-')
    )
    expect(runFiles).toHaveLength(1)

    // Run 2: pages unchanged (zero new OCR), ingest succeeds — the POST body
    // replays run 1's stranded items, then the outbox is retired. The fake
    // also serves the run-report endpoint the live pipeline now posts to.
    const posted: IngestPayload[] = []
    const okPublish = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/internal/ingest/prices')) {
        posted.push(JSON.parse(init!.body as string))
        return new Response(
          JSON.stringify({ accepted: 1, productsCreated: 1, observationsUpserted: 1, skipped: 0 }),
          { status: 200 }
        )
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const status2 = await Effect.runPromise(
      runPipeline({
        launcher: emptyLotte.launcher,
        embedClient: stubEmbedClient,
        verifyClient: stubVerifyClient,
        stateDir,
        dryRun: false,
        fetch: fetchMock,
        ocrClient: ocrClient,
        publishFetch: okPublish,
        ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
        ingestSecret: 's3cret',
        sleep: noSleep,
        now: () => new Date('2026-10-25T23:00:05Z'),
        log: () => {},
      })
    )
    expect(status2.stage).toBe('done')
    expect(status2.stores['superindo']!.itemsExtracted).toBe(0) // no re-OCR
    expect(posted).toHaveLength(1)
    expect(posted[0]!.items.map((item) => item.productKey)).toContain('gula-pasir----1-kg')
    // Replay keeps the EXTRACTION day's observed date, not the replay day's —
    // the upsert conflict key includes observed_date, so day-2 dating would
    // insert duplicate observation rows.
    const replayed = posted[0]!.items.find((item) => item.productKey === 'gula-pasir----1-kg')!
    expect(replayed.observedDate).toBe('2026-10-24')

    // Outbox consumed only now.
    expect(
      (await readdir(path.join(stateDir, 'superindo'))).filter((name) => name.startsWith('run-'))
    ).toEqual([])
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
      return new Response(seenUrls.get(url)!, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
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
    const failure = await Effect.runPromiseExit(
      runPipeline({
        launcher: emptyLotte.launcher,
        embedClient: stubEmbedClient,
        verifyClient: stubVerifyClient,
        stateDir,
        dryRun: true,
        fetch: fetchMock,
        ocrClient,
        sleep: noSleep,
        now,
        log: () => {},
      })
    )

    // Quota kill → exit code 2.
    expect(failure._tag).toBe('Failure')
    const error = exitError(failure) as Error & { exitCode?: number }
    expect(error.message).toMatch(/Daily quota exhausted/)
    expect(error.exitCode).toBe(2)
    expect(ocrCalls).toBe(2)

    // The first image's progress survived: its hash is in state.json and its
    // items are on disk, so the next run does not re-OCR (re-pay) it.
    const stateJson = JSON.parse(
      await readFile(path.join(stateDir, 'superindo', 'state.json'), 'utf8')
    )
    expect(stateJson.processed).toHaveLength(1)
    expect(stateJson.processed[0]).toBe(md5Hash(jpegA))

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

  it("keeps a failed store's mid-run OCR in the outbox despite the successful publish", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const katalogHtml = await readFile(
      path.join(__dirname, 'fixtures/superindo/katalog-super-hemat.html'),
      'utf8'
    )
    const koranHtml = await readFile(
      path.join(__dirname, 'fixtures/superindo/promo-koran.html'),
      'utf8'
    )
    // Two distinct brochure pages so the run has two NEW images (identical
    // bytes would collapse into one through md5 novelty).
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
      if (!seenUrls.has(url)) {
        seenUrls.set(url, seenUrls.size === 0 ? jpegA : jpegB)
      }
      return new Response(seenUrls.get(url)!, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }

    const items = [
      { name: 'Gula Pasir', brand: null, unit: '1 kg', price: 17000, promo: null, period: null },
    ]
    // First image OCRs, every later attempt dies — the store fails mid-run
    // with its first image already checkpointed in the outbox.
    let ocrCalls = 0
    const flakyOcr: GeminiClient = {
      models: {
        generateContent: async () => {
          ocrCalls++
          if (ocrCalls > 1) throw new Error('ocr exploded')
          return { text: JSON.stringify(items) }
        },
      },
    }

    const posted: IngestPayload[] = []
    // The live pipeline also POSTs a run report through the same injectable
    // fetch — capture only price publishes so the outbox assertions below
    // count what they mean to count.
    const okPublish = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/internal/ingest/prices')) {
        posted.push(JSON.parse(init!.body as string))
      }
      return new Response(
        JSON.stringify({ accepted: 0, productsCreated: 0, observationsUpserted: 0, skipped: 0 }),
        { status: 200 }
      )
    }

    const failure = await Effect.runPromiseExit(
      runPipeline({
        launcher: emptyLotte.launcher,
        embedClient: stubEmbedClient,
        verifyClient: stubVerifyClient,
        stateDir,
        dryRun: false,
        fetch: fetchMock,
        ocrClient: flakyOcr,
        publishFetch: okPublish,
        ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
        ingestSecret: 's3cret',
        sleep: noSleep,
        now: () => new Date('2026-10-24T23:00:05Z'),
        log: () => {},
      })
    )

    expect(failure._tag).toBe('Failure')
    const error = exitError(failure) as Error & { exitCode?: number }
    expect(error.message).toContain('superindo')
    expect(error.exitCode).toBe(1)

    // The publish still went out — without the failed store's items…
    expect(posted).toHaveLength(1)
    expect(posted[0]!.items.map((item) => item.productKey)).not.toContain('gula-pasir----1-kg')

    // …but its outbox was NOT retired: the image OCR'd before the failure
    // must replay next run (the ingest upsert makes the replay idempotent).
    const runFiles = (await readdir(path.join(stateDir, 'superindo'))).filter((name) =>
      name.startsWith('run-')
    )
    expect(runFiles).toHaveLength(1)
    const survivors = (await readFile(path.join(stateDir, 'superindo', runFiles[0]!), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(survivors).toHaveLength(1)
    expect(survivors[0]!.products[0]!.name).toBe('Gula Pasir')

    // Next run (same pages, healthy OCR): the stranded image replays without
    // re-OCR, the publish covers it, and only then does its file retire.
    const healthyOcr: GeminiClient = {
      models: { generateContent: async () => ({ text: JSON.stringify(items) }) },
    }
    await Effect.runPromise(
      runPipeline({
        launcher: emptyLotte.launcher,
        embedClient: stubEmbedClient,
        verifyClient: stubVerifyClient,
        stateDir,
        dryRun: false,
        fetch: fetchMock,
        ocrClient: healthyOcr,
        publishFetch: okPublish,
        ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
        ingestSecret: 's3cret',
        sleep: noSleep,
        now: () => new Date('2026-10-25T23:00:05Z'),
        log: () => {},
      })
    )
    expect(posted).toHaveLength(2)
    expect(posted[1]!.items.map((item) => item.productKey)).toContain('gula-pasir----1-kg')
    expect(
      (await readdir(path.join(stateDir, 'superindo'))).filter((name) => name.startsWith('run-'))
    ).toEqual([])
  })

  it('re-OCRs an image whose outbox append failed — items are never stranded', async () => {
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
    const fetchMock = makeFetchMock(katalogHtml, koranHtml, jpeg)
    const now = () => new Date('2026-10-24T23:00:05Z')
    // The outbox append target already exists as a READ-ONLY file: the
    // replay's readFile of it succeeds (empty), but appendFile after the OCR
    // fails with EACCES — the exact post-OCR crash window the
    // append-before-checkpoint ordering guards.
    const runItemsFile = path.join(stateDir, 'superindo', 'run-2026-10-24T23-00-05-000Z.jsonl')
    await mkdir(path.dirname(runItemsFile), { recursive: true })
    await writeFile(runItemsFile, '', { mode: 0o444 })

    let ocrCalls = 0
    const ocrClient: GeminiClient = {
      models: {
        generateContent: async () => {
          ocrCalls++
          return {
            text: JSON.stringify([
              {
                name: 'Gula Pasir',
                brand: null,
                unit: '1 kg',
                price: 17000,
                promo: null,
                period: null,
              },
            ]),
          }
        },
      },
    }

    const failure = await Effect.runPromiseExit(
      runPipeline({
        launcher: emptyLotte.launcher,
        embedClient: stubEmbedClient,
        verifyClient: stubVerifyClient,
        stateDir,
        dryRun: true,
        fetch: fetchMock,
        ocrClient,
        sleep: noSleep,
        now,
        log: () => {},
      })
    )
    expect(failure._tag).toBe('Failure')
    const error = exitError(failure) as Error & { exitCode?: number }
    expect(error.message).toContain('append')
    expect(error.exitCode).toBe(1)

    // The novelty checkpoint comes AFTER the outbox append, so the image's
    // md5 never entered state.json — nothing was marked processed.
    expect(existsSync(path.join(stateDir, 'superindo', 'state.json'))).toBe(false)

    // Next run, with the append working again: the image is re-OCR'd
    // (at-least-once — a duplicate outbox line dedupes in the upsert), not
    // skipped as already-processed with its items stranded.
    await rm(runItemsFile, { force: true })
    const status2 = await Effect.runPromise(
      runPipeline({
        launcher: emptyLotte.launcher,
        embedClient: stubEmbedClient,
        verifyClient: stubVerifyClient,
        stateDir,
        dryRun: true,
        fetch: fetchMock,
        ocrClient,
        sleep: noSleep,
        now,
        log: () => {},
      })
    )
    expect(status2.stores['superindo']!.newImages).toBeGreaterThanOrEqual(1)
    expect(ocrCalls).toBe(2) // paid for twice, stranded never
    const runItems = await readFile(runItemsFile, 'utf8')
    expect(runItems).toContain('Gula Pasir')
  })

  it('completes a dry-run with zero new images and no GEMINI_API_KEY', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const fetchMock = async (
      url: string,
      init?: RequestInit & { proxy?: string }
    ): Promise<Response> => {
      expect(init?.headers).toBeDefined()
      // Neither listing page has a matching gallery → zero pages, zero OCR.
      return new Response('<html><body>No promos here</body></html>', { status: 200 })
    }
    const previous = process.env.GEMINI_API_KEY
    delete process.env.GEMINI_API_KEY
    try {
      const status = await Effect.runPromise(
        runPipeline({
          launcher: emptyLotte.launcher,
          embedClient: stubEmbedClient,
          verifyClient: stubVerifyClient,
          stateDir,
          dryRun: true,
          fetch: fetchMock,
          sleep: noSleep,
          now: () => new Date('2026-10-24T23:00:05Z'),
          log: () => {},
        })
      )
      expect(status.stage).toBe('done')
      const entry = status.stores['superindo']!
      expect(entry.pagesFound).toBe(0)
      expect(entry.newImages).toBe(0)
      expect(entry.itemsExtracted).toBe(0)
    } finally {
      if (previous !== undefined) process.env.GEMINI_API_KEY = previous
    }
  })

  it('writes status.json even when the run fails', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const failingFetch = async () => new Response('nope', { status: 500 })
    await Effect.runPromiseExit(
      runPipeline({
        launcher: emptyLotte.launcher,
        embedClient: stubEmbedClient,
        verifyClient: stubVerifyClient,
        stateDir,
        dryRun: true,
        fetch: failingFetch,
        sleep: noSleep,
        now: () => new Date('2026-10-24T23:00:05Z'),
        log: () => {},
      })
    )
    const statusFile = JSON.parse(await readFile(path.join(stateDir, 'status.json'), 'utf8'))
    // Superindo's listing fetch 500s — the store is recorded failed (per-store
    // isolation), the run still walked publish before failing at the end.
    expect(statusFile.stage).toBe('publish')
    expect(statusFile.stores['superindo'].pagesFound).toBe(0)
    expect(statusFile.stores['superindo'].error).toContain('HTTP 500')
    expect(statusFile.stores['lotte-mart'].error).toBeUndefined()
  })

  it('reports a failed live run to the backend (§7.1)', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const reported: RunReport[] = []
    const failingFetch = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/internal/ingest/runs')) {
        reported.push(JSON.parse(init!.body as string))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response('nope', { status: 500 })
    }
    await Effect.runPromiseExit(
      runPipeline({
        launcher: emptyLotte.launcher,
        embedClient: stubEmbedClient,
        verifyClient: stubVerifyClient,
        stateDir,
        dryRun: false,
        fetch: failingFetch,
        publishFetch: failingFetch,
        ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
        ingestSecret: 's3cret',
        sleep: noSleep,
        now: () => new Date('2026-10-24T23:00:05Z'),
        log: () => {},
      })
    )
    expect(reported).toHaveLength(1)
    expect(reported[0]!.status).toBe('failed')
    expect(reported[0]!.exitCode).toBe(1)
    expect(reported[0]!.stage).toBe('publish')
    expect(reported[0]!.error).toContain('HTTP 500')
    expect(reported[0]!.perStore['superindo']!.error).toContain('HTTP 500')
  })

  it("isolates stores — one store failing never blocks the other stores' publish", async () => {
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
    const fetchMock = makeFetchMock(katalogHtml, koranHtml, jpeg)
    const ocrClient: GeminiClient = {
      models: { generateContent: async () => ({ text: JSON.stringify(ocrItems) }) },
    }
    // Lotte is served a persistent Incapsula challenge on the browser tier —
    // a fatal BrowserTierRequired for that store alone.
    const challengedLotte = fakeBrowserLauncher(
      '<html><script src="/_Incapsula_Resource?SWHDLEDF"></script></html>'
    )

    const failure = await Effect.runPromiseExit(
      runPipeline({
        launcher: challengedLotte.launcher,
        embedClient: stubEmbedClient,
        verifyClient: stubVerifyClient,
        stateDir,
        dryRun: true,
        fetch: fetchMock,
        ocrClient,
        sleep: noSleep,
        now: () => new Date('2026-10-24T23:00:05Z'),
        log: () => {},
      })
    )

    // Superindo's snapshot still published (dry-run payload written with its
    // items) even though lotte's store run died…
    const payload: IngestPayload = JSON.parse(
      await readFile(path.join(stateDir, 'payload-2026-10-24T23-00-05-000Z.json'), 'utf8')
    )
    expect(payload.items.map((item) => item.productKey)).toContain('gula-pasir----1-kg')

    // …and the run itself fails non-zero AFTER publishing, naming the store.
    expect(failure._tag).toBe('Failure')
    const error = exitError(failure) as Error & { exitCode?: number }
    expect(error.message).toContain('lotte-mart')
    expect(error.message).toContain('BrowserTierRequired')
    expect(error.exitCode).toBe(1)
    expect(challengedLotte.state.closed).toBe(true)
  })
})

it('runs the lotte flow through the Tier-2 browser ladder and cross-matches with superindo', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
  const katalogHtml = await readFile(
    path.join(__dirname, 'fixtures/superindo/katalog-super-hemat.html'),
    'utf8'
  )
  const koranHtml = await readFile(
    path.join(__dirname, 'fixtures/superindo/promo-koran.html'),
    'utf8'
  )
  // The page was saved from a browser, so asset srcs point at the local
  // save folder — rewrite them to the site-absolute form the live page
  // serves before parsing.
  const lotteHtml = (
    await readFile(path.join(__dirname, 'fixtures/lotte/all-promo-mart.html'), 'utf8')
  ).replaceAll('./All Promo Mart_files/', 'https://www.lottemart.co.id/assets/')
  const jpeg = fakeJpegBytes()
  // The listing pages come from their own tiers (superindo plain, lotte
  // browser); every image URL — either store's — serves the same fake
  // JPEG, so both stores OCR the same item and the catalog matcher joins
  // them onto one canonical product.
  const fetchMock = async (
    url: string,
    init?: RequestInit & { proxy?: string }
  ): Promise<Response> => {
    expect(init?.headers).toBeDefined()
    if (url.includes('katalog-super-hemat')) return new Response(katalogHtml, { status: 200 })
    if (url.includes('promo-koran')) return new Response(koranHtml, { status: 200 })
    return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })
  }
  const lotteBrowser = fakeBrowserLauncher(lotteHtml)
  const ocrClient: GeminiClient = {
    models: { generateContent: async () => ({ text: JSON.stringify(ocrItems) }) },
  }

  const status = await Effect.runPromise(
    runPipeline({
      stateDir,
      dryRun: true,
      launcher: lotteBrowser.launcher,
      embedClient: stubEmbedClient,
      verifyClient: stubVerifyClient,
      fetch: fetchMock,
      ocrClient,
      sleep: noSleep,
      now: () => new Date('2026-10-24T23:00:05Z'),
      log: () => {},
    })
  )

  expect(status.stage).toBe('done')
  const lotte = status.stores['lotte-mart']!
  expect(lotte.pagesFound).toBeGreaterThan(0)
  expect(lotte.itemsExtracted).toBeGreaterThanOrEqual(1)
  expect(lotteBrowser.state.pages).toBe(1) // one listing page per run
  expect(lotteBrowser.state.closed).toBe(true) // session released at store end

  // The catalog matcher joined both stores' "Gula Pasir 1 kg" onto one
  // canonical product: one catalog entry, two stores, second sighting
  // matched exact (the ★ PR3 redesign — plan §6).
  const catalog = JSON.parse(await readFile(path.join(stateDir, 'catalog.json'), 'utf8'))
  const entries = Object.values(catalog.entries) as {
    storesFound: string[]
    appearanceCount: number
  }[]
  const gula = entries.find((e) => e.storesFound.length === 2)
  expect(gula).toBeDefined()
  expect(gula!.storesFound).toEqual(['superindo', 'lotte-mart'])
  expect(gula!.appearanceCount).toBe(2)
  expect(status.match).toMatchObject({ exact: 1, solo: 1 })

  const payload: IngestPayload = JSON.parse(
    await readFile(path.join(stateDir, 'payload-2026-10-24T23-00-05-000Z.json'), 'utf8')
  )
  const gulaItems = payload.items.filter((item) => item.name === 'Gula Pasir')
  expect(gulaItems).toHaveLength(2)
  expect(new Set(gulaItems.map((item) => item.productKey)).size).toBe(1)
  expect(gulaItems.map((item) => item.matchMethod).sort()).toEqual(['exact', 'solo'])
})
