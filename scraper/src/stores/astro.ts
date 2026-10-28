// Astro (astronauts.id) — quick-commerce catalog store, the first plugin for
// the catalog capability (docs/plan/haqita-integration.md §6): structured
// items straight off the category page, no brochure images and no Gemini OCR.
//
// How the listing works (probed 2026-10-28): each category page
// server-renders page 0 (30 items) and embeds the inventory API response as
// raw JSON inside the Next.js flight stream
// (self.__next_f.push([1,"..."])). The client's own XHRs are useless to us —
// api.astronauts.id gates every direct call behind an app-version check
// (error_code EC1001, "Aplikasi kamu perlu di-update dulu") plus a device
// fingerprint header, but the SSR route needs neither. So the plugin is a
// Tier-1 plain fetch of the category pages, then a JSON extraction.
//
// Promo mechanics visible per product:
// - inventory discount: product_discount_price (post-discount) +
//   product_discount_percentage, quota-limited (product_discount_stock,
//   product_discount_daily_quota);
// - tier discount: inventory_discount_tier_label ("Beli 2 Disc.4%" with the
//   per-unit final_price at that qty);
// - voucher_labels exist but are empty on category listings in practice.
//
// Mapping: price = post-discount price (same convention as the OCR prompt —
// the listed price is what the customer pays), promo labels go through
// parsePromo ("Diskon 8%" → discount_pct, effective = the discounted price).
// Tier labels are preserved as promo text only: they are conditional on
// buying N units. The observed "Disc.%" phrasing matches no parsePromo
// pattern, so they stay `single` (no effective unit price) — a tier label
// phrased like a standard promo ("Beli 2 Gratis 1") would claim its math,
// exactly like the OCR path's conditional brochure promos.

import { Effect } from 'effect'

import type { StoreConfig } from '../config.js'
import type { FetchError } from '../fetch/errors.js'
import type { CatalogItem, CatalogStorePlugin, FetchContext } from './types.js'

// One page per RumaQ v1 staple: beras (local + import), minyak goreng,
// daging ayam (cut parts + whole bird). The listing server-renders only page
// 0 (30 items) — deeper pages would need the version-gated API — so 30 per
// category is the v1 coverage. Overridable without a redeploy via
// ASTRO_CATEGORY_PAGES (see resolveCategoryPages).
const DEFAULT_CATEGORY_PAGES = [
  'https://www.astronauts.id/c/kebutuhan-pokok-2721/beras-lokal-5858',
  'https://www.astronauts.id/c/kebutuhan-pokok-2721/beras-import-5859',
  'https://www.astronauts.id/c/kebutuhan-pokok-2721/minyak-goreng-25060',
  'https://www.astronauts.id/c/ayam-unggas-7179/ayam-parting-7181',
  'https://www.astronauts.id/c/ayam-unggas-7179/ayam-utuh-7182',
]

// The parent category segment is part of the page path (/c/beras-lokal-5858
// 404s), so the override takes full URLs, comma-separated — the same
// full-URL override shape as Lotte's LOTTE_URL. Scraped-target discipline
// still applies: only astronauts.id hosts are accepted, and an override
// with no valid entries falls back to the defaults instead of silently
// scraping nothing.
const CATEGORY_PAGES_ENV = 'ASTRO_CATEGORY_PAGES'
const CATEGORY_HOST_SUFFIX = 'astronauts.id'

export function isAllowedCategoryUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === CATEGORY_HOST_SUFFIX || host.endsWith(`.${CATEGORY_HOST_SUFFIX}`)
  } catch {
    return false
  }
}

export function resolveCategoryPages(
  env: string | undefined = process.env[CATEGORY_PAGES_ENV]
): string[] {
  const parsed = (env ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url.length > 0 && isAllowedCategoryUrl(url))
  const unique = [...new Set(parsed)]
  return unique.length > 0 ? unique : DEFAULT_CATEGORY_PAGES
}

export interface AstroTierLabel {
  label?: string
  qty?: number
  final_price?: number
}

/**
 * The product fields the plugin consumes; the API response has more. The
 * flight text is only ever cast to this shape (`JSON.parse … as AstroProduct`),
 * so toCatalogItem re-checks every free-form field at runtime — a malformed
 * value skips the item, it never throws.
 */
export interface AstroProduct {
  product_id: number
  product_name?: string
  /** Observed as strings; a number is tolerated (parseInt coerces). */
  product_price?: string | number
  product_discount_price?: string | number
  product_discount_percentage?: string
  product_grammation_label?: string
  inventory_discount_tier_label?: AstroTierLabel[]
}

/**
 * Join the RSC flight stream back into one text: every
 * self.__next_f.push([1,"..."]) literal is a JS string; JSON.parse of the
 * literal undoes the escaping exactly.
 */
export function extractFlightChunks(html: string): string {
  const literal = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g
  let joined = ''
  let match: RegExpExecArray | null
  while ((match = literal.exec(html))) {
    try {
      joined += JSON.parse(match[1]!) as string
    } catch {
      // A truncated push literal must not kill the rest of the stream.
    }
  }
  return joined
}

/**
 * Extract the inventory product objects from the flight text. Objects are
 * located structurally, not by a first-key anchor: the API's key order
 * varies between responses, so the only stable fact is that every product
 * object is the innermost {...} enclosing a variantRelativeProductIds key.
 * One string-aware scan records each brace's matching close, then each key
 * occurrence is resolved to its innermost enclosing object and parsed.
 */
export function parseProductObjects(flight: string): AstroProduct[] {
  const KEY = 'variantRelativeProductIds'

  // Occurrences of the key as a JSON key — the full quoted string, followed
  // by a colon. A mention inside a string value is prose, not a key: it must
  // not resolve to its enclosing object (a product-field mention would
  // double-parse it; the state machine below cannot tell a key string from a
  // value string).
  const occurrences: number[] = []
  let searchFrom = 0
  while (true) {
    const at = flight.indexOf(KEY, searchFrom)
    if (at < 0) break
    searchFrom = at + KEY.length
    if (flight[at - 1] !== '"') continue
    let after = at + KEY.length
    if (flight[after] !== '"') continue
    after++
    while (after < flight.length && /\s/.test(flight[after]!)) after++
    if (flight[after] === ':') occurrences.push(at)
  }
  if (occurrences.length === 0) return []

  // Single scan: stack of open-brace positions, close position per open.
  const openBraces: number[] = []
  const closeOf = new Map<number, number>()
  const innermostOf = new Map<number, number>() // key occurrence -> enclosing open brace
  let inString = false
  let escaped = false
  let occPtr = 0
  for (let i = 0; i < flight.length; i++) {
    // Record the enclosing object for every key occurrence the scan passes.
    while (occPtr < occurrences.length && i >= occurrences[occPtr]!) {
      const innermost = openBraces[openBraces.length - 1]
      if (innermost !== undefined) innermostOf.set(occurrences[occPtr]!, innermost)
      occPtr++
    }
    const char = flight[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') openBraces.push(i)
    else if (char === '}') {
      const open = openBraces.pop()
      if (open !== undefined) closeOf.set(open, i + 1)
    }
  }

  const products: AstroProduct[] = []
  for (const occurrence of occurrences) {
    const open = innermostOf.get(occurrence)
    const end = open !== undefined ? closeOf.get(open) : undefined
    if (open === undefined || end === undefined) continue // truncated — skip
    try {
      const product = JSON.parse(flight.slice(open, end)) as AstroProduct
      if (typeof product.product_id === 'number') products.push(product)
    } catch {
      // A shape this parser doesn't understand is skipped, not fatal —
      // the other pages' items still publish.
    }
  }
  return products
}

/** Post-discount price as an integer, or null when the field is unusable. */
function toRupiah(raw: string | number | undefined): number | null {
  if (!raw) return null
  const value = Number.parseInt(String(raw), 10)
  return Number.isFinite(value) && value > 0 ? value : null
}

export function toCatalogItem(product: AstroProduct, pageUrl: string): CatalogItem | null {
  // Every free-form field is re-checked: the flight text is cast, not
  // validated, so a non-string value here must skip the item — a throw would
  // be an Effect defect, which the pipeline's per-store isolation (typed
  // errors only) does not catch.
  const name = typeof product.product_name === 'string' ? product.product_name.trim() : ''
  const basePrice = toRupiah(product.product_price)
  if (name.length === 0 || basePrice === null) return null

  const discountPrice = toRupiah(product.product_discount_price)
  const price = discountPrice ?? basePrice

  const promoParts: string[] = []
  if (
    discountPrice !== null &&
    product.product_discount_percentage &&
    typeof product.product_discount_percentage === 'string'
  ) {
    promoParts.push(`Diskon ${product.product_discount_percentage.trim()}`)
  }
  const tiers = (product.inventory_discount_tier_label ?? [])
    .filter((tier): tier is AstroTierLabel & { label: string } => typeof tier.label === 'string')
    .sort((a, b) => (a.final_price ?? 0) - (b.final_price ?? 0))
  for (const tier of tiers) promoParts.push(tier.label)

  return {
    name,
    brand: null, // the listing carries only a brandId, no brand name
    unit:
      typeof product.product_grammation_label === 'string'
        ? product.product_grammation_label.trim() || null
        : null,
    price,
    promoLabels: promoParts.length > 0 ? promoParts : null,
    validFrom: null,
    validUntil: null,
    pageUrl,
  }
}

export function createAstroPlugin(config: StoreConfig): CatalogStorePlugin {
  // Resolved once per plugin build: the env var is read at creation time so
  // tests can stub it per case instead of at module import.
  const categoryPages = resolveCategoryPages()
  return {
    config,
    listItems(ctx: FetchContext): Effect.Effect<CatalogItem[], FetchError> {
      return Effect.gen(function* () {
        const items: CatalogItem[] = []
        const seen = new Set<number>()
        for (const url of categoryPages.slice(0, config.maxPages)) {
          const html = yield* ctx.fetchHtml(url)
          for (const product of parseProductObjects(extractFlightChunks(html))) {
            // The flight can carry the same product twice (SSR + widget
            // copies); the ingest upsert dedupes anyway, but one item per
            // product keeps the payload clean.
            if (seen.has(product.product_id)) continue
            seen.add(product.product_id)
            const item = toCatalogItem(product, url)
            if (item) items.push(item)
          }
        }
        return items
      })
    },
  }
}
