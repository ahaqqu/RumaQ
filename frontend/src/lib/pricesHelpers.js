// Pure derivations for the price explorer (issue #291). Everything here is
// side-effect free so the page stays a thin render layer over the backend's
// effective-price aggregates (291-design-pm.md §2, 291-design-arch.md §3.2).

import { prettyPromoText } from './productDisplay.js'
import { formatMoney } from './money.js'

// "Save X%" only fires at ≥5% — sub-5% cross-store gaps (≈ Rp 400 on
// Rp 20.000) badge half the catalog and devalue the badge (PM §3.2).
export const SAVE_PCT_THRESHOLD = 5

// The daily brochure scrape is stale-feeling past a day plus slack; matches
// the monitor page's "over a day old" convention (PM §3.5).
export const FRESH_WARN_MS = 26 * 60 * 60 * 1000

// Issue #627: when the retailer prints a member/app price beside the shelf
// price, the member price is the final payable price (Superindo/Lotte
// membership is free, so most buyers are members). The shelf `price` stays
// the visible reference. The basis mirrors the backend exactly:
// MIN(COALESCE(member_price, effective_unit_price, price),
//     COALESCE(effective_unit_price, price))
// — the member price wins when lower, but a member premium never RAISES the
// payable price above the shelf/promo basis.
export function hasMemberPrice(offer) {
  return offer?.member_price != null
}

// The shelf/promo basis: the promo-effective price when the source printed
// one, else the shelf price. Comparison uses this even without promo evidence
// (matching the backend); display trusts it only with evidence (PM §2).
function shelfBasisPrice(offer) {
  return offer?.effective_unit_price ?? offer?.price
}

export function effectivePrice(offer) {
  const shelf = shelfBasisPrice(offer)
  if (!hasMemberPrice(offer)) return shelf
  if (shelf == null) return offer.member_price
  return Math.min(offer.member_price, shelf)
}

export function hasPromoEvidence(offer) {
  return offer?.promo_type != null || offer?.promo_label != null
}

// The shelf price a shopper can actually pay without a membership: the
// promo-adjusted value only with real promo evidence AND an actual cut (ingest
// fixtures carry `price == effective_unit_price` alongside a label, and a bare
// `effective < price` check would strike through honest prices, PM §2), else
// the tag price. No evidence → the tag price.
function shelfDisplayPrice(offer) {
  if (
    hasPromoEvidence(offer) &&
    offer?.effective_unit_price != null &&
    offer.effective_unit_price < offer.price
  ) {
    return offer.effective_unit_price
  }
  return offer?.price
}

// The headline: the member price when it is at or below the shelf/promo basis
// (a member premium must never raise the displayed price), the promo price
// when a real promo is cheaper, else the shelf price.
export function displayPrice(offer) {
  const shelf = shelfDisplayPrice(offer)
  if (!hasMemberPrice(offer)) return shelf
  if (shelf == null) return offer.member_price
  return Math.min(offer.member_price, shelf)
}

// True only when the member price is the displayed price — the views use this
// to label the headline "Member price". A higher member price gets no badge
// (it is not the displayed price).
export function showsMemberPrice(offer) {
  return hasMemberPrice(offer) && displayPrice(offer) === offer.member_price
}

// The shelf reference beside the headline — returned only when the displayed
// price is genuinely lower than the shelf price, so it is struck exactly when
// it represents a saving a shopper without the deal would pay.
export function referencePrice(offer) {
  const shown = displayPrice(offer)
  if (offer?.price == null || shown == null || shown >= offer.price) return null
  return { price: offer.price, struck: true }
}

// Brochure footnote marker, not a promo (haqita filterPromos).
export function isFootnoteLabel(label) {
  return (label ?? '').trim().toLowerCase().startsWith('*harga')
}

// ——— Promo chip classes (issue #717) ———
// Presentation-only labels over the verbatim chip text: the OCR-QA report's
// promo-semantics families (ahaqqu/RumaQ-pipeline#164 F3/F4/F5 — dated promo
// prices, quantity limits, buy-get, conditional multi-buy) surfaced as class
// tags so the owner can review which chips belong to which family and decide
// how each should be handled. Nothing derives pricing behavior from these —
// the chip text itself is always rendered verbatim (no casing/whitespace
// normalization on the review surface).

// One class per chip segment; first match wins. Vocabulary is the observed
// brochure Indonesian (issue #717's sampled chips) plus the English BOGO
// phrasing the OCR prompt licenses ('BUY 1 GET 1'), matched case-insensitively.
export function promoChipClass(text) {
  const s = (text ?? '').toLowerCase()
  if (s.includes('harga promo')) return 'dated'
  if (
    (s.includes('beli') && (s.includes('gratis') || s.includes('free'))) ||
    (s.includes('buy') && s.includes('get'))
  ) {
    return 'bogo'
  }
  if (/beli\s*\d/.test(s)) return 'multiBuy'
  if (/(^|\s)maks\.?\s/.test(s)) return 'limit'
  if (s.includes('diskon') || s.includes('%')) return 'discount'
  if (s.includes('harga mulai') || s.includes('harga spesial') || s.includes('harga khusus')) {
    return 'priceLabel'
  }
  return 'other'
}

const PROMO_TONE_RULES = [
  { tone: 'danger', match: (s) => s.includes('diskon') || s.includes('%') },
  { tone: 'ok', match: (s) => s.includes('gratis') || s.includes('free') },
  { tone: 'warn', match: (s) => s.includes('dapat') || s.includes('beli') || s.includes('bonus') },
]

// Indonesian brochure vocabulary regardless of UI language (PM §3.2).
export function promoTone(label) {
  const haystack = (label ?? '').toLowerCase()
  for (const rule of PROMO_TONE_RULES) {
    if (rule.match(haystack)) return rule.tone
  }
  return 'muted'
}

// [{ text, tone }] for an offer's promo fields — promo_label first,
// promo_type as fallback text. Brochure labels pack several offers into one
// semicolon-joined string ("DISKON 50%;PROMO 1 HARI!"), so each non-empty,
// non-footnote segment becomes its own badge with its own tone (issue #633).
export function promoBadges(label, type) {
  const rawLabel = typeof label === 'string' ? label.trim() : ''
  if (!rawLabel) {
    return type ? [{ text: type, tone: promoTone(type) }] : []
  }

  const rawSegments = rawLabel
    .split(';')
    .map((segment) => segment.trim())
    .filter(Boolean)
  // A label of only separators is no label at all — keep the type fallback.
  if (rawSegments.length === 0) {
    return type ? [{ text: type, tone: promoTone(type) }] : []
  }

  return rawSegments
    .filter((segment) => !isFootnoteLabel(segment))
    .map((segment) => ({ text: prettyPromoText(segment), tone: promoTone(segment) }))
}

// Day-granularity countdown from a date-only valid_until, normalized to the
// shopper's local midnight. A bare 'YYYY-MM-DD' would parse as UTC midnight
// and shift the diff by the timezone offset, so anchor it to local time.
export function countdownState(validUntil, now = new Date()) {
  if (!validUntil) return null
  const until = new Date(`${validUntil}T00:00:00`)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.round((until.getTime() - today.getTime()) / 86_400_000)
  if (days < 0) return { type: 'expired', count: days }
  if (days === 0) return { type: 'today', count: 0 }
  return { type: 'days', count: days }
}

// Absolute-time age buckets for the freshness bar; UTC ISO timestamps need
// no timezone math, only elapsed-ms comparison (arch §4 FreshnessBar).
export function relativeAge(iso, now = new Date()) {
  if (!iso) return null
  const diffMs = now.getTime() - new Date(iso).getTime()
  if (diffMs < 60_000) return { key: 'justNow', count: 0 }
  if (diffMs < 3_600_000) return { key: 'minAgo', count: Math.floor(diffMs / 60_000) }
  if (diffMs < 86_400_000) return { key: 'hourAgo', count: Math.floor(diffMs / 3_600_000) }
  return { key: 'dayAgo', count: Math.floor(diffMs / 86_400_000) }
}

export function isFreshnessStale(iso, now = new Date(), warnMs = FRESH_WARN_MS) {
  if (!iso) return false
  return now.getTime() - new Date(iso).getTime() >= warnMs
}

export function savePctVisible(savingsPct) {
  return savingsPct != null && Math.round(savingsPct) >= SAVE_PCT_THRESHOLD
}

// Footer stats (PM §3.6): product counts per source present in the current
// filtered set, in chip-bar source order, plus how many products are matched
// at ≥2 sources. Counts agree with what is on screen because they derive
// from the same items the list renders.
export function buildFooterStats(items, sourceOrder) {
  const sourcesByProduct = new Map()
  for (const item of items ?? []) {
    const set = sourcesByProduct.get(item.product_key) ?? new Set()
    set.add(item.source_slug)
    sourcesByProduct.set(item.product_key, set)
  }
  const countBySource = new Map()
  for (const set of sourcesByProduct.values()) {
    for (const slug of set) {
      countBySource.set(slug, (countBySource.get(slug) ?? 0) + 1)
    }
  }
  const segments = []
  for (const { slug, name } of sourceOrder ?? []) {
    const count = countBySource.get(slug)
    if (count) segments.push({ slug, name, count })
  }
  let matched = 0
  for (const set of sourcesByProduct.values()) {
    if (set.size >= 2) matched += 1
  }
  return { segments, matched }
}

// TanStack Router exposes location.hash WITHOUT the leading '#', already
// decoded (router-core parseLocation → decodePath); navigate({ hash }) takes
// the same bare value. No second decode here — one throws on stray '%'
// (a hand-typed '#50%') during render and corrupts values like '%25'.
export function normalizeHash(rawHash) {
  if (!rawHash) return ''
  return rawHash.replace(/^#/, '')
}

// IDR display price — shared by the explorer and the promo catalog view
// (issue #292) so both pages format identically (Intl id-ID uses an NBSP
// between "Rp" and the amount). L9 (audit): this is the IDR-locked ALIAS of
// the one household money formatter (lib/money.js) — the implementation
// lives there, so the two formatters cannot drift again.
export function formatPrice(amount) {
  return formatMoney(amount)
}

// The end-user segments of /prices (issues #292/#673): ?view= selects one,
// absence or any other value means the Products explorer. Promos is no
// longer a /prices view — it moved to /admin/catalog in #673, and the old
// legacy vocabulary is hard-removed: no ?view= value is redirected, unknown
// values are simply unrecognized (validateSearch drops them and the resolver
// falls back to Products).
export const PRICE_CATALOG_VIEWS = ['brochures']

// Every ?view= the /prices route accepts. No legacy value: the route renders
// exactly what the catalog offers and silently falls back for anything else.
export const PRICE_ROUTE_VIEWS = PRICE_CATALOG_VIEWS

// A #productKey hash is the stronger intent (deep link) and forces the
// Products view regardless of ?view= (PM AC 7 / #293 AC 5).
export function resolvePriceView(view, hash) {
  if (hash) return 'products'
  return PRICE_CATALOG_VIEWS.includes(view) ? view : 'products'
}

// The three sections of the admin catalog (#673): Products is the admin-tools
// home (product lookup, rename, duplicate names, alias candidates); Brochures
// QA is the #630 ingestion-QA view; Promos is the promo catalog moved off
// /prices. ?tab= selects one; absence or any other value means Products —
// the silent fallback IS the hard-removal behavior for the retired brochures
// tab value.
export const ADMIN_CATALOG_TABS = ['products', 'brochures-qa', 'promos']

// The hash is the stronger intent here too: a #productKey deep link opens the
// Products tab so ProductsView's hash-apply effect can expand the product.
export function resolveCatalogTab(tab, hash) {
  if (hash) return 'products'
  return ADMIN_CATALOG_TABS.includes(tab) ? tab : 'products'
}

// "29 October 2026" for an observed_date, in the viewer's language. Shared by
// the admin QA view and the user-facing gallery + viewer (#673/#674) — the
// label contract must not drift between the surfaces.
export function observedDateLabel(date, language) {
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return date
  return parsed.toLocaleDateString(language, { day: 'numeric', month: 'long', year: 'numeric' })
}

// ——— Brochure full-mode viewer (#674) ———

/** The servable brochure_url shape (backend/src/lib/brochures.ts). */
export const BROCHURE_URL_PREFIX = '/api/brochures/'

// The /brochures/view deep link is structured (?store=&date=&file=) so each
// segment validates independently and the image src recomposes the canonical
// brochure_url byte-exactly — the catalog lookup for the title is then
// exact-match. The patterns mirror the server's parseBrochureKey charset
// (backend/src/lib/brochures.ts); the server additionally 404s unknown slugs
// (SCRAPE_STORE_SLUGS) and impossible dates, so a well-shaped but unknown
// link simply degrades to the viewer's in-frame fallback.
const VIEWER_DATE_PATTERN = /^\d{8}$/
const VIEWER_FILENAME_PATTERN = /^[A-Za-z0-9._()-]{1,200}$/
const VIEWER_STORE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// The router's default search parser JSON-parses digit-leading values
// (router-core's jsonStart regex matches \d), so a deep link ?date=20261115
// reaches validateSearch as a NUMBER. Normalize that round-trip back to a
// string before validating — the segments must be strings to recompose the
// brochure_url byte-exactly. (Non-numeric strings skip the parser and stay
// strings.)
function asSearchSegment(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return undefined
}

// validateSearch for /brochures/view: keep well-shaped segments, drop
// anything else (TanStack strips undefined values, so the page renders its
// calm missing-brochure state instead of requesting a URL that must 404).
//
// ?admin=true marks the viewer link as opened from the admin QA surface
// (issue #716): the card on /admin/catalog's brochures-qa tab composes it.
// The viewer additionally gates the QA variant on the session's isAdmin (the
// #673 identity rule — see BrochureViewerPage), so the flag alone never
// renders QA affordances. The Share button composes the plain viewer link
// without the flag.
export function resolveBrochureViewerSearch({ store, date, file, admin } = {}) {
  const rawStore = asSearchSegment(store)
  const rawDate = asSearchSegment(date)
  const rawFile = asSearchSegment(file)
  const rawAdmin = asSearchSegment(admin)
  return {
    store:
      rawStore !== undefined && rawStore.length <= 100 && VIEWER_STORE_PATTERN.test(rawStore)
        ? rawStore
        : undefined,
    date: rawDate !== undefined && VIEWER_DATE_PATTERN.test(rawDate) ? rawDate : undefined,
    file:
      rawFile !== undefined &&
      rawFile !== '.' &&
      rawFile !== '..' &&
      VIEWER_FILENAME_PATTERN.test(rawFile)
        ? rawFile
        : undefined,
    admin: rawAdmin === 'true' ? 'true' : undefined,
  }
}

// Split a canonical brochure_url into its three segments, or null for
// anything that is not the canonical shape. The gallery's View affordance
// recomposes them into the viewer deep link.
export function parseBrochureUrl(brochureUrl) {
  if (typeof brochureUrl !== 'string' || !brochureUrl.startsWith(BROCHURE_URL_PREFIX)) return null
  const segments = brochureUrl.slice(BROCHURE_URL_PREFIX.length).split('/')
  if (segments.length !== 3 || segments.some((segment) => segment === '')) return null
  const [store, date, file] = segments
  return { store, date, file }
}

// The viewer deep link for a brochure_url, or null when the URL is not the
// canonical shape (the card then renders no View affordance). { admin: true }
// appends ?admin=true marking the admin QA surface (issue #716) — the viewer
// still gates the QA variant on the session's isAdmin (#673).
export function brochureViewerUrl(brochureUrl, { admin = false } = {}) {
  const parsed = parseBrochureUrl(brochureUrl)
  if (!parsed) return null
  const { store, date, file } = parsed
  return `/brochures/view?store=${encodeURIComponent(store)}&date=${encodeURIComponent(
    date
  )}&file=${encodeURIComponent(file)}${admin ? '&admin=true' : ''}`
}
