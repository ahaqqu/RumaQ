// Indomaret's render-path E2E (issue #322, design-arch §1.2) — its own
// per-store story, split out of pipeline.test.ts (review B1): hub fixture →
// 10 brochure detail pages → pdfUrl → fetchDocument (gate-free) → fake
// render → classify → OCR → R2 PUTs → outbox, then the determinism run
// (identical PDF → identical render → identical md5 → novelty skips).

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import type { IngestPayload } from '@rumaq/contract'

import { runPipeline } from '../../src/pipeline.js'
import type { GeminiClient } from '../../src/ocr/gemini.js'
import { emptyLotte, noSleep, ocrItems, stubEmbedClient, stubVerifyClient } from './stubs.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('indomaret render path E2E (issue #322)', () => {
  it('runs end to end — rendered bytes ride classify → OCR → outbox without a download', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-pipeline-'))
    const hubHtml = await readFile(
      path.join(__dirname, '../fixtures/indomaret/promosi.html'),
      'utf8'
    )
    const detailHtml = await readFile(
      path.join(__dirname, '../fixtures/indomaret/brochure-page.html'),
      'utf8'
    )
    const pdfFetches: string[] = []
    const fetchMock = async (
      url: string,
      init?: RequestInit & { proxy?: string }
    ): Promise<Response> => {
      expect(init?.headers).toBeDefined()
      if (url === 'https://www.indomaret.co.id/promosi/') {
        return new Response(hubHtml, { status: 200 })
      }
      if (url.includes('indomaret.co.id/')) {
        // Detail pages serve the flipbook fixture renamed per slug, so the 10
        // brochures carry 10 distinct PDFs; each PDF URL must be fetched
        // exactly once — via fetchDocument (gate-free), never fetchBytes.
        if (url.endsWith('.pdf')) {
          pdfFetches.push(url)
          const bytes = new Uint8Array(1024 + url.length)
          bytes.set([0x25, 0x50, 0x44, 0x46], 0) // %PDF
          let sum = 0
          for (const ch of url) sum = (sum + ch.charCodeAt(0)) & 0xff
          bytes.set([url.length & 0xff, sum], 8)
          return new Response(bytes, {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          })
        }
        const slug = new URL(url).pathname.split('/').filter(Boolean)[0]!
        return new Response(detailHtml.replaceAll('PalingMurah-29Okt.pdf', `${slug}.pdf`), {
          status: 200,
        })
      }
      // Other stores' listings serve empty pages.
      return new Response('<html><body></body></html>', { status: 200 })
    }
    // Fake render: 2 distinct PNG pages per PDF, sized past the 50 KB novelty
    // gate with 1240x1754 IHDR dimensions (a 150 DPI A4-ish page shape). The
    // salt is the PDF's own byte length — distinct across the 10 brochures,
    // deterministic across runs (the property poppler's determinism gives the
    // real renderer, which the live pdf.test.ts pins).
    const renderCalls: { maxPages?: number }[] = []
    const fakeRender = (pdfBytes: Uint8Array, opts?: { maxPages?: number }) => {
      renderCalls.push({ maxPages: opts?.maxPages })
      const salt = (pdfBytes[8]! + pdfBytes[9]!) & 0xff
      return Effect.succeed(
        [1, 2].map((pageNo) => {
          const bytes = new Uint8Array(64 * 1024)
          bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
          const view = new DataView(bytes.buffer)
          view.setUint32(8, 13)
          bytes.set([0x49, 0x48, 0x44, 0x52], 12)
          view.setUint32(16, 1240)
          view.setUint32(20, 1754)
          bytes.fill(pageNo, 24)
          bytes.fill(salt, 25)
          return { pageNo, bytes }
        })
      )
    }

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
    // Live-publish fetch capturing brochure PUTs (content type + object key)
    // and price payloads; run reports accepted silently.
    const puts: Array<{ url: string; contentType: string | null }> = []
    const posted: IngestPayload[] = []
    const publishFetch = async (url: string, init?: RequestInit) => {
      if (url.includes('/api/internal/brochures/')) {
        puts.push({ url, contentType: new Headers(init?.headers).get('Content-Type') })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (url.endsWith('/api/internal/ingest/runs')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      posted.push(JSON.parse(init!.body as string))
      return new Response(JSON.stringify({ accepted: 7, skipped: 0 }), { status: 200 })
    }

    const status = await Effect.runPromise(
      runPipeline({
        launcher: emptyLotte.launcher,
        embedClient: stubEmbedClient,
        verifyClient: stubVerifyClient,
        stateDir,
        stores: ['indomaret'],
        dryRun: false,
        fetch: fetchMock,
        renderPdf: fakeRender,
        ocrClient,
        publishFetch,
        ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
        ingestSecret: 's3cret',
        sleep: noSleep,
        now: () => new Date('2026-10-24T23:00:05Z'),
        log: () => {},
      })
    )

    expect(status.stage).toBe('done')
    const indomaret = status.stores['indomaret']!
    expect(indomaret.pagesFound).toBe(20) // 10 brochures × 2 rendered pages
    expect(indomaret.newImages).toBe(20)
    expect(indomaret.itemsExtracted).toBeGreaterThanOrEqual(1)
    // The PDF went over the wire exactly once per brochure — via fetchDocument.
    expect(pdfFetches).toHaveLength(10)
    // The remaining budget rode every render call, decremented per brochure.
    expect(renderCalls.map((call) => call.maxPages)).toEqual(
      Array.from({ length: 10 }, (_, i) => 40 - i * 2)
    )

    // OCR saw real PNG declarations, never the PDF's application/pdf.
    expect(inlineMimes.length).toBe(20)
    expect(inlineMimes.every((mime) => mime === 'image/png')).toBe(true)

    // The rendered pages were uploaded as R2 objects and the payload's
    // brochure URLs are the same-origin object URLs (OCR-flow parity: the
    // rendered PNG pages flow exactly like superindo's downloaded JPGs).
    expect(puts).toHaveLength(20)
    for (const put of puts) {
      expect(put.contentType).toBe('image/png')
      expect(put.url).toMatch(
        /^https:\/\/api\.example\.com\/api\/internal\/brochures\/indomaret\/20261024\/[A-Za-z0-9._()-]+-page-\d{2}_[a-f0-9]{8}\.png$/
      )
    }
    const indomaretItems = posted[0]!.items.filter((item) => item.storeSlug === 'indomaret')
    expect(indomaretItems.length).toBeGreaterThanOrEqual(1)
    for (const item of indomaretItems) {
      expect(item.brochureUrl).toMatch(/^\/api\/brochures\/indomaret\/20261024\//)
    }

    // Second run: identical PDF → identical render → identical md5 → existing
    // (poppler determinism is load-bearing for novelty; design-arch §3).
    const status2 = await Effect.runPromise(
      runPipeline({
        launcher: emptyLotte.launcher,
        embedClient: stubEmbedClient,
        verifyClient: stubVerifyClient,
        stateDir,
        stores: ['indomaret'],
        dryRun: false,
        fetch: fetchMock,
        renderPdf: fakeRender,
        ocrClient,
        publishFetch,
        ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
        ingestSecret: 's3cret',
        sleep: noSleep,
        now: () => new Date('2026-10-25T23:00:05Z'),
        log: () => {},
      })
    )
    expect(status2.stores['indomaret']!.newImages).toBe(0)
    expect(status2.stores['indomaret']!.existingImages).toBe(20)
  })
})
