// Port of haqita scripts/scrapers/lotte.py — promo flyer images from the
// "All Promo Mart" listing page by keyword matching. The listing page is
// fetched through the Tier-2 browser ladder (Incapsula); the image URLs it
// yields ride the plain tier (see createStoreFetcher).

import * as cheerio from 'cheerio'
import { Effect } from 'effect'

import type { StoreConfig } from '../config.js'
import type { FetchError } from '../fetch/strategy.js'
import type { BrochurePage, BrochureStorePlugin, FetchContext } from './types.js'

const LOTTE_URL = process.env.LOTTE_URL ?? 'https://www.lottemart.co.id/all-promo-mart'

const KEYWORDS = ['promo', 'flyer', 'catalog', 'katalog', 'ht']
const EXCLUDE_EXTENSIONS = ['.gif']

// Scraped srcs are external input: a modified page must not aim the VPS job
// (and Gemini OCR) at arbitrary hosts, so only lottemart.co.id or a
// subdomain of it is kept.
const IMAGE_HOST_SUFFIX = 'lottemart.co.id'

export function isAllowedLotteImageUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === IMAGE_HOST_SUFFIX || host.endsWith(`.${IMAGE_HOST_SUFFIX}`)
  } catch {
    return false
  }
}

/** Scheme-fix a scraped src: "//cdn…" → https, "/path…" → site-absolute. */
export function normalizeLotteSrc(src: string): string {
  if (src.startsWith('//')) return `https:${src}`
  if (src.startsWith('/')) return `https://www.lottemart.co.id${src}`
  return src
}

/**
 * Extract promo image URLs from the listing page HTML: <img> src/data-src,
 * keyword-filtered, .gif excluded, scheme-fixed, host-allowlisted,
 * order-preserving dedupe — haqita LotteScraper.collect_image_refs verbatim.
 */
export function parseLotteImages(html: string): string[] {
  const $ = cheerio.load(html)
  const urls: string[] = []
  $('img').each((_, img) => {
    const raw = $(img).attr('src') ?? $(img).attr('data-src')
    if (!raw) return
    const srcLower = raw.toLowerCase()
    if (EXCLUDE_EXTENSIONS.some((ext) => srcLower.endsWith(ext))) return
    if (!KEYWORDS.some((keyword) => srcLower.includes(keyword))) return
    const url = normalizeLotteSrc(raw)
    if (isAllowedLotteImageUrl(url) && !urls.includes(url)) urls.push(url)
  })
  return urls
}

export function createLottePlugin(config: StoreConfig): BrochureStorePlugin {
  return {
    config,
    listBrochurePages(ctx: FetchContext): Effect.Effect<BrochurePage[], FetchError> {
      return Effect.gen(function* () {
        const html = yield* ctx.fetchHtml(LOTTE_URL)
        const urls = parseLotteImages(html)
        return urls
          .slice(0, config.maxPages)
          .map((imageUrl) => ({ imageUrl, brochureUrl: LOTTE_URL }))
      })
    },
  }
}
