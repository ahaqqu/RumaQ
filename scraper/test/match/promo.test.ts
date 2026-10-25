// Port of haqita tests/matching/test_promo_parser.py + the inline
// `python promo_parser.py` assertions — cases verbatim.

import { describe, expect, it } from 'vite-plus/test'

import {
  categorizePromo,
  normalizePromoText,
  parsePeriod,
  parsePromo,
  standardizePromoList,
} from '../../src/match/promo.js'

// ---------------------------------------------------------------------------
// parsePromo
// ---------------------------------------------------------------------------

describe('parsePromo', () => {
  it('parses "DAPAT 5 pcs" as bundle_buy with divided price', () => {
    const result = parsePromo('DAPAT 5 pcs', 15500)
    expect(result.promoType).toBe('bundle_buy')
    expect(result.unitCount).toBe(5)
    expect(result.effectiveUnitPrice).toBe(3100)
  })

  it('parses "dapat 3 buah"', () => {
    const result = parsePromo('dapat 3 buah', 30000)
    expect(result.promoType).toBe('bundle_buy')
    expect(result.unitCount).toBe(3)
  })

  it('parses "Beli 2 Gratis 1" as get_free', () => {
    const result = parsePromo('Beli 2 Gratis 1', 30000)
    expect(result.promoType).toBe('get_free')
    expect(result.unitCount).toBe(3)
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
    expect(result.unitCount).toBe(3)
    expect(result.effectiveUnitPrice).toBe(5000)
  })

  it('null promo is single at base price', () => {
    const result = parsePromo(null, 15000)
    expect(result.promoType).toBe('single')
    expect(result.unitCount).toBe(1)
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

  it('preserves the display text', () => {
    expect(parsePromo('Diskon 20%', 100000).display).toBe('Diskon 20%')
  })

  it('accepts a single-item array', () => {
    const result = parsePromo(['DAPAT 5 pcs'], 15500)
    expect(result.promoType).toBe('bundle_buy')
    expect(result.unitCount).toBe(5)
    expect(result.effectiveUnitPrice).toBe(3100)
    expect(result.display).toBe('DAPAT 5 pcs')
  })

  it('picks the best deal across multiple entries', () => {
    const result = parsePromo(['DISKON 20%', 'Beli 2 Gratis 1'], 100000)
    // DISKON 20%: 100000 (no math), Beli 2 Gratis 1: 33333
    expect(result.promoType).toBe('get_free')
    expect(result.effectiveUnitPrice).toBe(33333)
    expect(result.display).toBe('DISKON 20%, Beli 2 Gratis 1')
  })

  it('empty array is single', () => {
    const result = parsePromo([], 15000)
    expect(result.promoType).toBe('single')
    expect(result.unitCount).toBe(1)
    expect(result.effectiveUnitPrice).toBe(15000)
  })

  it('mixed match/no-match entries fall back to the recognized best', () => {
    const result = parsePromo(['DISKON 20%', 'Harga Spesial'], 100000)
    // DISKON 20% no longer applies math → effective = 100000;
    // "Harga Spesial" (unrecognized) → 100000. Best (lowest) = 100000.
    expect(result.promoType).toBe('discount_pct')
    expect(result.effectiveUnitPrice).toBe(100000)
    expect(result.display).toBe('DISKON 20%, Harga Spesial')
  })
})

// ---------------------------------------------------------------------------
// normalizePromoText / categorizePromo (haqita promo_parser __main__ suite)
// ---------------------------------------------------------------------------

describe('normalizePromoText', () => {
  it.each([
    ['', []],
    ['  ', []],
    ['DISKON 20%', ['Diskon 20%']],
    ['DISKON 20% EKSTRA STIKER', ['Diskon 20%', 'Ekstra Stiker']],
    ['HARGA SPESIAL EKSTRA STIKER', ['Harga Spesial', 'Ekstra Stiker']],
    ['HEMAT 40%', ['Hemat 40%']],
    ['2 GRATIS 1', ['2 Gratis 1']],
    ['GRATIS', ['Gratis']],
    ['maks. 4 pck', ['Maks. 4 pck']],
    ['MAX 4 box', ['Maks. 4 box']],
    ['KHUSUS MEMBER', ['Khusus Member']],
    ['Beli 1 Rp 16.800', ['Beli 1 Rp 16.800']],
  ])('%s → %s', (input, expected) => {
    expect(normalizePromoText(input)).toEqual(expected)
  })
})

describe('categorizePromo', () => {
  it.each([
    ['Diskon 20%', 'discount_pct'],
    ['Hemat 40%', 'discount_pct'],
    ['Diskon 15%', 'discount_pct'],
    ['1 Gratis 1', 'bogo'],
    ['2 Gratis 1', 'bogo'],
    ['Gratis', 'bogo'],
    ['2 Lebih Hemat', 'bundle'],
    ['2 Seharga 20.980', 'bundle'],
    ['Beli 2 Harga Satuan', 'bundle'],
    ['Ekstra Stiker', 'bundle'],
    ['Khusus Member', 'member_price'],
    ['Member Special Price', 'member_price'],
    ['PWP', 'member_price'],
    ['Harga Spesial', 'promo_price'],
    ['Fresh Deals!', 'promo_price'],
    ['12 & 14 Juni 15.490', 'discount_fixed'],
    ['Beli 1 Rp 16.800', 'discount_fixed'],
    ['Maks. 4 pck', 'quantity_limit'],
    ['Maks. 4 box', 'quantity_limit'],
    ['Gratis Es Batu', 'freebie'],
    ["Disertai Pembelian 365 Teh Celup 25's Hitam Box 25x2gr", 'freebie'],
    ['Anti Bocor', 'special'],
  ])('%s → %s', (input, expected) => {
    expect(categorizePromo(input)).toBe(expected)
  })
})

describe('standardizePromoList', () => {
  it('returns null for null/empty/blank input', () => {
    expect(standardizePromoList(null)).toBeNull()
    expect(standardizePromoList([])).toBeNull()
    expect(standardizePromoList([''])).toBeNull()
  })

  it('splits and types composite promos', () => {
    const result = standardizePromoList(['DISKON 20% EKSTRA STIKER'])
    expect(result).not.toBeNull()
    expect(result!.normalized).toEqual(['Diskon 20%', 'Ekstra Stiker'])
    expect(result!.types).toEqual(['discount_pct', 'bundle'])
    expect(result!.bestType).toBe('discount_pct')
    expect(result!.discountPct).toBe(20)
    expect(result!.maxQty).toBeNull()
    expect(result!.displaySummary).toBe('Diskon 20%')
  })

  it('extracts quantity limits', () => {
    const result = standardizePromoList(['maks. 4 pck'])
    expect(result!.bestType).toBe('quantity_limit')
    expect(result!.maxQty).toBe(4)
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
