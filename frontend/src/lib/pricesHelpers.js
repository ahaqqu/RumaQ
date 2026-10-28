// Pure derivations for the price explorer (issue #291). Everything here is
// side-effect free so the page stays a thin render layer over the backend's
// effective-price aggregates (291-design-pm.md §2, 291-design-arch.md §3.2).

// "Save X%" only fires at ≥5% — sub-5% cross-store gaps (≈ Rp 400 on
// Rp 20.000) badge half the catalog and devalue the badge (PM §3.2).
export const SAVE_PCT_THRESHOLD = 5

// The daily brochure scrape is stale-feeling past a day plus slack; matches
// the monitor page's "over a day old" convention (PM §3.5).
export const FRESH_WARN_MS = 26 * 60 * 60 * 1000

export function effectivePrice(offer) {
  return offer?.effective_unit_price ?? offer?.price
}

export function hasPromoEvidence(offer) {
  return offer?.promo_type != null || offer?.promo_label != null
}

// Show the promo-adjusted price only with real promo evidence AND an actual
// cut: ingest fixtures carry `price == effective_unit_price` alongside a
// label, and a bare `effective < price` check would strike through honest
// prices (PM §2). No evidence → the tag price is the display price.
export function displayPrice(offer) {
  if (hasPromoEvidence(offer) && effectivePrice(offer) < offer?.price) {
    return effectivePrice(offer)
  }
  return offer?.price
}

// Brochure footnote marker, not a promo (haqita filterPromos).
export function isFootnoteLabel(label) {
  return (label ?? '').trim().toLowerCase().startsWith('*harga')
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
// promo_type as fallback text; footnote lines render no badge.
export function promoBadges(label, type) {
  const text = label ?? type
  if (!text || isFootnoteLabel(text)) return []
  return [{ text, tone: promoTone(text) }]
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
// between "Rp" and the amount).
export function formatPrice(amount) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
  }).format(amount)
}

// The catalog segments of /prices (issues #292/#293): ?view= selects one,
// absence or any other value means the Products explorer. One definition —
// the route's validateSearch and the page shell resolve the active view
// from it, so adding a segment is a one-line change here.
export const PRICE_CATALOG_VIEWS = ['promos', 'brochures']

// A #productKey hash is the stronger intent (deep link) and forces the
// Products view regardless of ?view= (PM AC 7 / #293 AC 5).
export function resolvePriceView(view, hash) {
  if (hash) return 'products'
  return PRICE_CATALOG_VIEWS.includes(view) ? view : 'products'
}
