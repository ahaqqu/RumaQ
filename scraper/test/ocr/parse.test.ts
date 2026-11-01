// Port of haqita tests/ocr/test_price_parser.py + test_ocr_validation.py.

import { describe, expect, it } from 'vite-plus/test'

import {
  cleanPrice,
  cleanUnit,
  normalizePromo,
  parseIdrValue,
  parseOcrJson,
  validateProduct,
} from '../../src/ocr/parse.js'

describe('parseIdrValue', () => {
  it.each([
    ['Rp 8.500', 8500],
    ['Rp 1.275.000', 1275000],
    ['2000000', 2000000],
    ['8,500', 8500],
    ['50', 50],
    [15500, 15500],
  ])('parses %s → %i with no bounds', (input, expected) => {
    expect(parseIdrValue(input as string | number)).toBe(expected)
  })

  it.each([
    ['???', null],
    [null, null],
    [undefined, null],
  ])('rejects %s', (input, expected) => {
    expect(parseIdrValue(input as string | null)).toBe(expected)
  })
})

describe('cleanPrice', () => {
  it.each([
    ['Rp 8.500', 8500],
    ['Rp8.500', 8500],
    ['8500', 8500],
    ['8,500', 8500],
    ['8 500', 8500],
    ['Rp 150.000', 150000],
    ['rp 5.000', 5000],
    ['Rp. 15.500', 15500],
    ['1000', 1000],
  ])('parses %s → %i', (input, expected) => {
    expect(cleanPrice(input)).toBe(expected)
  })

  it.each([
    ['???', null],
    [null, null],
    [undefined, null],
    ['50', null], // below minimum
    ['2000000', null], // above maximum
  ])('rejects %s', (input, expected) => {
    expect(cleanPrice(input as string | null)).toBe(expected)
  })

  it('accepts integer input directly', () => {
    expect(cleanPrice(15500)).toBe(15500)
  })
})

describe('cleanUnit', () => {
  it('fixes common OCR corruptions', () => {
    expect(cleanUnit('Sg')).toBe('5g')
    expect(cleanUnit('Bg')).toBe('8g')
    expect(cleanUnit('IOO')).toBe('100')
    expect(cleanUnit('l g')).toBe('1 g')
  })

  it('keeps genuine liters after a number (refined vs haqita)', () => {
    expect(cleanUnit('1 L')).toBe('1 L')
    expect(cleanUnit('1.5 l')).toBe('1.5 l')
  })

  it('passes through valid units', () => {
    expect(cleanUnit('85 g')).toBe('85 g')
  })

  it('handles null and empty', () => {
    expect(cleanUnit(null)).toBeNull()
    expect(cleanUnit('')).toBeNull()
  })
})

describe('normalizePromo', () => {
  it('returns null for empty inputs', () => {
    expect(normalizePromo(null)).toBeNull()
    expect(normalizePromo(undefined)).toBeNull()
    expect(normalizePromo('')).toBeNull()
    expect(normalizePromo([])).toBeNull()
    expect(normalizePromo([null])).toBeNull()
  })

  it('wraps a single string', () => {
    expect(normalizePromo('DISKON 20%')).toEqual(['DISKON 20%'])
  })

  it('keeps lists and filters nulls/blanks', () => {
    expect(normalizePromo(['DISKON 20%', null, 'Beli 2 Gratis 1'])).toEqual([
      'DISKON 20%',
      'Beli 2 Gratis 1',
    ])
    expect(normalizePromo(['DISKON 20%', '', '  ', 'Beli 2 Gratis 1'])).toEqual([
      'DISKON 20%',
      'Beli 2 Gratis 1',
    ])
  })

  it('trims whitespace', () => {
    expect(normalizePromo(['  DISKON 20%  '])).toEqual(['DISKON 20%'])
  })

  it('stringifies non-string entries', () => {
    expect(normalizePromo([123, 456])).toEqual(['123', '456'])
  })
})

describe('parseOcrJson', () => {
  it('parses a plain JSON array', () => {
    expect(parseOcrJson('[{"name": "A", "price": 5000}]')).toEqual([{ name: 'A', price: 5000 }])
  })

  it('parses markdown-fenced output', () => {
    expect(parseOcrJson('```json\n[{"name": "B", "price": 10000}]\n```')).toEqual([
      { name: 'B', price: 10000 },
    ])
    expect(parseOcrJson('```\n[{"name": "C", "price": 15000}]\n```')).toEqual([
      { name: 'C', price: 15000 },
    ])
  })

  it('parses an array surrounded by prose', () => {
    expect(parseOcrJson('Here are the products:\n[{"name": "D", "price": 20000}]\nDone.')).toEqual([
      { name: 'D', price: 20000 },
    ])
  })

  it('throws when no array is present', () => {
    expect(() => parseOcrJson('Just text without any array')).toThrow('No JSON array found')
    expect(() => parseOcrJson('')).toThrow('No JSON array found')
  })

  it('throws on invalid JSON inside the array', () => {
    expect(() => parseOcrJson('[invalid json]')).toThrow()
  })

  it('strips a model-emitted priceFromDom (review A1, PR #366)', () => {
    // priceFromDom is the catalog path's cap exemption (issue #363) — it is
    // set by pipeline.ts catalogItemToRaw ONLY. The OCR path parses model
    // output, so a hallucinated flag must never survive: it would let the
    // OCR path waive its own MAX_PRICE misread guard.
    expect(parseOcrJson('[{"name": "E", "price": 2000000, "priceFromDom": true}]')).toEqual([
      { name: 'E', price: 2000000 },
    ])
  })
})

describe('validateProduct', () => {
  it('accepts a full valid product', () => {
    const [product, reason] = validateProduct(
      {
        name: 'Indomie Goreng Ayam Geprek',
        brand: 'Indomie',
        unit: '85 g',
        price: 15500,
        promo: ['DAPAT 5 pcs'],
        period: '7 - 20 Mei 2026',
      },
      'test.jpg'
    )
    expect(reason).toBeNull()
    expect(product!.name).toBe('Indomie Goreng Ayam Geprek')
    expect(product!.price).toBe(15500)
    expect(product!.imageSource).toBe('test.jpg')
    expect(product!.ocrRawPrice).toBe('15500')
  })

  it('rejects short and empty names', () => {
    expect(validateProduct({ name: 'X', price: 5000 }, 'test.jpg')).toEqual([
      null,
      'name_too_short',
    ])
    expect(validateProduct({ name: '', price: 5000 }, 'test.jpg')).toEqual([null, 'name_too_short'])
  })

  it('classifies an absent price as price_missing (issue #365)', () => {
    // The no-price lineup entries (hypermart) — expected and benign, not a
    // misread. The item is still dropped, only the reason differs.
    expect(validateProduct({ name: 'Product A' }, 'test.jpg')).toEqual([null, 'price_missing'])
    expect(validateProduct({ name: 'Product A', price: null }, 'test.jpg')).toEqual([
      null,
      'price_missing',
    ])
    expect(validateProduct({ name: 'Product A', price: '' }, 'test.jpg')).toEqual([
      null,
      'price_missing',
    ])
    expect(validateProduct({ name: 'Product A', price: '   ' }, 'test.jpg')).toEqual([
      null,
      'price_missing',
    ])
  })

  it('rejects garbage, zero, and sub-MIN prices as price_invalid', () => {
    expect(validateProduct({ name: 'Product A', price: '???' }, 'test.jpg')[1]).toBe(
      'price_invalid: ???'
    )
    expect(validateProduct({ name: 'Product A', price: 0 }, 'test.jpg')[1]).toBe('price_invalid: 0')
    expect(validateProduct({ name: 'Product A', price: '50' }, 'test.jpg')[1]).toBe(
      'price_invalid: 50'
    )
  })

  it('keeps the OCR misread cap on the OCR path (issue #363)', () => {
    expect(validateProduct({ name: 'Product A', price: 2000000 }, 'test.jpg')).toEqual([
      null,
      'price_invalid: 2000000',
    ])
  })

  it('accepts a DOM price above the OCR cap, still below MIN (issue #363)', () => {
    const [product, reason] = validateProduct(
      { name: 'Enfagrow A+ Neurapro 3 3.6 kg', price: 1685900, priceFromDom: true },
      't.jpg'
    )
    expect(reason).toBeNull()
    expect(product!.price).toBe(1685900)
    expect(
      validateProduct({ name: 'Product A', price: 'Rp 2.000.000', priceFromDom: true }, 't.jpg')[1]
    ).toBeNull()
    // Only the 1M ceiling is waived — the parse-level floor still rejects.
    expect(
      validateProduct({ name: 'Product A', price: '50', priceFromDom: true }, 't.jpg')[1]
    ).toBe('price_invalid: 50')
  })

  it('keeps exact-bound prices valid on both paths (review B1, PR #366)', () => {
    // The bounds are strict comparisons (value < MIN_PRICE, value >
    // MAX_PRICE): exactly 100 and exactly 1_000_000 were valid before #363
    // and must stay valid on BOTH paths — a future </<= or >/>= slip would
    // otherwise pass every strictly-inside-or-outside case.
    expect(validateProduct({ name: 'Product A', price: 100 }, 't.jpg')[0]!.price).toBe(100)
    expect(validateProduct({ name: 'Product A', price: 1_000_000 }, 't.jpg')[0]!.price).toBe(
      1_000_000
    )
    expect(
      validateProduct({ name: 'Product A', price: 100, priceFromDom: true }, 't.jpg')[0]!.price
    ).toBe(100)
    expect(
      validateProduct({ name: 'Product A', price: 1_000_000, priceFromDom: true }, 't.jpg')[0]!
        .price
    ).toBe(1_000_000)
    // One step outside either bound rejects on the OCR path…
    expect(validateProduct({ name: 'Product A', price: 99 }, 't.jpg')[1]).toBe('price_invalid: 99')
    expect(validateProduct({ name: 'Product A', price: 1_000_001 }, 't.jpg')[1]).toBe(
      'price_invalid: 1000001'
    )
    // …and on the DOM path only the floor still rejects.
    expect(
      validateProduct({ name: 'Product A', price: 1_000_001, priceFromDom: true }, 't.jpg')[1]
    ).toBeNull()
    expect(
      validateProduct({ name: 'Product A', price: 99, priceFromDom: true }, 't.jpg')[1]
    ).toBe('price_invalid: 99')
  })

  it('preserves brand and defaults missing brand to null', () => {
    expect(
      validateProduct({ name: 'ABC Kecap', brand: 'ABC', price: 5000 }, 't.jpg')[0]!.brand
    ).toBe('ABC')
    expect(validateProduct({ name: 'Gula Pasir', price: 15000 }, 't.jpg')[0]!.brand).toBeNull()
  })

  it('keeps the raw OCR price string for debugging', () => {
    const [product] = validateProduct({ name: 'Item', price: 'Rp 5.000' }, 'test.jpg')
    expect(product!.price).toBe(5000)
    expect(product!.ocrRawPrice).toBe('Rp 5.000')
  })
})
