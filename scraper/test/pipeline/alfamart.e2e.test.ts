// Alfamart's catalog E2E stories (issue #322, design-arch §1.3 + the A4
// teaser/churn decision) — per-store stories, split out of pipeline.test.ts
// (review B1): the browser-tier run through the pipeline (launcher
// forwarded, items validated without OCR), a zero-card teaser campaign
// riding through as a surfaced warning, and the gateway-401 churn signature
// sentineling the cycle with nothing published.

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import type { IngestPayload } from '@rumaq/contract'

import { runPipeline } from '../../src/pipeline.js'
import type { GeminiClient } from '../../src/ocr/gemini.js'
import { fakeBrowserLauncher, exitError } from '../helpers.js'
import {
  makeReportCapture,
  noSleep,
  serveIndomaret,
  silentIndomaretRender,
  stubEmbedClient,
  stubVerifyClient,
} from './stubs.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('alfamart catalog E2E (issue #322)', () => {
  it('runs the catalog store through the browser tier — launcher forwarded, items land without OCR', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const listingHtml = await readFile(
      path.join(__dirname, '../fixtures/alfamart/promo.html'),
      'utf8'
    )
    const detailHtml = await readFile(
      path.join(__dirname, '../fixtures/alfamart/promo-detail.html'),
      'utf8'
    )
    // Per-URL serving: every /promo/{slug} detail page vs the listing (whose
    // URL has no trailing slash) — exercises fakeBrowserLauncher's
    // URL-fragment mapping; the detail fragment must match first.
    const alfamartBrowser = fakeBrowserLauncher({
      '/promo/': detailHtml,
      'alfagift.id/promo': listingHtml,
    })
    // The OCR client must never fire for a catalog-only run.
    const noOcr: GeminiClient = {
      models: {
        generateContent: async () => {
          throw new Error('OCR must not run for catalog stores')
        },
      },
    }
    const posted: IngestPayload[] = []
    const publishFetch = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/internal/ingest/runs')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      posted.push(JSON.parse(init!.body as string))
      return new Response(JSON.stringify({ accepted: 3, skipped: 0 }), { status: 200 })
    }

    const status = await Effect.runPromise(
      runPipeline({
        launcher: alfamartBrowser.launcher,
        embedClient: stubEmbedClient,
        verifyClient: stubVerifyClient,
        stateDir,
        dryRun: false,
        fetch: async (url: string) =>
          // Indomaret rides its silent chain (see pipeline/stubs.ts); the
          // other plain stores' listings serve empty pages.
          serveIndomaret(url, () => new Response('<html><body></body></html>', { status: 200 }))!,
        renderPdf: silentIndomaretRender,
        ocrClient: noOcr,
        publishFetch,
        ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
        ingestSecret: 's3cret',
        sleep: noSleep,
        now: () => new Date('2026-10-31T23:00:05Z'),
        log: () => {},
      })
    )

    expect(status.stage).toBe('done')
    const alfamart = status.stores['alfamart']!
    // pagesFound counts distinct campaign pages with items (the deduped 3
    // products all carry the first campaign's URL).
    expect(alfamart.pagesFound).toBe(1)
    expect(alfamart.itemsExtracted).toBe(3)
    expect(alfamart.itemsRejected).toBe(0)
    // The Chromium budget: 1 listing + maxPages 40 campaign visits for
    // alfamart (lotte's one unwaited listing navigation rides the same fake).
    const alfagiftNavigations = alfamartBrowser.state.navigations.filter((url) =>
      url.includes('alfagift.id')
    )
    expect(alfagiftNavigations).toHaveLength(41)
    expect(alfagiftNavigations[0]).toBe('https://alfagift.id/promo')
    expect(alfamartBrowser.state.waits).toBe(41)
    expect(alfamartBrowser.state.closed).toBe(true)

    // The items validated straight from the rendered DOM — promo price,
    // discount label parsed by the shared parsePromo, campaign deep link.
    const items = posted[0]!.items.filter((item) => item.storeSlug === 'alfamart')
    expect(items).toHaveLength(3)
    const filma = items.find((item) => item.name === 'FILMA Minyak Goreng Pouch 2 L')!
    expect(filma.price).toBe(43700)
    expect(filma.promoType).toBe('discount_pct')
    expect(filma.promoLabel).toBe('Diskon 5%')
    expect(filma.effectiveUnitPrice).toBe(43700)
    expect(filma.brochureUrl).toBe(
      'https://alfagift.id/promo/Nestle-Super-Brand-Day-29-31-Oktober-2026'
    )
  })

  it('publishes around a zero-card teaser campaign with its warning surfaced (issue #322 A4)', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const listingHtml = await readFile(
      path.join(__dirname, '../fixtures/alfamart/promo.html'),
      'utf8'
    )
    const detailHtml = await readFile(
      path.join(__dirname, '../fixtures/alfamart/promo-detail.html'),
      'utf8'
    )
    // The first listed campaign (Nestle Super Brand Day) renders zero cards —
    // the scheduled-teaser shape. Its fragment maps BEFORE '/promo/' so it
    // wins the fake's per-URL serving.
    const teaserBrowser = fakeBrowserLauncher({
      'Nestle-Super-Brand-Day': '<html><body>teaser</body></html>',
      '/promo/': detailHtml,
      'alfagift.id/promo': listingHtml,
    })
    const { reported, posted, publishFetch } = makeReportCapture()

    const status = await Effect.runPromise(
      runPipeline({
        launcher: teaserBrowser.launcher,
        embedClient: stubEmbedClient,
        verifyClient: stubVerifyClient,
        stateDir,
        stores: ['alfamart'],
        dryRun: false,
        fetch: async () => new Response('<html><body></body></html>', { status: 200 }),
        renderPdf: silentIndomaretRender,
        // The OCR client must never fire for a catalog-only run.
        ocrClient: {
          models: {
            generateContent: async () => {
              throw new Error('OCR must not run for catalog stores')
            },
          },
        },
        publishFetch,
        ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
        ingestSecret: 's3cret',
        sleep: noSleep,
        now: () => new Date('2026-10-31T23:00:05Z'),
        log: () => {},
      })
    )

    // One teaser page did not red the cycle — the run is green.
    expect(status.stage).toBe('done')
    const alfamart = status.stores['alfamart']!
    expect(alfamart.error).toBeUndefined()
    expect(alfamart.itemsExtracted).toBe(3)
    // The teaser is visible with its URL, never silently skipped.
    expect(alfamart.warnings).toEqual([
      expect.stringContaining(
        'https://alfagift.id/promo/Nestle-Super-Brand-Day-29-31-Oktober-2026'
      ),
    ])
    // The strict run-report schema carries the same warnings to the monitor.
    expect(reported[0]!.status).toBe('success')
    expect(reported[0]!.perStore['alfamart']!.warnings).toEqual(alfamart.warnings)
    // The 3 healthy items published despite the teaser.
    expect(posted[0]!.items.filter((item) => item.storeSlug === 'alfamart')).toHaveLength(3)
  })

  it('sentinels when the whole cycle renders zero cards — nothing published (issue #322 A4)', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const listingHtml = await readFile(
      path.join(__dirname, '../fixtures/alfamart/promo.html'),
      'utf8'
    )
    // Only the listing serves content — every campaign page falls through to
    // the fake's empty default (the gateway-401 shape, 40/40 empty).
    const gatedBrowser = fakeBrowserLauncher({ 'alfagift.id/promo': listingHtml })
    const { reported, posted, publishFetch } = makeReportCapture()

    const failure = await Effect.runPromiseExit(
      runPipeline({
        launcher: gatedBrowser.launcher,
        embedClient: stubEmbedClient,
        verifyClient: stubVerifyClient,
        stateDir,
        stores: ['alfamart'],
        dryRun: false,
        fetch: async () => new Response('<html><body></body></html>', { status: 200 }),
        renderPdf: silentIndomaretRender,
        ocrClient: {
          models: {
            generateContent: async () => {
              throw new Error('OCR must not run for catalog stores')
            },
          },
        },
        publishFetch,
        ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
        ingestSecret: 's3cret',
        sleep: noSleep,
        now: () => new Date('2026-10-31T23:00:05Z'),
        log: () => {},
      })
    )

    // The churn signature (every visited campaign empty) still reds the store
    // — partial data is untrustworthy, so the cycle discards.
    expect(failure._tag).toBe('Failure')
    const error = exitError(failure) as Error
    expect(error.message).toContain('alfamart')
    expect(error.message).toContain('40/40 visited campaign pages rendered 0 product cards')
    // The publish went out (per-store isolation) with no alfamart items at all.
    expect(posted[0]!.items).toHaveLength(0)
    expect(reported[0]!.status).toBe('failed')
    expect(reported[0]!.perStore['alfamart']!.error).toContain('ScrapeStructureError')
  })
})
