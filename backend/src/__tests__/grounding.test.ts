import { describe, it, expect } from 'vite-plus/test'
import { groundPlanItem, scoreGroundingMatch, unitTokens } from '../lib/grounding.js'

type FakeRow = Record<string, unknown>

function createFakeDb(selects: Array<{ match: RegExp; rows: FakeRow[] }> = []) {
  const db = {
    prepare(sql: string) {
      const stmt = {
        sql,
        params: [] as unknown[],
        bind(...params: unknown[]) {
          stmt.params = params
          return stmt
        },
        async all() {
          const hit = selects.find((s) => s.match.test(sql))
          return { results: hit ? hit.rows : [] }
        },
        async first() {
          const hit = selects.find((s) => s.match.test(sql))
          return hit && hit.rows.length > 0 ? hit.rows[0] : null
        },
        async run() {
          return { success: true }
        },
      }
      return stmt
    },
    async batch(bound: unknown[]) {
      return bound
    },
  }
  return db as unknown as D1Database
}

describe('scoreGroundingMatch', () => {
  it('scores identical names as 1.0', () => {
    expect(scoreGroundingMatch('Beras Pandan Wangi', 'Beras Pandan Wangi')).toBe(1)
  })

  it('ignores case, punctuation, and extra whitespace', () => {
    expect(scoreGroundingMatch('Beras Pandan Wangi!', 'beras  pandan   wangi')).toBe(1)
  })

  it('scores containment (item ⊂ product) as 0.85', () => {
    expect(scoreGroundingMatch('Gula Pasir', 'Gula Pasir Gulaku 1 kg')).toBe(0.85)
  })

  it('does not ground on single-word containment', () => {
    // "beras" ⊂ every beras product — far too weak.
    expect(scoreGroundingMatch('Beras', 'Beras Ramos Premium 5 kg')).toBeLessThan(0.8)
  })

  it('rejects unrelated names with a low score', () => {
    expect(scoreGroundingMatch('Minyak Goreng Bimoli', 'Teh Celup Sariwangi')).toBeLessThan(0.5)
  })

  it('scores partial token overlap below the grounding threshold', () => {
    // "Minyak Bimoli" misses the "goreng" token; not a contiguous substring
    // either, so only jaccard (2/3) applies — below the 0.8 bar.
    expect(scoreGroundingMatch('Minyak Bimoli', 'Minyak Goreng Bimoli')).toBeLessThan(0.8)
  })
})

describe('groundPlanItem', () => {
  const productRow = {
    id: 'product-1',
    product_key: 'beras--pandan-wangi--5-kg',
    name: 'Beras Pandan Wangi',
    brand: 'Pandan Wangi',
  }

  it('returns the cheapest current observation on a confident match', async () => {
    const db = createFakeDb([
      { match: /FROM price_products/, rows: [productRow] },
      {
        match: /FROM price_observations/,
        // The SQL orders by price ASC LIMIT 1 — the fake mirrors its output.
        rows: [
          {
            id: 'obs-lotte',
            price: 69000,
            valid_until: '2026-10-28',
            source_slug: 'lotte-mart',
            source_name: 'Lotte Mart',
          },
        ],
      },
    ])
    const match = await groundPlanItem(db, 'Beras Pandan Wangi 5 kg')
    expect(match).not.toBeNull()
    expect(match!.productKey).toBe('beras--pandan-wangi--5-kg')
    expect(match!.observation.observationId).toBe('obs-lotte')
    expect(match!.observation.price).toBe(69000)
    expect(match!.observation.sourceName).toBe('Lotte Mart')
  })

  it('returns null when no candidate clears the confidence bar', async () => {
    const db = createFakeDb([
      { match: /FROM price_products/, rows: [{ ...productRow, name: 'Teh Celup Sariwangi' }] },
    ])
    expect(await groundPlanItem(db, 'Minyak Goreng Bimoli 1 L')).toBeNull()
  })

  it('returns null when the prefilter has no rows', async () => {
    const db = createFakeDb()
    expect(await groundPlanItem(db, 'Beras Pandan Wangi')).toBeNull()
  })

  it('returns null for names with no content tokens', async () => {
    const db = createFakeDb()
    expect(await groundPlanItem(db, '5 kg')).toBeNull()
  })
})

describe('unitTokens', () => {
  it('extracts quantity and unit words only', () => {
    expect(unitTokens('Beras Pandan Wangi 5 kg')).toEqual(['5', 'kg'])
  })

  it('returns nothing for names without package info', () => {
    expect(unitTokens('Beras Pandan Wangi')).toEqual([])
  })
})

describe('groundPlanItem tie-break', () => {
  // Same name and brand, different package sizes: the exact failure mode of
  // the old first-row-wins selection.
  const fiveKgRow = {
    id: 'product-5kg',
    product_key: 'beras--pandan-wangi--5-kg',
    name: 'Beras Pandan Wangi',
    brand: 'Pandan Wangi',
    unit: '5 kg',
  }
  const oneKgRow = {
    id: 'product-1kg',
    product_key: 'beras--pandan-wangi--1-kg',
    name: 'Beras Pandan Wangi',
    brand: 'Pandan Wangi',
    unit: '1 kg',
  }
  const observationRow = {
    id: 'obs-5kg',
    price: 69000,
    valid_until: '2026-10-28',
    source_slug: 'lotte-mart',
    source_name: 'Lotte Mart',
  }

  it('prefers the unit-matching candidate when name and brand tie', async () => {
    // 1-kg row arrives first even though the item asks for 5 kg.
    const db = createFakeDb([
      { match: /FROM price_products/, rows: [oneKgRow, fiveKgRow] },
      { match: /FROM price_observations/, rows: [observationRow] },
    ])
    const match = await groundPlanItem(db, 'Beras Pandan Wangi 5 kg')
    expect(match).not.toBeNull()
    expect(match!.productKey).toBe('beras--pandan-wangi--5-kg')
    expect(match!.observation.price).toBe(69000)
  })

  it('picks the same winner regardless of DB row order', async () => {
    const db = createFakeDb([
      { match: /FROM price_products/, rows: [fiveKgRow, oneKgRow] },
      { match: /FROM price_observations/, rows: [observationRow] },
    ])
    const match = await groundPlanItem(db, 'Beras Pandan Wangi 5 kg')
    expect(match!.productKey).toBe('beras--pandan-wangi--5-kg')
  })

  it('falls back to product_key order when no unit signal exists', async () => {
    // Item carries no package size: unit-match counts tie at 0, so the
    // lexicographic product_key decides instead of row order.
    const db = createFakeDb([
      { match: /FROM price_products/, rows: [fiveKgRow, oneKgRow] },
      { match: /FROM price_observations/, rows: [observationRow] },
    ])
    const match = await groundPlanItem(db, 'Beras Pandan Wangi')
    expect(match!.productKey).toBe('beras--pandan-wangi--1-kg')
  })

  it('anchors the prefilter with a deterministic ORDER BY', async () => {
    const db = createFakeDb([{ match: /FROM price_products/, rows: [fiveKgRow] }]) as any
    const sqls: string[] = []
    const originalPrepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      sqls.push(sql)
      return originalPrepare(sql)
    }
    await groundPlanItem(db, 'Beras Pandan Wangi 5 kg')
    const prefilter = sqls.find((sql) => sql.includes('FROM price_products'))
    expect(prefilter).toContain('ORDER BY name COLLATE NOCASE, product_key')
  })
})
