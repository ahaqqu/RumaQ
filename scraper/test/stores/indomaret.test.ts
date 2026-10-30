// Indomaret plugin tests (issue #322, design-arch §1.2) — parses trimmed
// structural snapshots of the real /promosi/ hub and the /paling-murah/
// detail page (fixtures saved 2026-10-30): the two JS link carriers
// (window.open literals + the idToUrlMap block), the Real3D-Flipbook
// pdfUrl configs (empty global template vs the real one), the nav/off-host
// anchors the scraper must never follow, the render-time budget clamp in
// hub document order, and the structural sentinels.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import {
  createIndomaretPlugin,
  extractPdfUrl,
  isAllowedIndomaretUrl,
  parseBrochurePages,
  pdfBasename,
  PROMOSI_HUB_URL,
} from '../../src/stores/indomaret.js'
import { PdfRenderError, ScrapeStructureError, type FetchError } from '../../src/fetch/errors.js'
import type { RenderedPage } from '../../src/util/pdf.js'
import type { FetchContext } from '../../src/stores/types.js'
import { exitError } from '../helpers.js'
import { loadConfig, storeBySlug } from '../../src/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadFixture(name: string): string {
  return readFileSync(path.join(__dirname, '../fixtures/indomaret', name), 'utf8')
}

/** The 10 live brochure detail pages, true hub document order (2026-10-30). */
function expectedDetailUrls(): string[] {
  return [
    'https://www.indomaret.co.id/paling-murah/',
    'https://www.indomaret.co.id/hemat-minggu-ini/',
    'https://www.indomaret.co.id/tebus-heboh/',
    'https://www.indomaret.co.id/harga-khusus-member/',
    'https://www.indomaret.co.id/promo-bank-ewallet/',
    'https://www.indomaret.co.id/pulsanya-sekalian-kakak/',
    'https://www.indomaret.co.id/p4h/',
    'https://www.indomaret.co.id/pspb/',
    'https://www.indomaret.co.id/promosi-berhadiah/',
    'https://www.indomaret.co.id/super-hemat/',
  ]
}

describe('parseBrochurePages — real hub page', () => {
  const html = loadFixture('promosi.html')

  it('harvests the 10 brochure detail pages in hub document order from both JS carriers', () => {
    // The idToUrlMap block sits between the pulsanya and super-hemat
    // scripts — positional merge proves the order is the document's.
    expect(parseBrochurePages(html)).toEqual(expectedDetailUrls())
  })

  it('never returns duplicates despite repeated script blocks', () => {
    const urls = parseBrochurePages(html)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('never follows nav or off-host anchors', () => {
    const urls = parseBrochurePages(html)
    expect(urls.every((url) => url.startsWith('https://www.indomaret.co.id/'))).toBe(true)
    expect(urls.some((url) => url.includes('klikindomaret'))).toBe(false)
    expect(urls.some((url) => url.includes('brand-kami'))).toBe(false)
    expect(urls.some((url) => url === PROMOSI_HUB_URL)).toBe(false)
  })

  it('returns [] for empty and structure-less HTML (the caller sentinels)', () => {
    expect(parseBrochurePages('')).toEqual([])
    expect(parseBrochurePages('<html><body><p>No promos</p></body></html>')).toEqual([])
  })

  it('harvests anchors inside brosur- section containers', () => {
    const withAnchor = '<div id="brosur-super-hemat"><a href="/super-hemat/">Lihat</a></div>'
    expect(parseBrochurePages(withAnchor)).toEqual(['https://www.indomaret.co.id/super-hemat/'])
  })
})

describe('isAllowedIndomaretUrl', () => {
  it('allows indomaret.co.id and subdomains', () => {
    expect(isAllowedIndomaretUrl('https://www.indomaret.co.id/wp-content/uploads/a.pdf')).toBe(true)
    expect(isAllowedIndomaretUrl('https://cdn.indomaret.co.id/a.pdf')).toBe(true)
  })

  it('rejects off-host URLs including lookalike suffixes', () => {
    expect(isAllowedIndomaretUrl('https://evil.com/a.pdf')).toBe(false)
    expect(isAllowedIndomaretUrl('https://indomaret.co.id.evil.com/a.pdf')).toBe(false)
    expect(isAllowedIndomaretUrl('/wp-content/uploads/a.pdf')).toBe(false)
  })
})

describe('extractPdfUrl — real detail page', () => {
  const html = loadFixture('brochure-page.html')

  it('extracts the JSON-escaped pdfUrl, skipping the empty global template', () => {
    // The page embeds flipbookOptions_global with pdfUrl":"" first — the
    // real config must win.
    expect(extractPdfUrl(html)).toBe(
      'https://www.indomaret.co.id/wp-content/uploads/PalingMurah-29Okt.pdf'
    )
  })

  it('returns null when no flipbook config exists (the caller sentinels)', () => {
    expect(extractPdfUrl('<html><body></body></html>')).toBeNull()
    expect(extractPdfUrl('var flipbookOptions_global = {"pdfUrl":""};')).toBeNull()
  })

  it('rejects off-host and non-PDF values', () => {
    expect(extractPdfUrl('{"pdfUrl":"https://evil.com/a.pdf"}')).toBeNull()
    expect(extractPdfUrl('{"pdfUrl":"https://www.indomaret.co.id/uploads/page.png"}')).toBeNull()
  })
})

describe('pdfBasename', () => {
  it('strips the extension from the PDF path', () => {
    expect(
      pdfBasename('https://www.indomaret.co.id/wp-content/uploads/PalingMurah-29Okt.pdf')
    ).toBe('PalingMurah-29Okt')
  })
})

/** Fake render: `pagesPerPage` distinct pages per call, recording calls. */
function fakeRender(pagesPerPage: number) {
  const calls: { maxPages?: number; byteLength: number }[] = []
  const render = (pdf: Uint8Array, opts: { maxPages?: number }): Effect.Effect<RenderedPage[]> => {
    calls.push({ maxPages: opts.maxPages, byteLength: pdf.byteLength })
    return Effect.succeed(
      Array.from({ length: pagesPerPage }, (_, i) => ({
        pageNo: i + 1,
        bytes: new Uint8Array([0x89, 0x50, pdf.byteLength, i]),
      }))
    )
  }
  return { render, calls }
}

/** Plugin test harness: fixture-serving ctx with recorded fetches. */
function makeCtx(options: {
  fetchHtml: (url: string) => Effect.Effect<string, FetchError>
  fetchDocument?: (
    url: string
  ) => Effect.Effect<{ bytes: Uint8Array; contentType: string | null }, FetchError>
  render?: (
    pdf: Uint8Array,
    opts: { maxPages?: number }
  ) => Effect.Effect<RenderedPage[], PdfRenderError>
  maxPages?: number
}) {
  const store = storeBySlug(loadConfig(), 'indomaret')!
  const config = options.maxPages !== undefined ? { ...store, maxPages: options.maxPages } : store
  const fetchedHtml: string[] = []
  const fetchedDocuments: string[] = []
  const plugin = createIndomaretPlugin(config)
  const ctx: FetchContext = {
    fetchHtml: (url) => {
      fetchedHtml.push(url)
      return options.fetchHtml(url)
    },
    fetchDocument: (url) => {
      fetchedDocuments.push(url)
      // The sentinel scenarios never reach a PDF fetch — die loudly if one does.
      return options.fetchDocument
        ? options.fetchDocument(url)
        : Effect.die(new Error(`unexpected fetchDocument(${url})`))
    },
    fetchRendered: (url) => Effect.die(new Error(`unexpected fetchRendered(${url})`)),
    renderPdf: options.render ?? fakeRender(3).render,
    runStartedAt: '2026-10-30T00:00:00Z',
  }
  return { plugin, ctx, fetchedHtml, fetchedDocuments }
}

describe('indomaret plugin — real hub and detail fixtures', () => {
  const detailPage = loadFixture('brochure-page.html')
  const hub = () => loadFixture('promosi.html')
  const hubOrDetail = (url: string) => (url === PROMOSI_HUB_URL ? hub() : detailPage)

  it('renders PDFs into pre-fetched page bytes deep-linking each detail page', async () => {
    const { plugin, ctx, fetchedDocuments } = makeCtx({
      fetchHtml: (url) => Effect.succeed(hubOrDetail(url)),
      fetchDocument: (url) =>
        Effect.succeed({
          bytes: new TextEncoder().encode(`pdf:${url}`),
          contentType: 'application/pdf',
        }),
    })
    const pages = await Effect.runPromise(plugin.listBrochurePages(ctx))
    // 10 brochures × 3 pages each, maxPages 40 → all 30 survive.
    expect(pages).toHaveLength(30)
    for (const page of pages) {
      expect(page.brochureUrl).toMatch(/^https:\/\/www\.indomaret\.co\.id\/[a-z0-9-]+\/$/)
      expect(page.imageUrl).toBe(
        'https://www.indomaret.co.id/wp-content/uploads/PalingMurah-29Okt.pdf'
      )
      expect(page.filename).toMatch(/^PalingMurah-29Okt-page-\d{2}\.png$/)
      expect(page.bytes).toBeDefined()
    }
    // One document fetch per brochure — the fixture serves one PDF URL.
    expect(fetchedDocuments).toHaveLength(10)
    expect(new Set(fetchedDocuments).size).toBe(1)
    // Page filenames never collide within a brochure.
    expect(new Set(pages.slice(0, 3).map((page) => page.filename))).toHaveLength(3)
  })

  it('clamps the budget at render time in hub document order — later PDFs are never fetched', async () => {
    const { render, calls } = fakeRender(3)
    const { plugin, ctx, fetchedHtml, fetchedDocuments } = makeCtx({
      fetchHtml: (url) => Effect.succeed(hubOrDetail(url)),
      fetchDocument: () =>
        Effect.succeed({ bytes: new Uint8Array(8), contentType: 'application/pdf' }),
      render,
      maxPages: 4,
    })
    const pages = await Effect.runPromise(plugin.listBrochurePages(ctx))

    // 3 pages from the first brochure + 1 from the second (clamped) = 4.
    expect(pages).toHaveLength(4)
    expect(calls.map((call) => call.maxPages)).toEqual([4, 1])
    expect(fetchedDocuments).toHaveLength(2)
    // Hub document order: the third detail page is never even fetched.
    expect(fetchedHtml.filter((url) => url !== PROMOSI_HUB_URL)).toHaveLength(2)
    expect(fetchedHtml).toContain(expectedDetailUrls()[0])
    expect(fetchedHtml).toContain(expectedDetailUrls()[1])
    expect(fetchedHtml).not.toContain(expectedDetailUrls()[2])
    // The clamped second brochure contributes only its first page.
    expect(pages[3]!.filename).toBe('PalingMurah-29Okt-page-01.png')
  })

  it('sentinels a hub that lists zero brochures', async () => {
    const { plugin, ctx, fetchedHtml } = makeCtx({
      fetchHtml: () => Effect.succeed('<html><body>No promos</body></html>'),
    })
    const exit = await Effect.runPromiseExit(plugin.listBrochurePages(ctx))
    expect(exit._tag).toBe('Failure')
    const error = exitError(exit) as ScrapeStructureError
    expect(error.message).toContain('0 brochure pages')
    expect(fetchedHtml).toHaveLength(1)
  })

  it('sentinels a detail page with no pdfUrl', async () => {
    const { plugin, ctx } = makeCtx({
      fetchHtml: (url) =>
        Effect.succeed(url === PROMOSI_HUB_URL ? hub() : '<html><body>broken</body></html>'),
    })
    const exit = await Effect.runPromiseExit(plugin.listBrochurePages(ctx))
    expect(exit._tag).toBe('Failure')
    const error = exitError(exit) as ScrapeStructureError
    expect(error.message).toContain('no pdfUrl')
  })

  it('propagates a PdfRenderError from the renderer (missing binary rides per-store isolation)', async () => {
    const { plugin, ctx } = makeCtx({
      fetchHtml: (url) => Effect.succeed(hubOrDetail(url)),
      fetchDocument: () =>
        Effect.succeed({ bytes: new Uint8Array(8), contentType: 'application/pdf' }),
      render: () =>
        Effect.fail(new PdfRenderError({ message: 'pdftoppm not found — install poppler-utils' })),
    })
    const exit = await Effect.runPromiseExit(plugin.listBrochurePages(ctx))
    expect(exit._tag).toBe('Failure')
    const error = exitError(exit) as PdfRenderError
    expect(error._tag).toBe('PdfRenderError')
    expect(error.message).toContain('pdftoppm not found')
  })
})

describe('indomaret config entry', () => {
  it('registers the brochure/plain shape with its proxy slot', () => {
    const config = storeBySlug(loadConfig(), 'indomaret')!
    expect(config).toMatchObject({
      slug: 'indomaret',
      name: 'Indomaret',
      kind: 'brochure',
      strategy: 'plain',
      region: 'jakarta',
      website: 'https://www.indomaret.co.id/',
      maxPages: 40,
      proxyEnv: 'INDOMARET_PROXY_URL',
    })
  })
})
