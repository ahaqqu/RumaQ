// Pipeline orchestration test — full scrape → novelty → OCR → publish flow
// with every IO boundary injected (fixture HTML, fake JPEG bytes, stub
// Gemini client, mocked publish). runPipeline is an Effect. The per-store
// E2E stories (indomaret, alfamart) live in test/pipeline/*.e2e.test.ts
// (review B1); the stubs they share with this file live in
// test/pipeline/stubs.ts.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import { runPipeline, type PipelineOptions } from '../src/pipeline.js'
import { exitError, fakeBrowserLauncher } from './helpers.js'
import type { GeminiClient } from '../src/ocr/gemini.js'
import type { EmbeddingClient } from '../src/match/embedding.js'
import { md5Hash } from '../src/fetch/state.js'
import type { IngestPayload, RunReport } from '@rumaq/contract'
import {
  emptyLotte,
  makeReportCapture,
  noSleep,
  ocrItems,
  serveIndomaret,
  silentIndomaretRender,
  stubEmbedClient,
  stubVerifyClient,
} from './pipeline/stubs.js'

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

function makeFetchMock(katalogHtml: string, koranHtml: string, jpeg: Uint8Array<ArrayBuffer>) {
  return async (url: string, init?: RequestInit & { proxy?: string }): Promise<Response> => {
    expect(init?.headers).toBeDefined()
    if (url.includes('katalog-super-hemat')) return new Response(katalogHtml, { status: 200 })
    if (url.includes('promo-koran')) return new Response(koranHtml, { status: 200 })
    // Astro category pages: empty page → the catalog store contributes no
    // items unless a scenario serves the astro fixture explicitly.
    if (url.includes('astronauts.id')) {
      return new Response('<html><body></body></html>', { status: 200 })
    }
    return serveIndomaret(
      url,
      () => new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })
    )!
  }
}

/**
 * Base options for the scoped scenarios (review B2): one factory owning the
 * boilerplate the runPipeline call sites used to copy — the alfamart
 * sentinel makes an empty listing red, so every non-alfamart scenario
 * scopes `stores` and rides the silent indomaret chain through its fetch
 * mock. The scope stays an explicit argument (it is the scenario's own
 * semantic); everything else defaults here and is overridable via
 * `overrides`. Whichever fetch wins (the empty-page default or an override)
 * is wrapped with the serveIndomaret branches, so a scenario can no longer
 * forget the chain — wrapping an already-wrapped mock is harmless.
 */
function scopedOptions(
  stateDir: string,
  stores: string[],
  overrides: Partial<PipelineOptions> = {}
): PipelineOptions {
  const base: PipelineOptions = {
    launcher: emptyLotte.launcher,
    embedClient: stubEmbedClient,
    verifyClient: stubVerifyClient,
    stateDir,
    stores,
    dryRun: true,
    renderPdf: silentIndomaretRender,
    sleep: noSleep,
    now: () => new Date('2026-10-24T23:00:05Z'),
    log: () => {},
    ...overrides,
  }
  // Whichever fetch wins (the empty-page default or an override) is wrapped
  // with the serveIndomaret branches, so a scenario can no longer forget
  // the chain — wrapping an already-wrapped mock is harmless.
  const inner =
    base.fetch ?? (async () => new Response('<html><body></body></html>', { status: 200 }))
  base.fetch = (url, init) => Promise.resolve(serveIndomaret(url, () => inner(url, init)))
  return base
}

/**
 * Scrub the model-chain env vars so a scenario always rides the shipped
 * 5-rung default regardless of the ambient shell (the config is read per
 * runPipeline call). Returns the restore function — call it in `finally`.
 */
function scrubChainEnv(): () => void {
  const names = [
    'GEMINI_MODEL',
    'GEMINI_MODEL_CHAIN',
    'GEMINI_VERIFIER_MODEL',
    'GEMINI_VERIFIER_MODEL_CHAIN',
  ]
  const previous = names.map((name) => process.env[name])
  for (const name of names) delete process.env[name]
  return () => {
    names.forEach((name, i) => {
      if (previous[i] !== undefined) process.env[name] = previous[i]!
      else delete process.env[name]
    })
  }
}

// Shared arrange for the by-design needs-proxy scenarios: Lotte's browser
// tier is served a persistent Incapsula challenge, and LOTTE_PROXY_URL is
// guarded so every scenario restores the environment it started with.
async function setupChallengedLotte() {
  const katalogHtml = await readFile(
    path.join(__dirname, 'fixtures/superindo/katalog-super-hemat.html'),
    'utf8'
  )
  const koranHtml = await readFile(
    path.join(__dirname, 'fixtures/superindo/promo-koran.html'),
    'utf8'
  )
  const challengedLotte = fakeBrowserLauncher(
    '<html><script src="/_Incapsula_Resource?SWHDLEDF"></script></html>'
  )
  const ocrClient: GeminiClient = {
    models: { generateContent: async () => ({ text: JSON.stringify(ocrItems) }) },
  }
  const previousProxy = process.env.LOTTE_PROXY_URL
  return {
    setProxy(value: string | undefined) {
      if (value === undefined) delete process.env.LOTTE_PROXY_URL
      else process.env.LOTTE_PROXY_URL = value
    },
    restoreProxy() {
      if (previousProxy !== undefined) process.env.LOTTE_PROXY_URL = previousProxy
      else delete process.env.LOTTE_PROXY_URL
    },
    options(
      stateDir: string,
      overrides: Partial<PipelineOptions> & Pick<PipelineOptions, 'dryRun'>
    ): PipelineOptions {
      return scopedOptions(stateDir, ['lotte-mart', 'superindo'], {
        launcher: challengedLotte.launcher,
        fetch: makeFetchMock(katalogHtml, koranHtml, fakeJpegBytes()),
        ocrClient,
        ...overrides,
      })
    },
    browserClosed: () => challengedLotte.state.closed,
  }
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
      runPipeline(
        scopedOptions(stateDir, ['superindo'], {
          dryRun: true,
          fetch: fetchMock,
          ocrClient,
        })
      )
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
      runPipeline(
        scopedOptions(stateDir, ['superindo'], {
          dryRun: true,
          fetch: fetchMock,
          ocrClient,
          now: () => new Date('2026-11-05T23:00:05Z'),
        })
      )
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
    // Brochure PUTs succeed (issue #293) so the failure is the ingest POST's.
    const failingPublish = async (url: string, _init?: RequestInit) => {
      if (url.includes('/api/internal/brochures/')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response('boom', { status: 500 })
    }
    const failure = await Effect.runPromiseExit(
      runPipeline(
        scopedOptions(stateDir, ['superindo'], {
          dryRun: false,
          fetch: fetchMock,
          ocrClient,
          publishFetch: failingPublish,
          ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
          ingestSecret: 's3cret',
        })
      )
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
      runPipeline(
        scopedOptions(stateDir, ['superindo'], {
          dryRun: false,
          fetch: fetchMock,
          ocrClient: ocrClient,
          publishFetch: okPublish,
          ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
          ingestSecret: 's3cret',
          now: () => new Date('2026-10-25T23:00:05Z'),
        })
      )
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

  it('walks the whole model chain on daily quota, then isolates the store and still publishes (issue #347)', async () => {
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
      // scopedOptions wraps the indomaret branches around this mock.
      return new Response(seenUrls.get(url)!, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }

    const items = [
      { name: 'Gula Pasir', brand: null, unit: '1 kg', price: 17000, promo: null, period: null },
    ]
    let ocrCalls = 0
    // Every rung dies of daily quota — the whole chain walks (one call per
    // rung; quota errors never retry), then the store isolates.
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
    const logs: string[] = []
    const restoreEnv = scrubChainEnv()
    try {
      const failure = await Effect.runPromiseExit(
        runPipeline(
          scopedOptions(stateDir, ['superindo'], {
            dryRun: true,
            fetch: fetchMock,
            ocrClient,
            now,
            log: (message) => logs.push(message),
          })
        )
      )

      // Whole-chain quota death is a PER-STORE failure now (design C1): exit 1
      // with the enumerated ChainExhaustedError — not the old run-aborting
      // exit 2, which is unreachable from OCR once the chain exists.
      expect(failure._tag).toBe('Failure')
      const error = exitError(failure) as Error & { exitCode?: number }
      expect(error.message).toContain('superindo')
      expect(error.message).toMatch(/all 5 chain rungs exhausted/)
      expect(error.message).toMatch(/gemini-3\.8-flash \(daily-quota 429\)/)
      expect(error.exitCode).toBe(1)
      // 1 success (image A) + 5 dead-rung detection calls for image B.
      expect(ocrCalls).toBe(6)
      expect(logs.filter((line) => line.includes('rung advanced'))).toHaveLength(4)

      // The run CONTINUED past the dead store: the first image's progress
      // survived (its hash is in state.json, its items on disk)…
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

      // …the run CONTINUED to publish: the dry-run payload went out after
      // the dead store — without its items (they ride its outbox file for
      // the next run's replay, as with any failed store).
      const payload = JSON.parse(
        await readFile(path.join(stateDir, 'payload-2026-10-24T23-00-05-000Z.json'), 'utf8')
      )
      expect(payload.items).toEqual([])

      // …and the store entry carries the audit trail: only rung 0 ever
      // succeeded here; the failure path is where the other rungs died.
      const statusFile = JSON.parse(await readFile(path.join(stateDir, 'status.json'), 'utf8'))
      expect(statusFile.stores['superindo'].modelsUsed).toEqual(['gemini-3.8-flash'])
    } finally {
      restoreEnv()
    }
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
      return serveIndomaret(
        url,
        () =>
          new Response(seenUrls.get(url)!, {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          })
      )!
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
      runPipeline(
        scopedOptions(stateDir, ['superindo'], {
          dryRun: false,
          fetch: fetchMock,
          ocrClient: flakyOcr,
          publishFetch: okPublish,
          ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
          ingestSecret: 's3cret',
        })
      )
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
      runPipeline(
        scopedOptions(stateDir, ['superindo'], {
          dryRun: false,
          fetch: fetchMock,
          ocrClient: healthyOcr,
          publishFetch: okPublish,
          ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
          ingestSecret: 's3cret',
          now: () => new Date('2026-10-25T23:00:05Z'),
        })
      )
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
      runPipeline(
        scopedOptions(stateDir, ['superindo'], { dryRun: true, fetch: fetchMock, ocrClient, now })
      )
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
      runPipeline(
        scopedOptions(stateDir, ['superindo'], { dryRun: true, fetch: fetchMock, ocrClient, now })
      )
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
      // (scopedOptions wraps the indomaret branches around this mock.)
      return new Response('<html><body>No promos here</body></html>', { status: 200 })
    }
    const previous = process.env.GEMINI_API_KEY
    delete process.env.GEMINI_API_KEY
    try {
      const status = await Effect.runPromise(
        runPipeline(scopedOptions(stateDir, ['superindo'], { dryRun: true, fetch: fetchMock }))
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

  it('reports a needs-proxy skip as a successful run with the store marker (§7.1)', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const harness = await setupChallengedLotte()
    const { reported, publishFetch } = makeReportCapture()
    harness.setProxy(undefined)
    try {
      const status = await Effect.runPromise(
        runPipeline(
          harness.options(stateDir, {
            dryRun: false,
            publishFetch,
            ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
            ingestSecret: 's3cret',
          })
        )
      )
      expect(status.stage).toBe('done')

      // The monitor feed sees a green run whose Lotte row carries the marker.
      expect(reported).toHaveLength(1)
      expect(reported[0]!.status).toBe('success')
      expect(reported[0]!.exitCode).toBe(0)
      expect(reported[0]!.error).toBeNull()
      expect(reported[0]!.perStore['lotte-mart']!.needsProxy).toBe(true)
      expect(reported[0]!.perStore['lotte-mart']!.error).toContain('LOTTE_PROXY_URL')
      expect(reported[0]!.perStore['superindo']!.error).toBeUndefined()
    } finally {
      harness.restoreProxy()
    }
  })

  it('caps the review pairs on the run report at 200 with the truncation visible (issue #294)', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const { reported, publishFetch } = makeReportCapture()
    // Enough unique ambiguous names that a single image's sweep holds more
    // than 200 pairs: the first item founds the entry, the rest hold against
    // it (its name carries the same tokens, so gate 2 passes).
    const manyItems = [
      { name: 'Indomie Goreng', brand: null, unit: '1 kg', price: 3500, promo: null, period: null },
      ...Array.from({ length: 210 }, (_, i) => ({
        name: `Indomie Goreng Kuah ${i + 1}`,
        brand: null,
        unit: '1 kg',
        price: 3500,
        promo: null,
        period: null,
      })),
    ]
    const ocrClient: GeminiClient = {
      models: { generateContent: async () => ({ text: JSON.stringify(manyItems) }) },
    }
    // [1,1] for the held names vs [1,0] for the founded entry: cos ≈ 0.707 —
    // the ambiguous band, so every pair rides the verifier.
    const bandEmbedClient: EmbeddingClient = {
      models: {
        embedContent: async ({ contents }: { contents: string[] }) => ({
          embeddings: contents.map((name) => ({
            values: name.startsWith('Indomie Goreng Kuah') ? [1, 1] : [1, 0],
          })),
        }),
      },
    }
    // An unparseable verdict resolves every held pair to null — each stays
    // matched and emits one verifier_unresolved record.
    const maybeVerifier: GeminiClient = {
      models: { generateContent: async () => ({ text: 'MAYBE' }) },
    }
    const katalogHtml = await readFile(
      path.join(__dirname, 'fixtures/superindo/katalog-super-hemat.html'),
      'utf8'
    )
    const koranHtml = await readFile(
      path.join(__dirname, 'fixtures/superindo/promo-koran.html'),
      'utf8'
    )
    const status = await Effect.runPromise(
      runPipeline(
        scopedOptions(stateDir, ['superindo'], {
          dryRun: false,
          embedClient: bandEmbedClient,
          verifyClient: maybeVerifier,
          fetch: makeFetchMock(katalogHtml, koranHtml, fakeJpegBytes()),
          ocrClient,
          publishFetch,
          ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
          ingestSecret: 's3cret',
        })
      )
    )
    expect(status.stage).toBe('done')
    expect(status.reviewItems!.length).toBe(status.match!.reviewItems)
    expect(status.match!.reviewItems).toBeGreaterThan(200)

    const report = reported[0]!
    // The monitor count is the pre-slice total; the payload carries the cap
    // and says so.
    expect(report.match!.reviewItems).toBe(status.match!.reviewItems)
    expect(report.match!.reviewItemPairs).toHaveLength(200)
    expect(report.match!.reviewItemsTotal).toBe(report.match!.reviewItems)
    expect(report.match!.reviewItemsTruncated).toBe(true)
    for (const pair of report.match!.reviewItemPairs!) {
      expect(pair.reason).toBe('verifier_unresolved')
      expect(pair.matchMethod).toBe('ai')
    }
  })

  it('skips a challenged browser store by design when no proxy is configured', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const harness = await setupChallengedLotte()
    harness.setProxy(undefined)
    try {
      const status = await Effect.runPromise(
        runPipeline(harness.options(stateDir, { dryRun: true }))
      )

      // The run completes — Lotte's expected skip must not redden it.
      expect(status.stage).toBe('done')
      const lotte = status.stores['lotte-mart']!
      expect(lotte.needsProxy).toBe(true)
      expect(lotte.error).toContain('LOTTE_PROXY_URL')

      // Superindo's snapshot still published (dry-run payload with its items).
      const payload: IngestPayload = JSON.parse(
        await readFile(path.join(stateDir, 'payload-2026-10-24T23-00-05-000Z.json'), 'utf8')
      )
      expect(payload.items.map((item) => item.productKey)).toContain('gula-pasir----1-kg')

      // status.json carries the marker for box-side inspection.
      const statusFile = JSON.parse(await readFile(path.join(stateDir, 'status.json'), 'utf8'))
      expect(statusFile.stores['lotte-mart'].needsProxy).toBe(true)
      expect(harness.browserClosed()).toBe(true)
    } finally {
      harness.restoreProxy()
    }
  })

  it("isolates stores — one store failing never blocks the other stores' publish", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const harness = await setupChallengedLotte()
    // With the Tier-3 proxy configured, a persisting challenge is a real
    // failure again — a fatal BrowserTierRequired for that store alone.
    harness.setProxy('http://residential-proxy.example:8080')
    try {
      const failure = await Effect.runPromiseExit(
        runPipeline(harness.options(stateDir, { dryRun: true }))
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
      expect(harness.browserClosed()).toBe(true)
    } finally {
      harness.restoreProxy()
    }
  })

  it("retires a needs-proxy skipped store's pre-run outbox with the publish", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const harness = await setupChallengedLotte()
    const { reported, posted, publishFetch } = makeReportCapture()
    // A previous run OCR'd one Lotte image but never published — its batch
    // waits in the outbox for this run's replay.
    const lotteDir = path.join(stateDir, 'lotte-mart')
    await mkdir(lotteDir, { recursive: true })
    await writeFile(
      path.join(lotteDir, 'run-2026-10-23T23-00-05-000Z.jsonl'),
      JSON.stringify({
        storeSlug: 'lotte-mart',
        brochureUrl: 'https://www.lottemart.co.id/promosi/2026-10-23',
        products: [
          {
            name: 'Susu UHT Cokelat',
            brand: null,
            unit: '1 L',
            price: 19000,
            promo: null,
            period: null,
            ocrRawPrice: '19000',
            imageSource: 'promo-2026-10-23-1.jpg',
          },
        ],
        scrapedAt: '2026-10-23T23:00:05Z',
      }) + '\n',
      'utf8'
    )
    harness.setProxy(undefined)
    try {
      const status = await Effect.runPromise(
        runPipeline(
          harness.options(stateDir, {
            dryRun: false,
            publishFetch,
            ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
            ingestSecret: 's3cret',
          })
        )
      )
      // The skip is marked and the run stays green…
      expect(status.stage).toBe('done')
      expect(status.stores['lotte-mart']!.needsProxy).toBe(true)
      expect(reported[0]!.status).toBe('success')
      // …the pre-run batch rode this publish…
      expect(posted).toHaveLength(1)
      expect(posted[0]!.items.map((item) => item.storeSlug)).toContain('lotte-mart')
      // …and the outbox retired like a healthy store's.
      expect((await readdir(lotteDir)).filter((name) => name.startsWith('run-'))).toEqual([])
    } finally {
      harness.restoreProxy()
    }
  })

  it('keeps rung state across stores — the quota is key-scoped, not per-store (issue #347)', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const katalogHtml = await readFile(
      path.join(__dirname, 'fixtures/superindo/katalog-super-hemat.html'),
      'utf8'
    )
    const koranHtml = await readFile(
      path.join(__dirname, 'fixtures/superindo/promo-koran.html'),
      'utf8'
    )
    // Two brochure stores (config order: superindo first, hypermart second).
    // Hypermart's hub serves its own JAWA-* carousel shape — the superindo
    // fixture carries no hypermart-shaped images, so it needs its own HTML.
    const hypermartHub =
      '<html><body>' +
      '<a href="https://www.hypermart.co.id/wp-content/uploads/2026/10/JAWA-1.jpg"></a>' +
      '</body></html>'
    const jpeg = fakeJpegBytes()
    const fetchMock = async (url: string): Promise<Response> => {
      if (url.includes('katalog-super-hemat')) return new Response(katalogHtml, { status: 200 })
      if (url.includes('superindo.co.id') && url.includes('promo-koran')) {
        return new Response(koranHtml, { status: 200 })
      }
      if (url.includes('hypermart.co.id/promo-koran')) {
        return new Response(hypermartHub, { status: 200 })
      }
      // Every image URL (either store) serves the same fake JPEG.
      return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })
    }
    // Rung 0 is quota-dead for the WHOLE run; every later rung works. The
    // identical bytes collapse to one new image per store, so the call
    // sequence is fully deterministic: superindo pays the detection call,
    // advances, OCRs on rung 1; hypermart starts straight on rung 1.
    const calls: { model: string }[] = []
    const ocrClient: GeminiClient = {
      models: {
        generateContent: async (args) => {
          calls.push({ model: args.model })
          if (args.model === 'gemini-3.8-flash') {
            throw new Error('429 Quota exceeded for quota metric GenerateRequests per day')
          }
          return { text: JSON.stringify(ocrItems) }
        },
      },
    }
    const logs: string[] = []
    const restoreEnv = scrubChainEnv()
    try {
      const status = await Effect.runPromise(
        runPipeline(
          scopedOptions(stateDir, ['superindo', 'hypermart'], {
            dryRun: true,
            fetch: fetchMock,
            ocrClient,
            log: (message) => logs.push(message),
          })
        )
      )

      // Store 1 paid the detection call and advanced before its first item…
      expect(calls[0]).toEqual({ model: 'gemini-3.8-flash' })
      expect(calls[1]).toEqual({ model: 'gemini-3.7-flash' })
      // …store 2's first (and only) OCR call already carries rung 1 — the
      // per-run state must NOT reset between stores. Rung 0 is attempted
      // exactly once in the entire run: store 2 never re-detects it.
      expect(calls).toEqual([
        { model: 'gemini-3.8-flash' },
        { model: 'gemini-3.7-flash' },
        { model: 'gemini-3.7-flash' },
      ])

      // Exactly ONE advance line for the whole run.
      expect(logs.filter((line) => line.includes('[chain] ocr rung advanced'))).toHaveLength(1)

      // Exit 0 and both stores publish; the audit trail shows each store on
      // rung 1 (superindo's rung-0 call failed, so it is not "used").
      expect(status.stage).toBe('done')
      expect(status.stores['superindo']!.modelsUsed).toEqual(['gemini-3.7-flash'])
      expect(status.stores['hypermart']!.modelsUsed).toEqual(['gemini-3.7-flash'])
      const payload: IngestPayload = JSON.parse(
        await readFile(path.join(stateDir, 'payload-2026-10-24T23-00-05-000Z.json'), 'utf8')
      )
      expect(payload.items.map((item) => item.storeSlug)).toContain('superindo')
      expect(payload.items.map((item) => item.storeSlug)).toContain('hypermart')
    } finally {
      restoreEnv()
    }
  })

  it('a rung-0-only daily 429 advances and the run stays green with the audit trail (issue #347)', async () => {
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
    const fetchMock = async (url: string): Promise<Response> => {
      if (url.includes('katalog-super-hemat')) return new Response(katalogHtml, { status: 200 })
      if (url.includes('promo-koran')) return new Response(koranHtml, { status: 200 })
      if (!seenUrls.has(url)) seenUrls.set(url, seenUrls.size === 0 ? jpegA : jpegB)
      return new Response(seenUrls.get(url)!, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    let ocrCalls = 0
    const ocrClient: GeminiClient = {
      models: {
        generateContent: async (args) => {
          ocrCalls++
          // Image A (call 1, rung 0) succeeds; every later rung-0 call dies
          // of daily quota — rung 1+ are healthy all run long.
          if (ocrCalls > 1 && args.model === 'gemini-3.8-flash') {
            throw new Error('429 Quota exceeded for quota metric GenerateRequests per day')
          }
          return { text: JSON.stringify(ocrItems) }
        },
      },
    }
    const restoreEnv = scrubChainEnv()
    try {
      const status = await Effect.runPromise(
        runPipeline(
          scopedOptions(stateDir, ['superindo'], {
            dryRun: true,
            fetch: fetchMock,
            ocrClient,
          })
        )
      )
      // The headline #347 behavior: a daily-quota 429 no longer aborts —
      // the run exits 0 and the payload publishes.
      expect(status.stage).toBe('done')
      const payload: IngestPayload = JSON.parse(
        await readFile(path.join(stateDir, 'payload-2026-10-24T23-00-05-000Z.json'), 'utf8')
      )
      expect(payload.items.length).toBeGreaterThan(0)
      // The store actually rode BOTH rungs (image A on 3.8, image B on 3.7)
      // — the ordered audit trail, not per-page noise.
      expect(status.stores['superindo']!.modelsUsed).toEqual([
        'gemini-3.8-flash',
        'gemini-3.7-flash',
      ])
      expect(ocrCalls).toBe(3)
    } finally {
      restoreEnv()
    }
  })

  it('carries modelsUsed on the run report and leaves it absent where no OCR ran (issue #347)', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const katalogHtml = await readFile(
      path.join(__dirname, 'fixtures/superindo/katalog-super-hemat.html'),
      'utf8'
    )
    const koranHtml = await readFile(
      path.join(__dirname, 'fixtures/superindo/promo-koran.html'),
      'utf8'
    )
    // Two distinct brochure pages: image A rides rung 0, image B advances
    // to rung 1 (rung 0 dies of daily quota after the first success).
    const jpegA = fakeJpegBytes()
    const jpegB = (() => {
      const bytes = fakeJpegBytes()
      bytes.fill(0xdd, 29)
      return bytes
    })()
    const seenUrls = new Map<string, Uint8Array<ArrayBuffer>>()
    const fetchMock = async (url: string): Promise<Response> => {
      if (url.includes('katalog-super-hemat')) return new Response(katalogHtml, { status: 200 })
      if (url.includes('promo-koran')) return new Response(koranHtml, { status: 200 })
      // Astro (in scope) serves empty category pages — a no-OCR store.
      if (url.includes('astronauts.id')) {
        return new Response('<html><body></body></html>', { status: 200 })
      }
      if (!seenUrls.has(url)) seenUrls.set(url, seenUrls.size === 0 ? jpegA : jpegB)
      return new Response(seenUrls.get(url)!, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    let ocrCalls = 0
    const ocrClient: GeminiClient = {
      models: {
        generateContent: async (args) => {
          ocrCalls++
          if (ocrCalls > 1 && args.model === 'gemini-3.8-flash') {
            throw new Error('429 Quota exceeded for quota metric GenerateRequests per day')
          }
          return { text: JSON.stringify(ocrItems) }
        },
      },
    }
    const { reported, publishFetch } = makeReportCapture()
    const restoreEnv = scrubChainEnv()
    try {
      await Effect.runPromise(
        runPipeline(
          scopedOptions(stateDir, ['superindo', 'astro'], {
            dryRun: false,
            fetch: fetchMock,
            ocrClient,
            publishFetch,
            ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
            ingestSecret: 's3cret',
          })
        )
      )
      expect(ocrCalls).toBe(3)
      // The strict report schema accepted the additive per-store field…
      expect(reported).toHaveLength(1)
      expect(reported[0]!.status).toBe('success')
      expect(reported[0]!.perStore['superindo']!.modelsUsed).toEqual([
        'gemini-3.8-flash',
        'gemini-3.7-flash',
      ])
      // …and a catalog store (no OCR) carries no modelsUsed at all.
      expect(reported[0]!.perStore['astro']!.modelsUsed).toBeUndefined()
    } finally {
      restoreEnv()
    }
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
    // (scopedOptions wraps the indomaret branches around this mock.)
    return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })
  }
  const lotteBrowser = fakeBrowserLauncher(lotteHtml)
  const ocrClient: GeminiClient = {
    models: { generateContent: async () => ({ text: JSON.stringify(ocrItems) }) },
  }

  const status = await Effect.runPromise(
    runPipeline(
      scopedOptions(stateDir, ['superindo', 'lotte-mart'], {
        dryRun: true,
        launcher: lotteBrowser.launcher,
        fetch: fetchMock,
        ocrClient,
      })
    )
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

it('runs the astro catalog store end to end — no OCR, outbox like the brochure stores', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
  const astroHtml = await readFile(path.join(__dirname, 'fixtures/astro/category.html'), 'utf8')
  const fetchMock = async (
    url: string,
    init?: RequestInit & { proxy?: string }
  ): Promise<Response> => {
    expect(init?.headers).toBeDefined()
    // One astro category page serves the fixture; the others serve empty
    // pages. (scopedOptions wraps the indomaret branches around this mock.)
    if (url.includes('beras-lokal-5858')) return new Response(astroHtml, { status: 200 })
    return new Response('<html><body></body></html>', { status: 200 })
  }

  const status = await Effect.runPromise(
    runPipeline(
      scopedOptions(stateDir, ['astro'], {
        dryRun: true,
        fetch: fetchMock,
        // The OCR client must never fire for a catalog-only run.
        ocrClient: {
          models: {
            generateContent: async () => {
              throw new Error('OCR must not run for catalog stores')
            },
          },
        },
      })
    )
  )

  expect(status.stage).toBe('done')
  const astro = status.stores['astro']!
  expect(astro.pagesFound).toBe(1)
  expect(astro.itemsExtracted).toBe(3) // duplicate + truncated object excluded
  expect(astro.itemsRejected).toBe(0)

  const payload: IngestPayload = JSON.parse(
    await readFile(path.join(stateDir, 'payload-2026-10-24T23-00-05-000Z.json'), 'utf8')
  )
  const astroItems = payload.items.filter((item) => item.storeSlug === 'astro')
  expect(astroItems).toHaveLength(3)

  // Post-discount price + parsed promo ("Diskon 8%" → discount_pct with the
  // effective unit price equal to the discounted listing price).
  const beras = astroItems.find((item) => item.name === 'Beras Setra Ramos Astro Goods')!
  expect(beras.productKey).toBe('beras-setra-ramos-astro-goods----5kg')
  expect(beras.price).toBe(70840)
  expect(beras.promoType).toBe('discount_pct')
  expect(beras.effectiveUnitPrice).toBe(70840)
  expect(beras.promoLabel).toBe('Diskon 8%')
  expect(beras.brochureUrl).toBe(
    'https://www.astronauts.id/c/kebutuhan-pokok-2721/beras-lokal-5858'
  )
  expect(beras.observedDate).toBe('2026-10-24')
  expect(beras.matchMethod).toBe('solo')

  // A tier promo stays label-only: conditional on buying N units, so it must
  // not claim an effective unit price.
  const ayam = astroItems.find((item) => item.name === 'Dada Ayam Boneless Astro Farm')!
  expect(ayam.price).toBe(30800)
  expect(ayam.promoType).toBeNull()
  expect(ayam.effectiveUnitPrice).toBeNull()
  expect(ayam.promoLabel).toBe('Beli 2 Disc.4%')

  // Outbox file: one JSON line per source page, stamped with the run's
  // scrapedAt — the same at-least-once guarantee the brochure stores have.
  const runItems = await readFile(
    path.join(stateDir, 'astro', 'run-2026-10-24T23-00-05-000Z.jsonl'),
    'utf8'
  )
  const lines = runItems
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { products: unknown[]; scrapedAt: string })
  expect(lines).toHaveLength(1)
  expect(lines[0]!.products).toHaveLength(3)
  expect(lines[0]!.scrapedAt).toBe('2026-10-24T23:00:05.000Z')
})

describe('runPipeline --stores scoping (docs/plan/scrape-now.md §2)', () => {
  it('runs only the requested stores — the status map covers nothing else', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const katalogHtml = await readFile(
      path.join(__dirname, 'fixtures/superindo/katalog-super-hemat.html'),
      'utf8'
    )
    const koranHtml = await readFile(
      path.join(__dirname, 'fixtures/superindo/promo-koran.html'),
      'utf8'
    )
    const status = await Effect.runPromise(
      runPipeline(
        scopedOptions(stateDir, ['superindo'], {
          dryRun: true,
          fetch: makeFetchMock(katalogHtml, koranHtml, fakeJpegBytes()),
          ocrClient: {
            models: { generateContent: async () => ({ text: JSON.stringify(ocrItems) }) },
          },
        })
      )
    )
    expect(Object.keys(status.stores)).toEqual(['superindo'])
    expect(status.stores['superindo']!.itemsExtracted).toBeGreaterThanOrEqual(1)
    // The unscoped stores are absent, not zeroed — the admin sees the truth.
    expect(status.stores['lotte-mart']).toBeUndefined()
    expect(status.stores['astro']).toBeUndefined()
  })

  it('fails a scope that matches nothing — never a "successful" empty run', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const exit = await Effect.runPromiseExit(
      runPipeline(
        scopedOptions(stateDir, ['unknown-store'], {
          dryRun: true,
          fetch: makeFetchMock('<html></html>', '<html></html>', fakeJpegBytes()),
          ocrClient: { models: { generateContent: async () => ({ text: '[]' }) } },
        })
      )
    )
    const failure = exitError(exit)
    expect(failure).not.toBeNull()
    expect(failure!.exitCode).toBe(1)
    expect(failure!.message).toContain('unknown-store')
  })
})

describe('brochure uploads (issue #293)', () => {
  /** Live-publish fetch capturing brochure PUTs, price payloads, and reports. */
  function makeUploadCapture() {
    const puts: Array<{ url: string; contentType: string | null; bytes: Uint8Array }> = []
    const posted: IngestPayload[] = []
    const publishFetch = async (url: string, init?: RequestInit) => {
      if (url.includes('/api/internal/brochures/')) {
        puts.push({
          url,
          contentType: new Headers(init?.headers).get('Content-Type'),
          bytes: new Uint8Array(await (init!.body as ArrayBuffer)),
        })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (url.endsWith('/api/internal/ingest/runs')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      posted.push(JSON.parse(init!.body as string))
      return new Response(JSON.stringify({ accepted: 1, skipped: 0 }), { status: 200 })
    }
    return { puts, posted, publishFetch }
  }

  async function liveScenario() {
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
    const ocrClient: GeminiClient = {
      models: { generateContent: async () => ({ text: JSON.stringify(ocrItems) }) },
    }
    const base = scopedOptions(stateDir, ['superindo'], {
      dryRun: false,
      fetch: makeFetchMock(katalogHtml, koranHtml, jpeg),
      ocrClient,
      ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
      ingestSecret: 's3cret',
    })
    return { stateDir, jpeg, base }
  }

  it('uploads each new image at {store}/{YYYYMMDD}/{file}, emits the object URL, then remembers', async () => {
    const { stateDir, jpeg, base } = await liveScenario()
    const { puts, posted, publishFetch } = makeUploadCapture()
    const status = await Effect.runPromise(runPipeline({ ...base, publishFetch }))

    // One PUT per new image, riding the ingest base URL with the store, the
    // compact scrape date, and the md5-suffixed filename. The fixture's real
    // filename carries parentheses — the accepted charset must cover it.
    expect(puts.length).toBeGreaterThanOrEqual(1)
    const md5 = md5Hash(jpeg)
    for (const put of puts) {
      expect(put.url).toMatch(
        /^https:\/\/api\.example\.com\/api\/internal\/brochures\/superindo\/20261024\/[A-Za-z0-9._()-]+$/
      )
      expect(decodeURIComponent(put.url)).toContain(`_${md5.slice(0, 8)}`)
      expect(put.contentType).toBe('image/jpeg')
      expect(Buffer.from(put.bytes).equals(Buffer.from(jpeg))).toBe(true)
    }

    // The payload's brochureUrl is the relative same-origin object URL.
    expect(posted).toHaveLength(1)
    const keys = puts.map((put) => put.url.split('/api/internal/brochures/')[1])
    const expectedUrls = keys.map((key) => `/api/brochures/${key}`)
    for (const item of posted[0]!.items) {
      expect(expectedUrls).toContain(item.brochureUrl)
    }

    // Upload happened BEFORE rememberProcessed: the image is in novelty state.
    const stateFile = path.join(stateDir, 'superindo', 'state.json')
    const stateJson = JSON.parse(await readFile(stateFile, 'utf8'))
    expect(stateJson.processed).toContain(md5)

    // Per-store status counter (status.json only — reports stay strict).
    expect(status.stores['superindo']!.brochuresUploaded).toBe(puts.length)

    // Second run: novelty-skipped images issue NO further uploads.
    const { puts: puts2, publishFetch: publishFetch2 } = makeUploadCapture()
    await Effect.runPromise(
      runPipeline({
        ...base,
        now: () => new Date('2026-10-25T23:00:05Z'),
        publishFetch: publishFetch2,
      })
    )
    expect(puts2).toHaveLength(0)
  })

  it('dry-run writes the payload but never uploads', async () => {
    const { stateDir, base } = await liveScenario()
    const { puts, publishFetch } = makeUploadCapture()
    const status = await Effect.runPromise(runPipeline({ ...base, dryRun: true, publishFetch }))

    expect(puts).toHaveLength(0)
    expect(status.stores['superindo']!.brochuresUploaded).toBeUndefined()
    // The dry-run payload still carries the object URLs — construction is
    // independent of the transport.
    const payload: IngestPayload = JSON.parse(
      await readFile(path.join(stateDir, 'payload-2026-10-24T23-00-05-000Z.json'), 'utf8')
    )
    expect(payload.items[0]!.brochureUrl).toMatch(/^\/api\/brochures\/superindo\/20261024\//)
  })

  it('replays an upload failure: outbox retained, image not remembered, run exits 1 after publish', async () => {
    const { stateDir, base } = await liveScenario()
    const { publishFetch } = makeUploadCapture()
    const failingUpload = async (url: string, init?: RequestInit) => {
      if (url.includes('/api/internal/brochures/')) {
        return new Response('r2 down', { status: 500 })
      }
      return publishFetch(url, init)
    }

    const failure = await Effect.runPromiseExit(
      runPipeline({ ...base, publishFetch: failingUpload })
    )
    expect(failure._tag).toBe('Failure')
    const error = exitError(failure) as Error & { exitCode?: number }
    expect(error.message).toContain('HTTP 500')
    expect(error.exitCode).toBe(1)

    // The payload POST still went out (no items this run), but the image was
    // NOT remembered — the next run re-downloads, re-OCRs, re-uploads. The
    // upload abort precedes the loop's saveState, so a first-image failure
    // leaves no state file at all.
    const stateFile = path.join(stateDir, 'superindo', 'state.json')
    const stateJson = existsSync(stateFile)
      ? JSON.parse(await readFile(stateFile, 'utf8'))
      : { processed: [] }
    expect(stateJson.processed).toHaveLength(0)

    // The outbox line was appended before the upload and survives for replay.
    const runFiles = (await readdir(path.join(stateDir, 'superindo'))).filter((name) =>
      name.startsWith('run-')
    )
    expect(runFiles).toHaveLength(1)

    // Run 2 with a healthy upload: the replayed batch AND the re-OCR'd batch
    // emit the same object URL; the upload happens exactly once more.
    const { puts, posted: posted2, publishFetch: publishFetch2 } = makeUploadCapture()
    const status2 = await Effect.runPromise(
      runPipeline({
        ...base,
        now: () => new Date('2026-10-25T23:00:05Z'),
        publishFetch: publishFetch2,
      })
    )
    expect(status2.stage).toBe('done')
    expect(puts).toHaveLength(1)
    // Run 2 re-uploads under ITS OWN scrape date — a fresh immutable key.
    expect(puts[0]!.url).toMatch(/\/api\/internal\/brochures\/superindo\/20261025\//)
    const uploadedUrl = `/api/brochures/${puts[0]!.url.split('/api/internal/brochures/')[1]}`
    // The current-run batch (observed 2026-10-25) references the uploaded
    // object — the URL the view will serve for the now-current observation.
    const current = posted2[0]!.items.find(
      (item) => item.productKey === 'gula-pasir----1-kg' && item.observedDate === '2026-10-25'
    )!
    expect(current.brochureUrl).toBe(uploadedUrl)
    // The replayed outbox batch keeps the URL recorded in run 1 (its own
    // date key) — its observation is immediately superseded by the 2026-10-25
    // row, so the never-uploaded run-1 URL stays out of the view's base.
    const replayed = posted2[0]!.items.find((item) => item.observedDate === '2026-10-24')!
    expect(replayed.brochureUrl).toMatch(/^\/api\/brochures\/superindo\/20261024\//)
  })
})
