// Alfamart (alfagift.id) — the first `catalog` + `browser` store (issue
// #322, design-arch §1.3). The site is a Nuxt shell whose gateway API is
// fingerprint-gated (FingerprintJS visitorId on every call); an anonymous
// headless browser renders everything, so the structured data is scraped
// from the rendered DOM — catalog semantics (astro): no OCR, no R2, no
// novelty state, items straight to validation.
//
// DOM contract — anchored on the site's own URL grammar, never on class
// names (Elementor/Nuxt churn kills class-based selectors):
//   - campaign links: anchors whose href matches /promo/{slug}, on the
//     /promo listing (freshest first — verified once at bring-up, see the
//     fixture test; the code commits to DOM listing order);
//   - product links: anchors whose href matches /p/{slug}-{id}; each
//     product anchor's card is found by a bounded ancestor climb (≤ 5
//     levels) to the nearest container that also carries an Rp price.
// Sentinels: zero campaign links on the listing and zero product anchors on
// a campaign page fail with ScrapeStructureError — structural churn goes
// red, never silently zero (a gateway 401 leaves no cards; the red store is
// the ops signal, ALFAMART_PROXY_URL the day-one fix).
//
// Probed 2026-10-30/31 (322-research §1): the shell and static assets serve
// to plain curl, but promo content exists only post-hydration — browser
// tier only; no anti-bot on the web shell itself.

import * as cheerio from 'cheerio'

import { Effect } from 'effect'

import type { StoreConfig } from '../config.js'
import { ScrapeStructureError, type FetchError } from '../fetch/errors.js'
import type { CatalogItem, CatalogStorePlugin, FetchContext } from './types.js'

export const PROMO_LISTING_URL = 'https://alfagift.id/promo'

// The waitForSelector anchors ARE the URL grammar (churn-proof by design).
export const CAMPAIGN_ANCHOR_SELECTOR = 'a[href^="/promo/"]'
export const PRODUCT_ANCHOR_SELECTOR = 'a[href^="/p/"]'

// Scraped hrefs are external input: only alfagift.id or a subdomain of it
// is followed (verbatim isAllowedImageUrl pattern from superindo.ts).
const HOST_SUFFIX = 'alfagift.id'

export function isAllowedAlfagiftUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === HOST_SUFFIX || host.endsWith(`.${HOST_SUFFIX}`)
  } catch {
    return false
  }
}

/**
 * Campaign href grammar: /promo/{slug} — at least one non-empty segment
 * after /promo/ (the live site also ships sub-directory slugs like
 * /promo/S-26-Procal/Promise-Gold-…); the bare listing never matches.
 */
function isCampaignHref(pathname: string): boolean {
  return pathname.startsWith('/promo/') && pathname.length > '/promo/'.length
}

/** Product href grammar: /p/{slug}-{id} — the id segment is numeric. */
function isProductHref(pathname: string): boolean {
  return /^\/p\/[a-z0-9-]+-\d+$/.test(pathname)
}

/**
 * Campaign detail URLs from the listing DOM, in DOM order, order-preserving
 * deduped, host-allowlisted, off-grammar and off-host hrefs dropped. The
 * freshness contract: the listing sorts fresh campaigns first (verified
 * against the saved fixture at bring-up — the first entries are the
 * currently-active campaigns); the code commits to DOM listing order, no
 * date parsing from slug grammar.
 */
export function parsePromoCampaigns(html: string): string[] {
  const $ = cheerio.load(html)
  const campaigns: string[] = []
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href')
    if (!href) return
    try {
      const resolved = new URL(href, PROMO_LISTING_URL)
      if (!isAllowedAlfagiftUrl(resolved.toString())) return
      if (!isCampaignHref(resolved.pathname)) return
      const url = resolved.origin + resolved.pathname
      if (!campaigns.includes(url)) campaigns.push(url)
    } catch {
      // Malformed href — never a candidate.
    }
  })
  return campaigns
}

/** One parsed product card — the normalization input (design-arch §1.3). */
export interface AlfamartCard {
  /** Product href (/p/{slug}-{id}) — the within-run dedupe key. */
  productHref: string
  name: string
  /** The promo (post-discount) price in integer IDR. */
  price: number
  /** Discount percent from the card's badge, null when the card shows none. */
  discountPct: number | null
  /** Card image URL (extracted for the fixture contract; no CatalogItem field). */
  imageUrl: string | null
}

/**
 * Strip price/percent fragments from a candidate name and collapse
 * whitespace — "5% FILMA Minyak Goreng Pouch 2 L" survives as the name.
 */
function cleanName(text: string): string {
  return text
    .replace(/Rp[\s\u00a0]*[\d.,]+/gi, ' ')
    .replace(/\d+\s*%/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseIdr(match: string): number {
  // Indonesian dot-thousands: "43.700" → 43700.
  return Number(match.replace(/\./g, ''))
}

/**
 * Product cards from a campaign detail page. Each /p/{slug}-{id} anchor is
 * the card primitive: a bounded ancestor climb (≤ 5 levels) finds the
 * nearest container that also carries an Rp price; fields are probed within
 * that container only. The listed price is what the customer pays — the
 * LAST Rp in card order (the strikethrough original renders before the
 * post-discount price; pinned by the fixture). A card with no parseable
 * price is rejected, never guessed.
 */
export function parseProductCards(html: string): AlfamartCard[] {
  const $ = cheerio.load(html)
  type Node = ReturnType<typeof $>
  const cards: AlfamartCard[] = []
  const seen = new Set<string>()

  const priceIn = ($node: Node): number | null => {
    const matches = [...$node.text().matchAll(/Rp[\s\u00a0]*([\d.]+)/gi)]
    const last = matches.at(-1)
    return last ? parseIdr(last[1]) : null
  }

  $('a[href]').each((_, anchorElement) => {
    const anchor = $(anchorElement)
    const href = anchor.attr('href')
    if (!href) return
    let productHref: string | null = null
    try {
      const resolved = new URL(href, PROMO_LISTING_URL)
      if (!isAllowedAlfagiftUrl(resolved.toString())) return
      if (!isProductHref(resolved.pathname)) return
      productHref = resolved.pathname
    } catch {
      return
    }
    if (seen.has(productHref)) return

    // Bounded ancestor climb: the anchor itself already carries the prices
    // on alfagift (the card wraps it), so level 0 usually wins.
    let card: Node | null = null
    let node: Node = anchor
    for (let level = 0; level <= 5 && node.length > 0; level++) {
      if (priceIn(node) !== null) {
        card = node
        break
      }
      node = node.parent()
    }
    if (!card) return

    const price = priceIn(card)
    if (price === null) return

    // Name: the first heading-like text line in the card, price fragments
    // stripped — never keyed on class names.
    let name = ''
    card.find('p, h1, h2, h3, h4, h5, h6').each((_, nameElement) => {
      if (name) return
      const candidate = cleanName($(nameElement).text() ?? '')
      if (candidate.length >= 3) name = candidate
    })
    if (!name) return

    const discountMatch = card.text().match(/(\d+)\s*%/)
    const image = card.find('img[src]').first().attr('src') ?? null

    seen.add(productHref)
    cards.push({
      productHref,
      name,
      price,
      discountPct: discountMatch ? Number(discountMatch[1]) : null,
      imageUrl: image && isAllowedAlfagiftUrl(image) ? image : null,
    })
  })

  return cards
}

/** AlfamartCard → the catalog item the pipeline validates (astro semantics). */
export function toCatalogItem(card: AlfamartCard, campaignUrl: string): CatalogItem {
  return {
    name: card.name,
    brand: null,
    unit: null,
    price: card.price,
    // parsePromo's /diskon\s+(\d+)\s*%/ pattern claims discount_pct with
    // zero new parser code (design-arch §1.3).
    promoLabels: card.discountPct !== null ? [`Diskon ${card.discountPct}%`] : null,
    validFrom: null,
    validUntil: null,
    // The CAMPAIGN URL is the deep link: one campaign = one outbox batch
    // keyed by page; per-product /p/ deep links need a CatalogItem contract
    // extension — deferred (PM §6.4).
    pageUrl: campaignUrl,
  }
}

export function createAlfamartPlugin(config: StoreConfig): CatalogStorePlugin {
  return {
    config,
    listItems(ctx: FetchContext): Effect.Effect<CatalogItem[], FetchError> {
      return Effect.gen(function* () {
        const listing = yield* ctx.fetchRendered(PROMO_LISTING_URL, {
          waitForSelector: CAMPAIGN_ANCHOR_SELECTOR,
        })
        const campaigns = parsePromoCampaigns(listing)
        if (campaigns.length === 0) {
          return yield* new ScrapeStructureError({
            url: PROMO_LISTING_URL,
            message:
              'Alfamart listing showed 0 promo campaigns — the site structure changed ' +
              'or the gateway gated the browser (issue #322 sentinel: never a silent zero)',
          })
        }

        // Chromium visit budget = maxPages campaign visits/cycle (design-arch
        // §5): the slice happens BEFORE any detail visit, so the budget is
        // hard-bounded at 1 + maxPages navigations regardless of how many
        // campaigns are live.
        const items: CatalogItem[] = []
        const seenHrefs = new Set<string>()
        for (const campaignUrl of campaigns.slice(0, config.maxPages)) {
          const detail = yield* ctx.fetchRendered(campaignUrl, {
            waitForSelector: PRODUCT_ANCHOR_SELECTOR,
          })
          const cards = parseProductCards(detail)
          if (cards.length === 0) {
            return yield* new ScrapeStructureError({
              url: campaignUrl,
              message:
                'Alfamart campaign page rendered 0 product cards — the site structure ' +
                'changed or the gateway gated the browser ' +
                '(issue #322 sentinel: never a silent zero)',
            })
          }
          for (const card of cards) {
            // Within-run dedupe key: the product href (astro's product_id
            // has no DOM equivalent; campaigns overlap on shared promos).
            if (seenHrefs.has(card.productHref)) continue
            seenHrefs.add(card.productHref)
            items.push(toCatalogItem(card, campaignUrl))
          }
        }
        return items
      })
    },
  }
}
