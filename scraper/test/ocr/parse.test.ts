// Port of haqita tests/ocr/test_price_parser.py + test_ocr_validation.py.

import { describe, expect, it } from 'vitest'

import {
  cleanPrice,
  cleanUnit,
  normalizePromo,
  parseOcrJson,
  validateProduct,
} from '../../src/ocr/parse.js'

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

  it('rejects missing, null, zero, and out-of-range prices', () => {
    expect(validateProduct({ name: 'Product A' }, 'test.jpg')[1]).toContain('price')
    expect(validateProduct({ name: 'Product A', price: null }, 'test.jpg')[1]).toContain('price')
    expect(validateProduct({ name: 'Product A', price: 0 }, 'test.jpg')[1]).toContain('price')
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
