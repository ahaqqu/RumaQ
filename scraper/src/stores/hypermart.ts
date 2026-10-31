// Hypermart promo-koran — the superindo shape (issue #322, design-arch
// §1.1): brochure page images on the plain tier, zero new pipeline
// engineering. The weekly koran is an Elementor media carousel on
// /promo-koran/ whose full-page JPGs are all present in the static HTML
// through two carriers per slide — the lightbox anchor's href and the lazy
// div's data-wpfc-original-src (WP Fastest Cache, whose value is
// HTML-escaped and wrapped in literal quotes: '&#039;…jpg&#039;').
//
// Probed 2026-10-30 (322-research §3): zero anti-bot (plain LiteSpeed /
// WordPress origin), no hotlink protection, no pagination — the carousel is
// the entire koran (~11 pages). Filenames (JAWA-N.jpg under a month path)
// are refreshed IN PLACE weekly (last-modified moves, cache-control
// max-age=604800), so novelty must key on the pipeline's content MD5, never
// on the URL — fetch/state.ts already does exactly that (design-arch §3),
// pinned by the same-URL-new-bytes regression test in test/fetch/state.test.ts.

import * as cheerio from 'cheerio'
import path from 'node:path'

import { Effect } from 'effect'

import type { StoreConfig } from '../config.js'
import type { FetchError } from '../fetch/errors.js'
import type { BrochurePage, BrochureStorePlugin, FetchContext } from './types.js'

// The default ALL JAWA hub — the region picker's 23 sibling pages are a
// store-side navigation, not a RumaQ feature (design-pm §3.1 scope cut).
export const KORAN_HUB_URL = 'https://www.hypermart.co.id/promo-koran/'

// Scraped hrefs are external input: a modified carousel must not aim the VPS
// job (and Gemini OCR) at arbitrary hosts, so only hypermart.co.id or a
// subdomain of it is fetched (verbatim isAllowedImageUrl pattern from
// superindo.ts).
const IMAGE_HOST_SUFFIX = 'hypermart.co.id'

// The carousel lives inside the WordPress uploads tree; anything else
// (theme assets, elementor CSS) is not koran content.
const UPLOADS_PATH = '/wp-content/uploads/'

// The semantic identity of a koran page: basename JAWA-*.jpg. The glob —
// not Elementor/swiper class names — is the stable contract: it filters the
// hub's other carousels (PROMO-BANK-*-scaled.jpg) out of the harvest and
// excludes the stale-2020 JAWA-8.pdf download decoy by construction (the
// .jpg extension filter rejects it; the download buttons are never scraped).
const KORAN_BASENAME = /^JAWA-.*\.jpg$/i

/**
 * All four harvest filters (design-arch §1.1) in one predicate: host
 * allowlist, uploads path, .jpg extension, JAWA-* basename.
 */
export function isAllowedKoranImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    const hostAllowed = host === IMAGE_HOST_SUFFIX || host.endsWith(`.${IMAGE_HOST_SUFFIX}`)
    return (
      hostAllowed &&
      parsed.pathname.toLowerCase().startsWith(UPLOADS_PATH) &&
      parsed.pathname.toLowerCase().endsWith('.jpg') &&
      KORAN_BASENAME.test(path.basename(parsed.pathname))
    )
  } catch {
    return false
  }
}

/**
 * WP Fastest Cache stores the lazy value quote-wrapped and HTML-escaped
 * (&#039;https://…jpg&#039;); cheerio decodes the entities, leaving literal
 * quotes around the URL — strip them before the URL parses.
 */
export function cleanWpfcValue(value: string): string {
  return value
    .trim()
    .replace(/^['"]+/, '')
    .replace(/['"]+$/, '')
}

/**
 * Harvest candidate koran URLs from the hub HTML from BOTH carriers the
 * Elementor carousel renders — lightbox anchor hrefs AND
 * div[data-wpfc-original-src] values — then keep only URLs that pass all
 * four filters, order-preserving deduped. Keying on the glob instead of
 * swiper class names is deliberate churn-proofing on a site we do not
 * control; order = first appearance in DOM order (slide order = page order
 * 1..N).
 */
export function parseKoranImages(html: string): string[] {
  const $ = cheerio.load(html)
  const candidates: string[] = []
  $('a[href], [data-wpfc-original-src]').each((_, element) => {
    const href = $(element).attr('href')
    if (href) candidates.push(href)
    const lazy = $(element).attr('data-wpfc-original-src')
    if (lazy) candidates.push(cleanWpfcValue(lazy))
  })
  return [...new Set(candidates.filter(isAllowedKoranImageUrl))]
}

export function createHypermartPlugin(config: StoreConfig): BrochureStorePlugin {
  return {
    config,
    listBrochurePages(ctx: FetchContext): Effect.Effect<BrochurePage[], FetchError> {
      return Effect.gen(function* () {
        const html = yield* ctx.fetchHtml(KORAN_HUB_URL)
        const urls = parseKoranImages(html)
        return urls
          .slice(0, config.maxPages)
          .map((imageUrl) => ({ imageUrl, brochureUrl: KORAN_HUB_URL }))
      })
    },
  }
}
