import { describe, it, expect } from 'vite-plus/test'
import {
  displayPrice,
  effectivePrice,
  hasMemberPrice,
  hasPromoEvidence,
  referencePrice,
  showsMemberPrice,
  promoBadges,
  promoTone,
  isFootnoteLabel,
  countdownState,
  relativeAge,
  isFreshnessStale,
  savePctVisible,
  buildFooterStats,
  normalizeHash,
  resolvePriceView,
  resolveCatalogTab,
} from './pricesHelpers.js'

// Fixed instants: midday local so local-midnight normalization is exercised,
// and a clean UTC hour for the absolute-time age buckets.
const NOW = new Date(2026, 9, 29, 12, 0, 0) // 2026-10-29 12:00 local
const NOW_ISO = '2026-10-29T12:00:00Z'

describe('displayPrice', () => {
  it('returns the tag price without promo evidence', () => {
    expect(displayPrice({ price: 21500 })).toBe(21500)
  })

  it('shows the effective price only with promo evidence and a real cut', () => {
    const offer = { price: 41000, effective_unit_price: 36000, promo_label: 'Diskon 12%' }
    expect(displayPrice(offer)).toBe(36000)
  })

  it('keeps the tag price when a label rides along with no actual cut', () => {
    // The ingest fixture carries price == effective_unit_price next to a
    // promo label — striking the tag through would be dishonest.
    const offer = { price: 21500, effective_unit_price: 21500, promo_label: 'Diskon 5%' }
    expect(displayPrice(offer)).toBe(21500)
  })

  it('keeps the tag price when an effective value exists without promo evidence', () => {
    const offer = { price: 41000, effective_unit_price: 36000 }
    expect(displayPrice(offer)).toBe(41000)
  })
})

// Issue #627: the member/app price is the headline and comparison basis when
// it is LOWER; a member premium must never raise the payable price above the
// shelf/promo basis. The shelf price becomes the struck reference.
describe('member price', () => {
  it('detects a printed member price, not null/undefined', () => {
    expect(hasMemberPrice({ member_price: 19900 })).toBe(true)
    expect(hasMemberPrice({ member_price: 0 })).toBe(true)
    expect(hasMemberPrice({ member_price: null })).toBe(false)
    expect(hasMemberPrice({})).toBe(false)
  })

  it('compares on MIN(member, shelf/promo), never letting a premium raise it', () => {
    expect(effectivePrice({ price: 21500, member_price: 19900 })).toBe(19900)
    expect(effectivePrice({ price: 21500, member_price: null, effective_unit_price: 20500 })).toBe(
      20500
    )
    expect(effectivePrice({ price: 21500, member_price: null, effective_unit_price: null })).toBe(
      21500
    )
    // Member premium: the shelf price stays the compared price.
    expect(effectivePrice({ price: 21500, member_price: 24900 })).toBe(21500)
    // Promo-effective lower than the member price wins the comparison.
    expect(effectivePrice({ price: 21500, member_price: 19900, effective_unit_price: 18000 })).toBe(
      18000
    )
  })

  it('headlines the member price when it is at or below the shelf/promo price', () => {
    expect(
      displayPrice({
        price: 21500,
        member_price: 19900,
        effective_unit_price: 20500,
        promo_label: 'Diskon 5%',
      })
    ).toBe(19900)
    // Equal prices: the member price is still the displayed price.
    expect(displayPrice({ price: 19900, member_price: 19900 })).toBe(19900)
  })

  it('never displays a member premium above the shelf/promo price', () => {
    expect(displayPrice({ price: 18000, member_price: 19900 })).toBe(18000)
    expect(
      displayPrice({
        price: 21500,
        member_price: 19900,
        effective_unit_price: 18000,
        promo_label: 'Diskon 16%',
      })
    ).toBe(18000)
  })

  it('labels a headline as Member only when the member price is displayed', () => {
    expect(showsMemberPrice({ price: 21500, member_price: 19900 })).toBe(true)
    expect(showsMemberPrice({ price: 19900, member_price: 19900 })).toBe(true)
    expect(showsMemberPrice({ price: 18000, member_price: 19900 })).toBe(false)
    expect(
      showsMemberPrice({
        price: 21500,
        member_price: 19900,
        effective_unit_price: 18000,
        promo_label: 'Diskon 16%',
      })
    ).toBe(false)
    expect(showsMemberPrice({ price: 21500 })).toBe(false)
  })

  it('keeps the existing promo/shelf behaviour without a member price', () => {
    expect(displayPrice({ price: 21500 })).toBe(21500)
    expect(displayPrice({ price: 41000, effective_unit_price: 36000, promo_label: 'Diskon' })).toBe(
      36000
    )
    expect(displayPrice({ price: 21500, effective_unit_price: 21500, promo_label: 'Diskon' })).toBe(
      21500
    )
  })

  it('returns the shelf price as a struck reference when the headline is lower', () => {
    expect(referencePrice({ price: 21500, member_price: 19900 })).toEqual({
      price: 21500,
      struck: true,
    })
    expect(
      referencePrice({
        price: 21500,
        member_price: 19900,
        effective_unit_price: 18000,
        promo_label: 'Diskon 16%',
      })
    ).toEqual({ price: 21500, struck: true })
  })

  it('never renders a premium or an equal shelf price as a discount', () => {
    // Member premium: the shelf price IS the headline, so no reference line.
    expect(referencePrice({ price: 18000, member_price: 19900 })).toBeNull()
    // Equal: nothing is saved, so nothing is struck.
    expect(referencePrice({ price: 19900, member_price: 19900 })).toBeNull()
  })

  it('keeps the struck promo reference for non-member rows', () => {
    expect(
      referencePrice({ price: 41000, effective_unit_price: 36000, promo_label: 'Diskon 12%' })
    ).toEqual({ price: 41000, struck: true })
    // No cut, no evidence, or the shelf price itself → no reference line.
    expect(referencePrice({ price: 41000 })).toBeNull()
    expect(referencePrice({ price: 41000, effective_unit_price: 36000 })).toBeNull()
  })
})

describe('promo evidence and badges', () => {
  it('detects promo evidence from either field', () => {
    expect(hasPromoEvidence({ promo_label: 'x' })).toBe(true)
    expect(hasPromoEvidence({ promo_type: 'discount_pct' })).toBe(true)
    expect(hasPromoEvidence({ promo_label: null, promo_type: null })).toBe(false)
  })

  it('maps keywords to tones (PM §3.2 table)', () => {
    expect(promoTone('Diskon 15%')).toBe('danger')
    expect(promoTone('Hemat 10%')).toBe('danger')
    expect(promoTone('Gratis ongkir')).toBe('ok')
    expect(promoTone('Free gift')).toBe('ok')
    expect(promoTone('Dapat voucher')).toBe('warn')
    expect(promoTone('Beli 2')).toBe('warn')
    expect(promoTone('Bonus sprei')).toBe('warn')
    expect(promoTone('Spesial minggu ini')).toBe('muted')
  })

  it('filters brochure footnote lines starting with *Harga', () => {
    expect(isFootnoteLabel('*Harga spesial minimarket')).toBe(true)
    expect(promoBadges('*Harga untuk kemasan khusus', null)).toEqual([])
    // A footnote segment is dropped without suppressing the real offers.
    expect(promoBadges('DISKON 20%; *Harga khusus; GRATIS 1', null)).toEqual([
      { text: 'Diskon 20%', tone: 'danger' },
      { text: 'Gratis 1', tone: 'ok' },
    ])
  })

  it('splits semicolon labels into one badge per segment with its own tone', () => {
    expect(promoBadges('DISKON 50%;PROMO 1 HARI!', null)).toEqual([
      { text: 'Diskon 50%', tone: 'danger' },
      { text: 'Promo 1 Hari!', tone: 'muted' },
    ])
    expect(promoBadges('GRATIS ONGKIR;BELI 2 DAPAT 1', null)).toEqual([
      { text: 'Gratis Ongkir', tone: 'ok' },
      { text: 'Beli 2 Dapat 1', tone: 'warn' },
    ])
  })

  it('pretty-cases uppercase and lowercase segments, preserving acronyms and numbers', () => {
    expect(promoBadges('FRESH DEALS!', null)).toEqual([{ text: 'Fresh Deals!', tone: 'muted' }])
    expect(promoBadges('promo spesial', null)).toEqual([{ text: 'Promo Spesial', tone: 'muted' }])
    expect(promoBadges('DISKON 50%;ABC PROMO', null)).toEqual([
      { text: 'Diskon 50%', tone: 'danger' },
      { text: 'ABC Promo', tone: 'muted' },
    ])
    expect(promoBadges('PROMO 1 HARI!', null)).toEqual([{ text: 'Promo 1 Hari!', tone: 'muted' }])
  })

  it('drops empty segments and keeps repeated text as separate badges', () => {
    expect(promoBadges(' ; DISKON 5% ; ', null)).toEqual([{ text: 'Diskon 5%', tone: 'danger' }])
    expect(promoBadges('GRATIS 1;GRATIS 1', null)).toEqual([
      { text: 'Gratis 1', tone: 'ok' },
      { text: 'Gratis 1', tone: 'ok' },
    ])
  })

  it('falls back to promo_type as badge text', () => {
    expect(promoBadges(null, 'discount_pct')).toEqual([{ text: 'discount_pct', tone: 'muted' }])
    expect(promoBadges('', 'discount_pct')).toEqual([{ text: 'discount_pct', tone: 'muted' }])
    expect(promoBadges(' ; ', 'discount_pct')).toEqual([{ text: 'discount_pct', tone: 'muted' }])
  })

  it('renders no badge without any promo fields', () => {
    expect(promoBadges(null, null)).toEqual([])
    expect(promoBadges(undefined, undefined)).toEqual([])
  })
})

describe('countdownState', () => {
  it('classifies expiry buckets against local midnight', () => {
    expect(countdownState('2026-10-30', NOW)).toEqual({ type: 'days', count: 1 })
    expect(countdownState('2026-11-02', NOW)).toEqual({ type: 'days', count: 4 })
    expect(countdownState('2026-10-29', NOW)).toEqual({ type: 'today', count: 0 })
    expect(countdownState('2026-10-28', NOW)).toEqual({ type: 'expired', count: -1 })
  })

  it('treats the whole validity day as live (end of day, not the instant)', () => {
    const lateNight = new Date(2026, 9, 29, 23, 59, 0)
    expect(countdownState('2026-10-29', lateNight)).toEqual({ type: 'today', count: 0 })
  })

  it('parses date-only strings as local midnight, not UTC', () => {
    // NOW at 2026-10-29 12:00 local. If '2026-10-29' were parsed as UTC
    // midnight, west-of-UTC timezones would see the valid day as yesterday.
    expect(countdownState('2026-10-29', NOW).type).toBe('today')
  })

  it('returns null without a validity date', () => {
    expect(countdownState(null, NOW)).toBeNull()
    expect(countdownState(undefined, NOW)).toBeNull()
  })
})

describe('relativeAge', () => {
  it('buckets elapsed absolute time (arch §3.5 wording table)', () => {
    expect(relativeAge('2026-10-29T11:59:30Z', new Date(NOW_ISO))).toEqual({
      key: 'justNow',
      count: 0,
    })
    expect(relativeAge('2026-10-29T11:55:00Z', new Date(NOW_ISO))).toEqual({
      key: 'minAgo',
      count: 5,
    })
    expect(relativeAge('2026-10-29T10:30:00Z', new Date(NOW_ISO))).toEqual({
      key: 'hourAgo',
      count: 1,
    })
    expect(relativeAge('2026-10-28T06:00:00Z', new Date(NOW_ISO))).toEqual({
      key: 'dayAgo',
      count: 1,
    })
  })

  it('returns null without a timestamp', () => {
    expect(relativeAge(null, new Date(NOW_ISO))).toBeNull()
  })
})

describe('isFreshnessStale', () => {
  it('flags data older than 26h as stale, fresh data not', () => {
    const now = new Date('2026-10-29T12:00:00Z')
    expect(isFreshnessStale('2026-10-28T06:00:00Z', now)).toBe(true) // 30h
    expect(isFreshnessStale('2026-10-28T10:01:00Z', now)).toBe(false) // 25h59m
  })
})

describe('savePctVisible', () => {
  it('shows the badge only from 5% (rounded) up', () => {
    expect(savePctVisible(0)).toBe(false)
    expect(savePctVisible(4.4)).toBe(false)
    // 4.9 rounds to 5 — the threshold applies to the rounded integer (PM §3.2).
    expect(savePctVisible(4.9)).toBe(true)
    expect(savePctVisible(5)).toBe(true)
    expect(savePctVisible(5.26)).toBe(true)
    expect(savePctVisible(15.4)).toBe(true)
    expect(savePctVisible(null)).toBe(false)
    expect(savePctVisible(undefined)).toBe(false)
  })
})

describe('buildFooterStats', () => {
  const sourceOrder = [
    { slug: 'lotte-mart', name: 'Lotte Mart' },
    { slug: 'superindo', name: 'Superindo' },
  ]

  it('counts products per source and matched products (PM §3.6 example)', () => {
    const items = [
      { product_key: 'a', source_slug: 'lotte-mart' },
      { product_key: 'a', source_slug: 'superindo' },
      { product_key: 'b', source_slug: 'lotte-mart' },
      { product_key: 'c', source_slug: 'lotte-mart' },
      { product_key: 'd', source_slug: 'superindo' },
    ]
    expect(buildFooterStats(items, sourceOrder)).toEqual({
      segments: [
        { slug: 'lotte-mart', name: 'Lotte Mart', count: 3 },
        { slug: 'superindo', name: 'Superindo', count: 2 },
      ],
      matched: 1,
    })
  })

  it('with a single source chip active, only that segment renders and matched is 0', () => {
    const items = [
      { product_key: 'a', source_slug: 'superindo' },
      { product_key: 'b', source_slug: 'superindo' },
    ]
    expect(buildFooterStats(items, sourceOrder)).toEqual({
      segments: [{ slug: 'superindo', name: 'Superindo', count: 2 }],
      matched: 0,
    })
  })

  it('omits sources absent from the filtered set and empty sets entirely', () => {
    expect(buildFooterStats([], sourceOrder)).toEqual({ segments: [], matched: 0 })
    expect(buildFooterStats([{ product_key: 'a', source_slug: 'astro' }], sourceOrder)).toEqual({
      segments: [],
      matched: 0,
    })
  })

  it('counts each product once per source even across repeated rows', () => {
    const items = [
      { product_key: 'a', source_slug: 'lotte-mart' },
      { product_key: 'a', source_slug: 'lotte-mart' },
    ]
    expect(buildFooterStats(items, sourceOrder).segments).toEqual([
      { slug: 'lotte-mart', name: 'Lotte Mart', count: 1 },
    ])
  })
})

describe('normalizeHash', () => {
  it('strips the leading hash mark without a second decode', () => {
    expect(normalizeHash('#gula-pasir')).toBe('gula-pasir')
    expect(normalizeHash('gula-pasir')).toBe('gula-pasir')
    expect(normalizeHash('')).toBe('')
    expect(normalizeHash(null)).toBe('')
    // The router already decoded the hash (decodePath); the helper must not
    // decode again — and must never throw on a stray '%'.
    expect(normalizeHash('produk with space')).toBe('produk with space')
    expect(normalizeHash('50%')).toBe('50%')
  })
})

describe('effectivePrice', () => {
  it('coalesces effective_unit_price onto price', () => {
    expect(effectivePrice({ price: 100, effective_unit_price: 90 })).toBe(90)
    expect(effectivePrice({ price: 100 })).toBe(100)
    expect(effectivePrice({ price: 100, effective_unit_price: 0 })).toBe(0)
  })
})

describe('resolvePriceView', () => {
  it('maps the remaining catalog views, defaults to products, and lets the hash win', () => {
    expect(resolvePriceView(undefined, '')).toBe('products')
    expect(resolvePriceView('promos', '')).toBe('promos')
    expect(resolvePriceView('nonsense', '')).toBe('products')
    // #631: Brochures moved to /admin/catalog — /prices falls back to
    // Products for it instead of rendering the moved view.
    expect(resolvePriceView('brochures', '')).toBe('products')
    // A #productKey deep link is the stronger intent (PM AC 7 / #293 AC 5):
    // the hash forces the Products view whatever ?view= says.
    expect(resolvePriceView('brochures', 'gula-pasir')).toBe('products')
    expect(resolvePriceView(undefined, 'gula-pasir')).toBe('products')
  })
})

describe('resolveCatalogTab', () => {
  it('maps the admin catalog tabs, defaults to products, and lets the hash win', () => {
    expect(resolveCatalogTab(undefined, '')).toBe('products')
    expect(resolveCatalogTab('brochures', '')).toBe('brochures')
    expect(resolveCatalogTab('products', '')).toBe('products')
    expect(resolveCatalogTab('nonsense', '')).toBe('products')
    // The brochure example jump and the retired /prices?view=brochures#key
    // deep link both open the Products tab so the hash can expand the row.
    expect(resolveCatalogTab('brochures', 'gula-pasir')).toBe('products')
    expect(resolveCatalogTab(undefined, 'gula-pasir')).toBe('products')
  })
})
