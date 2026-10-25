// Port of haqita tests/matching/test_promo_parser.py — cases verbatim. The
// display-layer helpers (normalize/categorize/standardize) are not ported
// (see src/match/promo.ts header) — their haqita-parity tests went with
// them and return with the future consumer.

import { describe, expect, it } from 'vite-plus/test'

import { parsePeriod, parsePromo } from '../../src/match/promo.js'

// ---------------------------------------------------------------------------
// parsePromo
// ---------------------------------------------------------------------------

describe('parsePromo', () => {
  it('parses "DAPAT 5 pcs" as bundle_buy with divided price', () => {
    const result = parsePromo('DAPAT 5 pcs', 15500)
    expect(result.promoType).toBe('bundle_buy')
    expect(result.effectiveUnitPrice).toBe(3100)
  })

  it('parses "dapat 3 buah"', () => {
    const result = parsePromo('dapat 3 buah', 30000)
    expect(result.promoType).toBe('bundle_buy')
    expect(result.effectiveUnitPrice).toBe(10000)
  })

  it('parses "Beli 2 Gratis 1" as get_free', () => {
    const result = parsePromo('Beli 2 Gratis 1', 30000)
    expect(result.promoType).toBe('get_free')
    expect(result.effectiveUnitPrice).toBe(10000)
  })

  it('discount_pct applies no further math — OCR price is post-discount', () => {
    const result = parsePromo('Diskon 20%', 100000)
    expect(result.promoType).toBe('discount_pct')
    expect(result.effectiveUnitPrice).toBe(100000)
  })

  it('discount_pct with a different base', () => {
    const result = parsePromo('Diskon 25%', 24900)
    expect(result.promoType).toBe('discount_pct')
    expect(result.effectiveUnitPrice).toBe(24900)
  })

  it('hemat fixed applies no math either', () => {
    const result = parsePromo('Hemat Rp 5.000', 20000)
    expect(result.promoType).toBe('discount_fixed')
    expect(result.effectiveUnitPrice).toBe(20000)
  })

  it('parses "3 pcs / Rp15.000" as multi_price', () => {
    const result = parsePromo('3 pcs / Rp15.000', 15000)
    expect(result.promoType).toBe('multi_price')
    expect(result.effectiveUnitPrice).toBe(5000)
  })

  it('null promo is single at base price', () => {
    const result = parsePromo(null, 15000)
    expect(result.promoType).toBe('single')
    expect(result.effectiveUnitPrice).toBe(15000)
  })

  it('empty promo is single', () => {
    expect(parsePromo('', 15000).promoType).toBe('single')
  })

  it('unrecognized promo text is single at base price', () => {
    const result = parsePromo('Harga Spesial', 15000)
    expect(result.promoType).toBe('single')
    expect(result.effectiveUnitPrice).toBe(15000)
  })

  it('accepts a single-item array', () => {
    const result = parsePromo(['DAPAT 5 pcs'], 15500)
    expect(result.promoType).toBe('bundle_buy')
    expect(result.effectiveUnitPrice).toBe(3100)
  })

  it('picks the best deal across multiple entries', () => {
    const result = parsePromo(['DISKON 20%', 'Beli 2 Gratis 1'], 100000)
    // DISKON 20%: 100000 (no math), Beli 2 Gratis 1: 33333
    expect(result.promoType).toBe('get_free')
    expect(result.effectiveUnitPrice).toBe(33333)
  })

  it('empty array is single', () => {
    const result = parsePromo([], 15000)
    expect(result.promoType).toBe('single')
    expect(result.effectiveUnitPrice).toBe(15000)
  })

  it('mixed match/no-match entries fall back to the recognized best', () => {
    const result = parsePromo(['DISKON 20%', 'Harga Spesial'], 100000)
    // DISKON 20% no longer applies math → effective = 100000;
    // "Harga Spesial" (unrecognized) → 100000. Best (lowest) = 100000.
    expect(result.promoType).toBe('discount_pct')
    expect(result.effectiveUnitPrice).toBe(100000)
  })
})

// ---------------------------------------------------------------------------
// parsePeriod
// ---------------------------------------------------------------------------

describe('parsePeriod', () => {
  it('parses a same-month range', () => {
    expect(parsePeriod('7 - 20 Mei 2026')).toEqual(['2026-05-07', '2026-05-20'])
  })

  it('parses a compact range', () => {
    expect(parsePeriod('14-17 Mei 2026')).toEqual(['2026-05-14', '2026-05-17'])
  })

  it('parses October (Okt)', () => {
    expect(parsePeriod('1 - 15 Okt 2026')).toEqual(['2026-10-01', '2026-10-15'])
  })

  it('parses August (Agu)', () => {
    expect(parsePeriod('1 - 10 Agu 2026')).toEqual(['2026-08-01', '2026-08-10'])
  })

  it('null and empty parse to nothing', () => {
    expect(parsePeriod(null)).toEqual([null, null])
    expect(parsePeriod('')).toEqual([null, null])
  })

  it('unparseable text yields nothing', () => {
    expect(parsePeriod('some random text')).toEqual([null, null])
  })

  it('parses "s/d" end dates', () => {
    expect(parsePeriod('s/d 20 Mei 2026')).toEqual([null, '2026-05-20'])
  })

  it('parses a bare single date as end date', () => {
    expect(parsePeriod('20 Mei 2026')).toEqual([null, '2026-05-20'])
  })
})
