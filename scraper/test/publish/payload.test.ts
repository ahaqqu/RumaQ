// Payload builder tests — product keys (haqita convention), period parsing,
// and schema round-trip through the shared Valibot schema from PR1.

import { describe, expect, it } from 'vite-plus/test'
import * as v from 'valibot'

import { loadConfig, storeBySlug } from '../../src/config.js'
import { validateProduct } from '../../src/ocr/parse.js'
import {
  assertPayloadValid,
  buildPayload,
  ingestPayloadSchema,
  makeProductKey,
  parsePeriod,
} from '../../src/publish/payload.js'

describe('makeProductKey', () => {
  it('slugs name, brand, and unit with the haqita -- convention', () => {
    expect(makeProductKey('Minyak Goreng Bimoli', 'Bimoli', '1 L')).toBe(
      'minyak-goreng-bimoli--bimoli--1-l'
    )
  })

  it('leaves empty segments for missing brand/unit', () => {
    expect(makeProductKey('Gula Pasir', null, null)).toBe('gula-pasir----')
  })

  it('collapses punctuation into single hyphens', () => {
    expect(makeProductKey('Chitato Sapi Panggang!', 'Chitato', '68 g')).toBe(
      'chitato-sapi-panggang--chitato--68-g'
    )
  })
})

describe('parsePeriod', () => {
  it.each([
    ['7 - 20 Mei 2026', ['2026-05-07', '2026-05-20']],
    ['14-17 Mei 2026', ['2026-05-14', '2026-05-17']],
    ['Berlaku 1-15 Mei 2026', ['2026-05-01', '2026-05-15']],
  ])('parses ranges: %s', (period, expected) => {
    expect(parsePeriod(period)).toEqual(expected)
  })

  it('parses end-only dates', () => {
    expect(parsePeriod('s/d 20 Mei 2026')).toEqual([null, '2026-05-20'])
    expect(parsePeriod('Valid until 15 May 2026')).toEqual([null, '2026-05-15'])
    expect(parsePeriod('20 Mei 2026')).toEqual([null, '2026-05-20'])
  })

  it('returns [null, null] for unparseable input', () => {
    expect(parsePeriod(null)).toEqual([null, null])
    expect(parsePeriod('Promo minggu ini')).toEqual([null, null])
    expect(parsePeriod('13 Xenos 2026')).toEqual([null, null])
  })

  it('returns null for impossible days', () => {
    expect(parsePeriod('45 Mei 2026')).toEqual([null, null])
    expect(parsePeriod('0 Mei 2026')).toEqual([null, null])
  })

  it('returns null for dates that do not exist in the month', () => {
    expect(parsePeriod('31 Apr 2026')).toEqual([null, null])
    expect(parsePeriod('30 Feb 2026')).toEqual([null, null]) // 2026 is not a leap year
    expect(parsePeriod('29 Feb 2028')).toEqual([null, '2028-02-29']) // 2028 is
  })

  it('nulls only the impossible end of a range', () => {
    expect(parsePeriod('30 - 45 Mei 2026')).toEqual(['2026-05-30', null])
  })
})

describe('buildPayload', () => {
  const config = loadConfig()
  const superindo = storeBySlug(config, 'superindo')!

  const [product] = validateProduct(
    {
      name: 'Minyak Goreng Bimoli',
      brand: 'Bimoli',
      unit: '1 L',
      price: 21500,
      promo: ['Diskon 15%', 'MAX 2'],
      period: '22 - 28 Okt 2026',
    },
    'promo_abc.jpg'
  )

  it('builds a payload that validates against the shared ingest schema', () => {
    const payload = buildPayload({
      stores: [superindo],
      images: [
        {
          storeSlug: 'superindo',
          brochureUrl: 'https://www.superindo.co.id/promosi/katalog-super-hemat/',
          products: [product!],
        },
      ],
      scrapedAt: '2026-10-24T23:00:05Z',
    })
    expect(() => v.parse(ingestPayloadSchema, payload)).not.toThrow()
    expect(payload.items).toHaveLength(1)
    const item = payload.items[0]!
    expect(item.productKey).toBe('minyak-goreng-bimoli--bimoli--1-l')
    expect(item.price).toBe(21500)
    expect(item.promoLabel).toBe('Diskon 15%; MAX 2')
    expect(item.validFrom).toBe('2026-10-22')
    expect(item.validUntil).toBe('2026-10-28')
    expect(item.observedDate).toBe('2026-10-24')
    expect(item.matchMethod).toBe('solo')
    expect(item.matchConfidence).toBe(1.0)
    expect(item.brochureUrl).toBe('https://www.superindo.co.id/promosi/katalog-super-hemat/')
    expect(payload.stores[0]).toEqual({
      slug: 'superindo',
      name: 'Superindo',
      region: 'jakarta',
      website: 'https://www.superindo.co.id/',
    })
  })

  it('omits stores with no items', () => {
    const payload = buildPayload({
      stores: config.stores,
      images: [{ storeSlug: 'superindo', brochureUrl: null, products: [product!] }],
      scrapedAt: '2026-10-24T23:00:05Z',
    })
    expect(payload.stores.map((s) => s.slug)).toEqual(['superindo'])
  })

  it('derives observedDate per batch so a cross-day replay keeps the extraction date', () => {
    // An outbox line written on day 1, replayed by a day-3 run: the upsert
    // conflict key includes observed_date, so the replay must keep day 1.
    const payload = buildPayload({
      stores: [superindo],
      images: [
        {
          storeSlug: 'superindo',
          brochureUrl: null,
          products: [product!],
          scrapedAt: '2026-10-24T23:00:05Z',
        },
        // Legacy/current-run batch without a per-batch timestamp → run date.
        { storeSlug: 'superindo', brochureUrl: null, products: [product!] },
      ],
      scrapedAt: '2026-10-26T23:00:05Z',
    })
    expect(payload.items).toHaveLength(2)
    expect(payload.items[0]!.observedDate).toBe('2026-10-24') // extraction day
    expect(payload.items[1]!.observedDate).toBe('2026-10-26') // this run's day
  })

  it('produces an empty-but-valid payload with no images', () => {
    const payload = buildPayload({
      stores: [superindo],
      images: [],
      scrapedAt: '2026-10-24T23:00:05Z',
    })
    expect(payload.items).toEqual([])
    expect(payload.stores).toEqual([])
    expect(() => v.parse(ingestPayloadSchema, payload)).not.toThrow()
  })

  it('assertPayloadValid passes what buildPayload produced', () => {
    const payload = buildPayload({
      stores: [superindo],
      images: [{ storeSlug: 'superindo', brochureUrl: null, products: [product!] }],
      scrapedAt: '2026-10-24T23:00:05Z',
    })
    expect(() => assertPayloadValid(payload)).not.toThrow()
  })

  it('assertPayloadValid rejects violations the type system cannot catch', () => {
    const payload = buildPayload({
      stores: [superindo],
      images: [{ storeSlug: 'superindo', brochureUrl: null, products: [product!] }],
      scrapedAt: '2026-10-24T23:00:05Z',
    })
    expect(() =>
      assertPayloadValid({ ...payload, items: [{ ...payload.items[0]!, price: -1 }] })
    ).toThrow(/failed schema validation/)
    // Out-of-range confidence — still a number, so the type system is silent.
    expect(() =>
      assertPayloadValid({
        ...payload,
        items: [{ ...payload.items[0]!, matchConfidence: 1.5 }],
      })
    ).toThrow(/failed schema validation/)
  })
})
