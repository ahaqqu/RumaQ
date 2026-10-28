import { describe, it, expect } from 'vite-plus/test'
import {
  displayPrice,
  effectivePrice,
  hasPromoEvidence,
  promoBadges,
  promoTone,
  isFootnoteLabel,
  countdownState,
  relativeAge,
  isFreshnessStale,
  savePctVisible,
  buildFooterStats,
  normalizeHash,
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
  })

  it('falls back to promo_type as badge text', () => {
    expect(promoBadges(null, 'discount_pct')).toEqual([{ text: 'discount_pct', tone: 'muted' }])
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
  it('strips the leading hash mark and decodes', () => {
    expect(normalizeHash('#gula-pasir')).toBe('gula-pasir')
    expect(normalizeHash('gula-pasir')).toBe('gula-pasir')
    expect(normalizeHash('')).toBe('')
    expect(normalizeHash(null)).toBe('')
    expect(normalizeHash(encodeURIComponent('produk with space'))).toBe('produk with space')
  })
})

describe('effectivePrice', () => {
  it('coalesces effective_unit_price onto price', () => {
    expect(effectivePrice({ price: 100, effective_unit_price: 90 })).toBe(90)
    expect(effectivePrice({ price: 100 })).toBe(100)
    expect(effectivePrice({ price: 100, effective_unit_price: 0 })).toBe(0)
  })
})
