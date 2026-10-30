// Indomaret promosi (issue #322, design-arch §1.2) — brochure PDFs on the
// plain tier. The /promosi/ hub is server-rendered WordPress; each brochure
// is a separate static page whose Real3D-Flipbook config embeds the PDF URL
// (JSON-escaped, `pdfUrl":"https:\/\/…"`). The plugin walks hub → detail
// pages → pdfUrl → fetchDocument (gate-free bytes) → renderPdfPages (150
// DPI PNGs via pdftoppm) and yields pre-fetched page bytes, so the stock
// classify → OCR → publish flow runs unchanged: novelty keys on the
// rendered bytes' MD5 (poppler PNG output is deterministic for identical
// input), magic-byte sniffing declares image/png, and the maxPages cap
// clamps at render time in hub document order (design-arch §1.2/§5 — the
// last contributing brochure may contribute partially; member/bank/pulsa
// sections near the hub's end are the first dropped under pressure, the
// PM-accepted cut).
//
// Probed 2026-10-30 (322-research §2, D8): Cloudflare-fronted but
// unchallenged; WP REST is locked — never relied on. Structural churn goes
// red via ScrapeStructureError sentinels, never a silent zero.

import * as cheerio from 'cheerio'
import path from 'node:path'

import { Effect } from 'effect'

import type { StoreConfig } from '../config.js'
import { ScrapeStructureError, type FetchError } from '../fetch/errors.js'
import { renderPdfPages } from '../util/pdf.js'
import type { BrochurePage, BrochureStorePlugin, FetchContext } from './types.js'

// The promosi hub — the only entry point; per-brochure pages are discovered
// from its inline JS carriers (window.open literals + idToUrlMap values).
export const PROMOSI_HUB_URL = 'https://www.indomaret.co.id/promosi/'

// Scraped hrefs are external input: a modified hub must not aim the VPS job
// (and Gemini OCR) at arbitrary hosts, so only indomaret.co.id or a
// subdomain of it is fetched (verbatim isAllowedImageUrl pattern from
// superindo.ts).
const HOST_SUFFIX = 'indomaret.co.id'

export function isAllowedIndomaretUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === HOST_SUFFIX || host.endsWith(`.${HOST_SUFFIX}`)
  } catch {
    return false
  }
}

/** The hub page itself and the bare root are navigation, never brochures. */
function isDetailPath(url: string, hubUrl: string): boolean {
  try {
    const parsed = new URL(url)
    const hub = new URL(hubUrl)
    if (parsed.pathname === '/' || parsed.pathname === hub.pathname) return false
    // A detail page is slug-shaped (`/paling-murah/`); files carry extensions.
    const last = path.basename(parsed.pathname)
    return last.length > 0 && !last.includes('.')
  } catch {
    return false
  }
}

/**
 * Resolve a scraped candidate (relative or absolute) and keep it when it is
 * a same-host detail page.
 */
function candidateToDetailUrl(candidate: string, hubUrl: string): string | null {
  try {
    const resolved = new URL(candidate, hubUrl)
    const url = resolved.toString()
    if (!isAllowedIndomaretUrl(url)) return null
    if (!isDetailPath(url, hubUrl)) return null
    return url
  } catch {
    return null
  }
}

/**
 * Brochure detail-page URLs from the hub HTML, in hub document order,
 * order-preserving deduped. Three carriers (design-arch §1.2):
 *
 * 1. the per-brochure script blocks' `window.open("/slug/", "_blank")`
 *    literals (quoted literals only — the `idToUrlMap[id]` variable call
 *    never matches);
 * 2. the `idToUrlMap = { "brosur-x": "/slug/", … }` values;
 * 3. anchors inside the `[id^='brosur-']` section containers.
 *
 * The two JS carriers are the ones the live page ships (10 brochures on
 * 2026-10-30) and merge positionally — the map block sits between the
 * per-brochure scripts, so harvest order is true hub document order; the
 * cap therefore cuts the hub's tail, as the PM accepted (design-arch §1.2).
 * The anchor carrier covers the plausible Elementor evolution to plain
 * wrapped links. Nav links (/brand-kami, /layanan, …) ride none of the
 * carriers, and the same-host + slug-path filters drop anything else.
 */
export function parseBrochurePages(html: string, hubUrl: string = PROMOSI_HUB_URL): string[] {
  const $ = cheerio.load(html)
  const anchorCandidates: string[] = []
  $("[id^='brosur-'] a[href]").each((_, element) => {
    const href = $(element).attr('href')
    if (href) anchorCandidates.push(href)
  })

  // The JS carriers merge positionally: each match records its raw-HTML
  // offset, and the combined list sorts by it.
  const positioned: { at: number; url: string }[] = []
  for (const match of html.matchAll(/window\.open\(\s*(['"])(.*?)\1/g)) {
    positioned.push({ at: match.index ?? 0, url: match[2] })
  }
  for (const mapMatch of html.matchAll(/idToUrlMap\s*=\s*\{([^}]*)\}/g)) {
    const base = mapMatch.index ?? 0
    for (const entry of mapMatch[1].matchAll(/["']\s*:\s*["']([^"']+)["']/g)) {
      positioned.push({ at: base + (entry.index ?? 0), url: entry[1] })
    }
  }
  positioned.sort((a, b) => a.at - b.at)

  return [
    ...new Set(
      [...positioned.map((entry) => entry.url), ...anchorCandidates].flatMap((candidate) => {
        const url = candidateToDetailUrl(candidate, hubUrl)
        return url ? [url] : []
      })
    ),
  ]
}

/**
 * The brochure PDF URL from a detail page's Real3D-Flipbook config. The
 * page embeds several `pdfUrl":"…"` occurrences — the global JS template
 * carries an empty one and must never win — so: JSON-unescape each value,
 * skip empties, keep only same-host `.pdf` URLs, and take the first that
 * passes. Returns null when nothing passes (the caller sentinels).
 */
export function extractPdfUrl(html: string): string | null {
  for (const match of html.matchAll(/pdfUrl"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    let value = match[1]
    try {
      value = JSON.parse(`"${value}"`) as string
    } catch {
      // Malformed escape — fall back to the one escape the flipbook emits.
      value = value.replace(/\\\//g, '/')
    }
    if (!value) continue
    if (!isAllowedIndomaretUrl(value)) continue
    if (!value.toLowerCase().endsWith('.pdf')) continue
    return value
  }
  return null
}

/** `…/PalingMurah-29Okt.pdf` → `PalingMurah-29Okt` (the rendered filename base). */
export function pdfBasename(pdfUrl: string): string {
  return path.basename(new URL(pdfUrl).pathname, '.pdf')
}

export function createIndomaretPlugin(config: StoreConfig): BrochureStorePlugin {
  return {
    config,
    listBrochurePages(ctx: FetchContext): Effect.Effect<BrochurePage[], FetchError> {
      return Effect.gen(function* () {
        const hubHtml = yield* ctx.fetchHtml(PROMOSI_HUB_URL)
        const detailUrls = parseBrochurePages(hubHtml)
        if (detailUrls.length === 0) {
          return yield* new ScrapeStructureError({
            url: PROMOSI_HUB_URL,
            message:
              'Indomaret hub listed 0 brochure pages — the site structure changed ' +
              '(issue #322 sentinel: structural churn goes red, never a silent zero)',
          })
        }

        const renderPdf = ctx.renderPdf ?? renderPdfPages
        const pages: BrochurePage[] = []
        // The render-time budget (design-arch §1.2/§5): checked before each
        // next detail-page fetch, clamped into the render, so a PDF whose
        // pages would all be dropped is never downloaded or rasterized and
        // the last contributing brochure renders only the remaining pages.
        let budget = config.maxPages
        for (const detailUrl of detailUrls) {
          if (budget <= 0) break
          const detailHtml = yield* ctx.fetchHtml(detailUrl)
          const pdfUrl = extractPdfUrl(detailHtml)
          if (!pdfUrl) {
            return yield* new ScrapeStructureError({
              url: detailUrl,
              message:
                'Indomaret brochure page exposed no pdfUrl — the Real3D-Flipbook config ' +
                'changed (issue #322 sentinel: structural churn goes red, never a silent zero)',
            })
          }
          const pdf = yield* ctx.fetchDocument(pdfUrl)
          const renderedPages = yield* renderPdf(pdf.bytes, { maxPages: budget })
          // The plugin owns the budget: the slice backs the maxPages hint
          // passed to the renderer, so the cap holds even if a renderer
          // ignores it (the real one enforces it twice — util/pdf.ts).
          const rendered = renderedPages.slice(0, budget)
          const base = pdfBasename(pdfUrl)
          for (const page of rendered) {
            pages.push({
              imageUrl: pdfUrl,
              brochureUrl: detailUrl,
              bytes: page.bytes,
              filename: `${base}-page-${String(page.pageNo).padStart(2, '0')}.png`,
            })
          }
          budget -= rendered.length
        }
        return pages
      })
    },
  }
}
