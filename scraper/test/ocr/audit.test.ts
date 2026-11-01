// Shadow-OCR audit unit tests (issue #367, phase 1): gate parsing, sampling
// math, the diff matching (exact name + Jaccard fallback), the agreement
// percentages, and the swallow-everything shadow call. The pipeline-level
// gate-on/gate-off stories live in pipeline.test.ts.

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import {
  createShadowOcr,
  diffOcrItems,
  newAuditAccumulator,
  parseAuditGate,
  resolveShadowModel,
  runShadowAudit,
  shouldSamplePage,
  summarizeAudit,
} from '../../src/ocr/audit.js'
import { validateProduct, type ValidatedProduct } from '../../src/ocr/parse.js'
import type { GeminiClient } from '../../src/ocr/gemini.js'

function primary(over: Partial<ValidatedProduct> = {}): ValidatedProduct {
  const [product] = validateProduct(
    {
      name: 'Teh Kotak 250ml',
      price: 5000,
      originalPrice: null,
      promo: null,
      ...over,
    },
    'page-001.jpg'
  )
  return product!
}

describe('parseAuditGate (issue #367)', () => {
  it('defaults to off — unset, blank, and explicit off', () => {
    expect(parseAuditGate(undefined)).toEqual({ mode: 'off' })
    expect(parseAuditGate('')).toEqual({ mode: 'off' })
    expect(parseAuditGate('  ')).toEqual({ mode: 'off' })
    expect(parseAuditGate('off')).toEqual({ mode: 'off' })
    expect(parseAuditGate('OFF')).toEqual({ mode: 'off' })
  })

  it('parses all and sample:N', () => {
    expect(parseAuditGate('all')).toEqual({ mode: 'all' })
    expect(parseAuditGate(' ALL ')).toEqual({ mode: 'all' })
    expect(parseAuditGate('sample:1')).toEqual({ mode: 'sample', every: 1 })
    expect(parseAuditGate('Sample:20')).toEqual({ mode: 'sample', every: 20 })
  })

  it('falls back to off for garbage — the audit never turns itself on', () => {
    expect(parseAuditGate('everything')).toEqual({ mode: 'off' })
    expect(parseAuditGate('sample')).toEqual({ mode: 'off' })
    expect(parseAuditGate('sample:0')).toEqual({ mode: 'off' })
    expect(parseAuditGate('sample:-3')).toEqual({ mode: 'off' })
    expect(parseAuditGate('sample:abc')).toEqual({ mode: 'off' })
  })
})

describe('shouldSamplePage (issue #367)', () => {
  it('is never on when the gate is off', () => {
    const gate = parseAuditGate(undefined)
    for (let i = 0; i < 10; i++) expect(shouldSamplePage(gate, i)).toBe(false)
  })

  it('samples every fresh page when all', () => {
    const gate = parseAuditGate('all')
    for (let i = 0; i < 10; i++) expect(shouldSamplePage(gate, i)).toBe(true)
  })

  it('samples positionally 1-in-N (first page, then every Nth)', () => {
    const gate = parseAuditGate('sample:3')
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => shouldSamplePage(gate, i))).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
      true,
    ])
  })
})

describe('resolveShadowModel (issue #367)', () => {
  it('prefers the RUMAQ_OCR_AUDIT_MODEL override', () => {
    expect(resolveShadowModel(['a', 'b'], ' gemini-x ')).toBe('gemini-x')
  })

  it('defaults to the OCR chain second rung', () => {
    expect(resolveShadowModel(['gemini-3.8-flash', 'gemini-3.7-flash'], undefined)).toBe(
      'gemini-3.7-flash'
    )
  })

  it('falls back to the only rung of a pinned one-rung chain', () => {
    expect(resolveShadowModel(['gemini-3.8-flash'], undefined)).toBe('gemini-3.8-flash')
  })
})

describe('diffOcrItems (issue #367)', () => {
  it('matches by lower-cased exact name and agrees on identical fields', () => {
    const acc = newAuditAccumulator()
    diffOcrItems(
      [primary({ name: 'Teh Kotak 250ml' })],
      [{ name: 'teh kotak 250ml', price: 5000 }],
      'page-001.jpg',
      acc
    )
    expect(acc).toMatchObject({
      sampledPages: 1,
      primaryItems: 1,
      nameAgree: 1,
      matchedPairs: 1,
      priceAgree: 1,
      originalAgree: 1,
      promoAgree: 1,
      disagreements: [],
    })
  })

  it('falls back to token Jaccard ≥ 0.6 for near-name matches', () => {
    const acc = newAuditAccumulator()
    // "Indomie Goreng Ayam Geprek" vs "Indomie Goreng Geprek 85 g" — unit
    // token stripped by the normalizer, overlap above the floor.
    diffOcrItems(
      [primary({ name: 'Indomie Goreng Ayam Geprek' })],
      [{ name: 'Indomie Goreng Geprek 85 g', price: 3500 }],
      'page-001.jpg',
      acc
    )
    expect(acc.nameAgree).toBe(1)
    expect(acc.matchedPairs).toBe(1)
  })

  it('records a name disagreement when nothing matches (below the Jaccard floor)', () => {
    const acc = newAuditAccumulator()
    diffOcrItems(
      [primary({ name: 'Beras Ramos 5 kg' })],
      [{ name: 'Minyak Goreng Bimoli 2 L', price: 3500 }],
      'page-001.jpg',
      acc
    )
    expect(acc.nameAgree).toBe(0)
    expect(acc.matchedPairs).toBe(0)
    expect(acc.disagreements).toEqual([
      {
        imageFilename: 'page-001.jpg',
        field: 'name',
        primary: 'Beras Ramos 5 kg',
        shadow: '(no match)',
      },
    ])
  })

  it('compares price / originalPrice / promo presence per matched pair', () => {
    const acc = newAuditAccumulator()
    diffOcrItems(
      [
        primary({ name: 'Teh Kotak', price: 5000, originalPrice: 6500, promo: null }),
        primary({ name: 'Bimoli Mini', price: 18000, originalPrice: null, promo: ['MAX 1'] }),
      ],
      [
        // price misread + original dropped by the shadow.
        { name: 'Teh Kotak', price: 5500 },
        // promo the shadow missed; "Rp 18.000" parses to 18000 (agreement).
        { name: 'Bimoli Mini', price: 'Rp 18.000', promo: null },
      ],
      'page-001.jpg',
      acc
    )
    expect(acc.matchedPairs).toBe(2)
    expect(acc.priceAgree).toBe(1)
    expect(acc.originalAgree).toBe(1)
    expect(acc.promoAgree).toBe(1)
    expect(acc.disagreements).toEqual([
      {
        imageFilename: 'page-001.jpg',
        field: 'price',
        primary: '5000',
        shadow: '5500',
      },
      {
        imageFilename: 'page-001.jpg',
        field: 'originalPrice',
        primary: '6500',
        shadow: 'none',
      },
      {
        imageFilename: 'page-001.jpg',
        field: 'promo',
        primary: 'MAX 1',
        shadow: 'none',
      },
    ])
  })

  it('treats promo as presence — differing wording still agrees', () => {
    const acc = newAuditAccumulator()
    diffOcrItems(
      [primary({ name: 'Sasa Santan', promo: ['MAX 1'] })],
      [{ name: 'sasa santan', price: 5000, promo: ['BUY 1 GET 1'] }],
      'page-001.jpg',
      acc
    )
    expect(acc.promoAgree).toBe(1)
    expect(acc.disagreements).toEqual([])
  })

  it('parses shadow price strings ("Rp 8.500") before comparing', () => {
    const acc = newAuditAccumulator()
    diffOcrItems(
      [primary({ name: 'Gula Pasir', price: 8500 })],
      [{ name: 'Gula Pasir', price: 'Rp 8.500' }],
      'page-001.jpg',
      acc
    )
    expect(acc.priceAgree).toBe(1)
  })

  it('matches distinct shadow items when two primaries collide on the fallback pass', () => {
    const acc = newAuditAccumulator()
    diffOcrItems(
      [primary({ name: 'Teh Kotak 250ml' }), primary({ name: 'Teh Kotak 1 L', price: 9000 })],
      [
        { name: 'Teh Kotak 250 ml', price: 5000 },
        { name: 'Teh Kotak 1000 ml', price: 9000 },
      ],
      'page-001.jpg',
      acc
    )
    // Both matched, each shadow item used once — "250ml" exact-matches the
    // first (case-insensitive), the fallback takes the leftover for "1 L".
    expect(acc.matchedPairs).toBe(2)
    expect(acc.priceAgree).toBe(2)
  })

  it('caps the accumulated disagreements at the contract limit', () => {
    const acc = newAuditAccumulator()
    const primaries = Array.from({ length: 14 }, (_, i) =>
      primary({ name: `Product ${i}`, price: 1000 + i })
    )
    const shadow = primaries.map((p) => ({ name: p.name, price: p.price + 500 }))
    diffOcrItems(primaries, shadow, 'page-001.jpg', acc)
    expect(acc.disagreements).toHaveLength(10)
  })

  it('truncates over-limit strings to the contract caps', () => {
    const acc = newAuditAccumulator()
    diffOcrItems(
      [primary({ name: 'X'.repeat(200), promo: ['Y'.repeat(200)] })],
      [{ name: 'Z'.repeat(200), price: 5000, promo: null }],
      'W'.repeat(200),
      acc
    )
    // No match (names differ) → one name disagreement with truncated strings.
    expect(acc.disagreements).toHaveLength(1)
    expect(acc.disagreements[0]!.imageFilename).toHaveLength(120)
    expect(acc.disagreements[0]!.primary).toHaveLength(120)
  })
})

describe('summarizeAudit (issue #367)', () => {
  it('reports rounded percentages of the right denominators', () => {
    const acc = newAuditAccumulator()
    diffOcrItems(
      [
        primary({ name: 'A Item', price: 5000 }),
        primary({ name: 'B Item', price: 6000 }),
        primary({ name: 'C Item', price: 7000 }),
      ],
      [
        { name: 'A Item', price: 5000 },
        { name: 'B Item', price: 6500 },
      ],
      'page-001.jpg',
      acc
    )
    // 2 of 3 names matched (67%), 1 of 2 pairs agreed on price (50%); with
    // no originalPrice on either side, the null==null pair agrees (100%),
    // and the missing C pair renders one promo... none (both null → agree).
    const summary = summarizeAudit(acc)
    expect(summary).toEqual({
      sampledPages: 1,
      nameAgreePct: 67,
      priceAgreePct: 50,
      originalAgreePct: 100,
      promoAgreePct: 100,
      disagreements: acc.disagreements,
    })
  })

  it('reports vacuous 100 on zero denominators (nothing sampled/matched)', () => {
    const summary = summarizeAudit(newAuditAccumulator())
    expect(summary).toEqual({
      sampledPages: 0,
      nameAgreePct: 100,
      priceAgreePct: 100,
      originalAgreePct: 100,
      promoAgreePct: 100,
      disagreements: [],
    })
  })
})

describe('runShadowAudit (issue #367)', () => {
  it('returns the shadow items on success', async () => {
    const client: GeminiClient = {
      models: {
        generateContent: async () => ({ text: '[{"name": "Teh Kotak", "price": 5000}]' }),
      },
    }
    const shadow = createShadowOcr({ model: 'gemini-3.7-flash', storeSlug: 'superindo', client })
    const items = await Effect.runPromise(
      runShadowAudit(shadow, 'superindo', new Uint8Array([1, 2, 3]), 'image/jpeg')
    )
    expect(items).toEqual([{ name: 'Teh Kotak', price: 5000 }])
  })

  it('swallows every shadow failure into a skipped sample — never the store', async () => {
    const failures: string[] = []
    const client: GeminiClient = {
      models: {
        generateContent: async () => {
          throw new Error('429 Quota exceeded for quota metric GenerateRequests per day')
        },
      },
    }
    const shadow = createShadowOcr({
      model: 'gemini-3.7-flash',
      storeSlug: 'superindo',
      client,
      log: (m) => failures.push(m),
    })
    const items = await Effect.runPromise(
      runShadowAudit(shadow, 'superindo', new Uint8Array([1, 2, 3]), 'image/jpeg', (m) =>
        failures.push(m)
      )
    )
    expect(items).toBeNull()
    expect(failures.some((m) => m.includes('[audit] superindo: shadow OCR failed'))).toBe(true)
  })

  it('is one-shot — a failing shadow call makes exactly one network attempt', async () => {
    let calls = 0
    const client: GeminiClient = {
      models: {
        generateContent: async () => {
          calls++
          throw new Error('503 UNAVAILABLE')
        },
      },
    }
    const shadow = createShadowOcr({ model: 'gemini-3.7-flash', storeSlug: 'superindo', client })
    const items = await Effect.runPromise(
      runShadowAudit(shadow, 'superindo', new Uint8Array([1, 2, 3]), 'image/jpeg')
    )
    expect(items).toBeNull()
    expect(calls).toBe(1)
  })

  it('swallows an unparseable shadow response (parse error path)', async () => {
    const client: GeminiClient = {
      models: { generateContent: async () => ({ text: 'not json at all' }) },
    }
    const shadow = createShadowOcr({ model: 'gemini-3.7-flash', storeSlug: 'superindo', client })
    const items = await Effect.runPromise(
      runShadowAudit(shadow, 'superindo', new Uint8Array([1, 2, 3]), 'image/jpeg')
    )
    expect(items).toBeNull()
  })
})
