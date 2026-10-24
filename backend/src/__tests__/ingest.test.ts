import { describe, it, expect, vi } from 'vite-plus/test'
import { safeParse } from 'valibot'
import { apiApp } from '../apps/api.js'
import { ingestPayloadSchema, ingestPrices } from '../lib/ingest.js'

type FakeRow = Record<string, unknown>
type FakeStatement = { sql: string; params: unknown[] }

function createFakeDb(selects: Array<{ match: RegExp; rows: FakeRow[] }> = []) {
  const executedBatches: FakeStatement[][] = []
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
    async batch(statements: FakeStatement[]) {
      executedBatches.push(statements.map((s) => ({ sql: s.sql, params: s.params })))
      return statements.map(() => ({ success: true }))
    },
  }
  return { db: db as unknown as D1Database, executedBatches }
}

function samplePayload() {
  return safeParse(ingestPayloadSchema, {
    schemaVersion: 1,
    scrapedAt: '2026-10-24T23:00:05Z',
    stores: [{ slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' }],
    items: [
      {
        productKey: 'minyak-goreng--bimoli--1-l',
        name: 'Minyak Goreng Bimoli',
        brand: 'Bimoli',
        unit: '1 L',
        category: null,
        storeSlug: 'lotte-mart',
        price: 21500,
        effectiveUnitPrice: 21500,
        promoType: 'discount_pct',
        promoLabel: 'Diskon 15%',
        validFrom: '2026-10-22',
        validUntil: '2026-10-28',
        matchMethod: 'exact',
        matchConfidence: 1.0,
        brochureUrl: 'https://www.lottemart.co.id/brosur',
      },
      {
        productKey: 'beras--pandan-wangi--5-kg',
        name: 'Beras Pandan Wangi 5 kg',
        brand: 'Pandan Wangi',
        unit: '5 kg',
        storeSlug: 'lotte-mart',
        price: 72000,
        matchConfidence: 0.9,
      },
    ],
  })
}

describe('ingestPayloadSchema', () => {
  it('accepts the canonical payload from the integration plan', () => {
    const result = samplePayload()
    expect(result.success).toBe(true)
  })

  it('rejects an unknown schemaVersion', () => {
    const result = safeParse(ingestPayloadSchema, {
      schemaVersion: 2,
      scrapedAt: '2026-10-24T23:00:05Z',
      stores: [],
      items: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects unknown fields (contract drift must be explicit)', () => {
    const result = safeParse(ingestPayloadSchema, {
      schemaVersion: 1,
      scrapedAt: '2026-10-24T23:00:05Z',
      stores: [],
      items: [],
      surprise: true,
    })
    expect(result.success).toBe(false)
  })

  it('rejects malformed dates, negative prices, and confidence above 1', () => {
    const base = samplePayload()
    expect(base.success).toBe(true)
    if (!base.success) return

    for (const override of [
      { validUntil: '28-10-2026' },
      { price: -1 },
      { matchConfidence: 1.5 },
    ] as const) {
      const result = safeParse(ingestPayloadSchema, {
        ...base.output,
        items: [{ ...base.output.items[0]!, ...override }],
      })
      expect(result.success).toBe(false)
    }
  })
})

describe('ingestPrices', () => {
  it('upserts stores and idempotent observations, creating only new products', async () => {
    const { db, executedBatches } = createFakeDb([
      { match: /^SELECT id, slug FROM price_sources/, rows: [{ id: 'src-1', slug: 'lotte-mart' }] },
      {
        match: /^SELECT product_key FROM price_products/,
        rows: [{ product_key: 'beras--pandan-wangi--5-kg' }],
      },
      {
        match: /^SELECT id, product_key FROM price_products/,
        rows: [
          { id: 'prod-1', product_key: 'minyak-goreng--bimoli--1-l' },
          { id: 'prod-2', product_key: 'beras--pandan-wangi--5-kg' },
        ],
      },
    ])

    const parsed = samplePayload()
    expect(parsed.success).toBe(true)
    if (!parsed.success) return

    const result = await ingestPrices(db, parsed.output)

    expect(result).toEqual({
      accepted: 2,
      productsCreated: 1,
      observationsUpserted: 2,
      skipped: 0,
    })

    const storeStmt = executedBatches[0]![0]!
    expect(storeStmt.sql).toContain('ON CONFLICT(slug) DO UPDATE')
    expect(storeStmt.params).toContain('lotte-mart')

    const productStmts = executedBatches
      .flat()
      .filter((s) => s.sql.includes('INSERT INTO price_products'))
    expect(productStmts).toHaveLength(1)
    expect(productStmts[0]!.params).toContain('minyak-goreng--bimoli--1-l')

    const observationStmts = executedBatches
      .flat()
      .filter((s) => s.sql.includes('INSERT INTO price_observations'))
    expect(observationStmts).toHaveLength(2)
    expect(observationStmts[0]!.sql).toContain(
      'ON CONFLICT(product_id, source_id, observed_date) DO UPDATE'
    )
    // observed_date defaults to the UTC date of scrapedAt
    expect(observationStmts[0]!.params).toContain('2026-10-24')
  })

  it('skips items whose store slug was not declared, without failing the snapshot', async () => {
    const { db } = createFakeDb([
      { match: /^SELECT id, slug FROM price_sources/, rows: [{ id: 'src-1', slug: 'lotte-mart' }] },
      { match: /^SELECT product_key FROM price_products/, rows: [] },
      {
        match: /^SELECT id, product_key FROM price_products/,
        rows: [{ id: 'prod-1', product_key: 'minyak-goreng--bimoli--1-l' }],
      },
    ])

    const parsed = samplePayload()
    expect(parsed.success).toBe(true)
    if (!parsed.success) return

    const result = await ingestPrices(db, {
      ...parsed.output,
      items: [
        ...parsed.output.items,
        { ...parsed.output.items[0]!, storeSlug: 'unknown-store', productKey: 'other--key--1' },
      ],
    })

    expect(result.accepted).toBe(2)
    expect(result.skipped).toBe(1)
  })

  it('does not re-insert products that already exist', async () => {
    const { db, executedBatches } = createFakeDb([
      { match: /^SELECT id, slug FROM price_sources/, rows: [{ id: 'src-1', slug: 'lotte-mart' }] },
      {
        match: /^SELECT product_key FROM price_products/,
        rows: [
          { product_key: 'minyak-goreng--bimoli--1-l' },
          { product_key: 'beras--pandan-wangi--5-kg' },
        ],
      },
      {
        match: /^SELECT id, product_key FROM price_products/,
        rows: [
          { id: 'prod-1', product_key: 'minyak-goreng--bimoli--1-l' },
          { id: 'prod-2', product_key: 'beras--pandan-wangi--5-kg' },
        ],
      },
    ])

    const parsed = samplePayload()
    expect(parsed.success).toBe(true)
    if (!parsed.success) return

    const result = await ingestPrices(db, parsed.output)
    expect(result.productsCreated).toBe(0)
    expect(
      executedBatches.flat().filter((s) => s.sql.includes('INSERT INTO price_products'))
    ).toHaveLength(0)
  })

  it('honours an explicit observedDate over the scrapedAt default', async () => {
    const { db, executedBatches } = createFakeDb([
      { match: /^SELECT id, slug FROM price_sources/, rows: [{ id: 'src-1', slug: 'lotte-mart' }] },
      { match: /^SELECT product_key FROM price_products/, rows: [] },
      {
        match: /^SELECT id, product_key FROM price_products/,
        rows: [{ id: 'prod-1', product_key: 'minyak-goreng--bimoli--1-l' }],
      },
    ])

    const parsed = samplePayload()
    expect(parsed.success).toBe(true)
    if (!parsed.success) return

    await ingestPrices(db, {
      ...parsed.output,
      items: [{ ...parsed.output.items[0]!, observedDate: '2026-09-01' }],
    })

    const observationStmts = executedBatches
      .flat()
      .filter((s) => s.sql.includes('INSERT INTO price_observations'))
    expect(observationStmts[0]!.params).toContain('2026-09-01')
    expect(observationStmts[0]!.params).not.toContain('2026-10-24')
  })
})

describe('POST /api/internal/ingest/prices', () => {
  const validPayload = () => {
    const parsed = samplePayload()
    if (!parsed.success) throw new Error('fixture payload must be valid')
    return parsed.output
  }

  function createEnv(db: D1Database, secret?: string) {
    return {
      DB: db,
      RECEIPTS: { put: vi.fn(), get: vi.fn() },
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      WORKER_JWT_SECRET: 'test-secret',
      WORKER_ENCRYPTION_KEY: 'test-encryption-key-32-bytes-long!!',
      EMAIL_AUTH_ENABLED: 'false',
      ASSETS: undefined as unknown as Fetcher,
      props: undefined,
      TEST_MODE: 'true',
      HAQITA_INGEST_SECRET: secret,
    }
  }

  it('returns 503 when the ingest secret is not configured', async () => {
    const { db } = createFakeDb()
    const res = await apiApp.request(
      '/api/internal/ingest/prices',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer anything' },
        body: JSON.stringify(validPayload()),
      },
      createEnv(db)
    )
    expect(res.status).toBe(503)
  })

  it('returns 401 for a wrong or missing bearer token', async () => {
    const { db } = createFakeDb()
    const env = createEnv(db, 'secret-123')

    const noHeader = await apiApp.request(
      '/api/internal/ingest/prices',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload()),
      },
      env
    )
    expect(noHeader.status).toBe(401)

    const wrongToken = await apiApp.request(
      '/api/internal/ingest/prices',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
        body: JSON.stringify(validPayload()),
      },
      env
    )
    expect(wrongToken.status).toBe(401)
  })

  it('returns 400 for a payload that fails the contract', async () => {
    const { db } = createFakeDb()
    const res = await apiApp.request(
      '/api/internal/ingest/prices',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-123' },
        body: JSON.stringify({ schemaVersion: 1, stores: [], items: 'nope' }),
      },
      createEnv(db, 'secret-123')
    )
    expect(res.status).toBe(400)
  })

  it('accepts a valid snapshot and reports counters', async () => {
    const { db, executedBatches } = createFakeDb([
      { match: /^SELECT id, slug FROM price_sources/, rows: [{ id: 'src-1', slug: 'lotte-mart' }] },
      {
        match: /^SELECT product_key FROM price_products/,
        rows: [{ product_key: 'beras--pandan-wangi--5-kg' }],
      },
      {
        match: /^SELECT id, product_key FROM price_products/,
        rows: [
          { id: 'prod-1', product_key: 'minyak-goreng--bimoli--1-l' },
          { id: 'prod-2', product_key: 'beras--pandan-wangi--5-kg' },
        ],
      },
    ])

    const res = await apiApp.request(
      '/api/internal/ingest/prices',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-123' },
        body: JSON.stringify(validPayload()),
      },
      createEnv(db, 'secret-123')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      accepted: 2,
      productsCreated: 1,
      observationsUpserted: 2,
      skipped: 0,
    })
    expect(executedBatches.length).toBeGreaterThan(0)
  })
})
