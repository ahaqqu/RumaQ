// Port of haqita scripts/scrapers/superindo.py — brochure pages from
// "Katalog Super Hemat" + "Promo Koran", filtered to the jabodetabek region
// via the fancybox gallery attribute.

import * as cheerio from 'cheerio'
import { Effect } from 'effect'

import type { StoreConfig } from '../config.js'
import type { FetchError } from '../fetch/strategy.js'
import type { BrochurePage, BrochureStorePlugin, FetchContext } from './types.js'

const KATALOG_URL = 'https://www.superindo.co.id/promosi/katalog-super-hemat/'
const KORAN_URL = 'https://www.superindo.co.id/promosi/promo-koran/'

// Region gallery on the katalog page; koran page has its own gallery.
const REGION_FILTER = 'jabodetabek-palembang'
const KORAN_FILTER = 'promo-koran'

// Scraped hrefs are external input: a modified gallery must not aim the VPS
// job (and Gemini OCR) at arbitrary hosts, so only superindo.co.id or a
// subdomain of it is fetched.
const IMAGE_HOST_SUFFIX = 'superindo.co.id'

export function isAllowedImageUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === IMAGE_HOST_SUFFIX || host.endsWith(`.${IMAGE_HOST_SUFFIX}`)
  } catch {
    return false
  }
}

/** Parse swiper-slide fancybox links filtered by data-fancybox value. */
export function parseSwiperImages(html: string, fancyboxFilter: string): string[] {
  const $ = cheerio.load(html)
  const urls: string[] = []
  $('.swiper-slide').each((_, slide) => {
    const link = $(slide).find('a.fancybox').first()
    if (link.length === 0) return
    if (link.attr('data-fancybox') !== fancyboxFilter) return
    const href = link.attr('href')
    if (href && isAllowedImageUrl(href)) urls.push(href)
  })
  return urls
}

/** Deduplicate URLs while preserving order. */
export function dedupeUrls(urls: string[]): string[] {
  return [...new Set(urls)]
}

export function createSuperindoPlugin(config: StoreConfig): BrochureStorePlugin {
  return {
    config,
    listBrochurePages(ctx: FetchContext): Effect.Effect<BrochurePage[], FetchError> {
      return Effect.gen(function* () {
        const pages: BrochurePage[] = []
        for (const url of [KATALOG_URL, KORAN_URL]) {
          const html = yield* ctx.fetchHtml(url)
          const filter = url.toLowerCase().includes('promo-koran') ? KORAN_FILTER : REGION_FILTER
          const urls = dedupeUrls(parseSwiperImages(html, filter))
          for (const imageUrl of urls) {
            pages.push({ imageUrl, brochureUrl: url })
          }
        }
        return pages.slice(0, config.maxPages)
      })
    },
  }
}
