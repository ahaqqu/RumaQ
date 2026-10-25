import { describe, it, expect } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'

type FakeRow = Record<string, unknown>

function createPricesEnv(
  rows: {
    list?: FakeRow[]
    product?: FakeRow | null
    current?: FakeRow[]
    history?: FakeRow[]
  },
  opts: { authenticated?: boolean } = {}
) {
  const prepareCalls: Array<{ sql: string; params: unknown[] }> = []
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
          prepareCalls.push({ sql, params: stmt.params })
          if (sql.includes('ORDER BY o.observed_date ASC')) {
            return { results: rows.history ?? [] }
          }
          if (sql.includes('ORDER BY o.price ASC')) {
            return { results: rows.current ?? [] }
          }
          return { results: rows.list ?? [] }
        },
        async first() {
          if (sql.includes('FROM price_products WHERE product_key')) {
            return rows.product === undefined ? null : rows.product
          }
          return null
        },
        async run() {
          return { success: true }
        },
      }
      return stmt
    },
    async batch(statements: Array<{ sql: string; params: unknown[] }>) {
      return statements.map(() => ({ success: true }))
    },
  }
  return {
    env: {
      DB: db,
      RECEIPTS: {},
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      WORKER_JWT_SECRET: 'test-secret',
      WORKER_ENCRYPTION_KEY: 'test-encryption-key-32-bytes-long!!',
      EMAIL_AUTH_ENABLED: 'false',
      ASSETS: undefined as unknown as Fetcher,
      props: opts.authenticated === false ? undefined : { userId: 'u1', householdId: 'h1' },
      TEST_MODE: 'true',
    },
    prepareCalls,
  }
}

const listRow = {
  product_key: 'minyak-goreng--bimoli--1-l',
  name: 'Minyak Goreng Bimoli',
  brand: 'Bimoli',
  unit: '1 L',
  category: null,
  source_slug: 'lotte-mart',
  source_name: 'Lotte Mart',
  observed_date: '2026-10-24',
  price: 21500,
  effective_unit_price: 21500,
  promo_type: 'discount_pct',
  promo_label: 'Diskon 15%',
  valid_from: '2026-10-22',
  valid_until: '2026-10-28',
  match_method: 'exact',
  match_confidence: 1.0,
  brochure_url: 'https://www.lottemart.co.id/brosur',
}

describe('GET /api/prices', () => {
  it('requires authentication', async () => {
    const { env } = createPricesEnv({ list: [] }, { authenticated: false })
    const res = await apiApp.request('/api/prices', {}, env)
    expect(res.status).toBe(401)
  })

  it('returns latest observations with the low-confidence flag', async () => {
    const { env } = createPricesEnv({
      list: [
        listRow,
        { ...listRow, source_slug: 'superindo', source_name: 'Superindo', match_confidence: 0.7 },
      ],
    })
    const res = await apiApp.request('/api/prices', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')

    const body = (await res.json()) as {
      items: Array<typeof listRow & { low_confidence: boolean }>
      total: number
    }
    expect(body.total).toBe(2)
    expect(body.items[0]!.low_confidence).toBe(false)
    expect(body.items[1]!.low_confidence).toBe(true)
  })

  it('escapes LIKE wildcards in the q filter', async () => {
    const { env, prepareCalls } = createPricesEnv({ list: [] })
    const res = await apiApp.request('/api/prices?q=100%25', {}, env)
    expect(res.status).toBe(200)

    const listCall = prepareCalls.find((call) => call.sql.includes('LIKE'))
    expect(listCall).toBeDefined()
    expect(listCall!.params).toContain('%100\\%%')
  })

  it('filters by source slug with a bound parameter', async () => {
    const { env, prepareCalls } = createPricesEnv({ list: [] })
    const res = await apiApp.request('/api/prices?source=lotte-mart', {}, env)
    expect(res.status).toBe(200)

    const listCall = prepareCalls.find((call) => call.sql.includes('s.slug = ?'))
    expect(listCall).toBeDefined()
    expect(listCall!.params).toContain('lotte-mart')
  })
})

describe('GET /api/prices/:productKey', () => {
  const product = {
    product_key: 'minyak-goreng--bimoli--1-l',
    name: 'Minyak Goreng Bimoli',
    brand: 'Bimoli',
    unit: '1 L',
    category: null,
    first_seen_at: '2026-10-01T00:00:00Z',
    last_seen_at: '2026-10-24T00:00:00Z',
  }

  it('requires authentication', async () => {
    const { env } = createPricesEnv({ product }, { authenticated: false })
    const res = await apiApp.request('/api/prices/some-key', {}, env)
    expect(res.status).toBe(401)
  })

  it('returns 404 for an unknown product', async () => {
    const { env } = createPricesEnv({ product: null })
    const res = await apiApp.request('/api/prices/nope--nope--1', {}, env)
    expect(res.status).toBe(404)
  })

  it('returns product detail with per-store current prices and history', async () => {
    const { env } = createPricesEnv({
      product,
      current: [
        {
          source_slug: 'lotte-mart',
          source_name: 'Lotte Mart',
          observed_date: '2026-10-24',
          price: 21500,
          effective_unit_price: 21500,
          promo_type: 'discount_pct',
          promo_label: 'Diskon 15%',
          valid_from: '2026-10-22',
          valid_until: '2026-10-28',
          match_method: 'exact',
          match_confidence: 1.0,
          brochure_url: null,
        },
      ],
      history: [
        {
          source_slug: 'lotte-mart',
          observed_date: '2026-10-20',
          price: 25000,
          promo_type: null,
          promo_label: null,
          valid_from: null,
          valid_until: null,
          match_method: 'exact',
          match_confidence: 1.0,
        },
      ],
    })

    const res = await apiApp.request('/api/prices/minyak-goreng--bimoli--1-l', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')

    const body = (await res.json()) as {
      product: typeof product
      current: Array<{ source_slug: string; low_confidence: boolean }>
      history: Array<{ source_slug: string; observed_date: string }>
    }
    expect(body.product.product_key).toBe('minyak-goreng--bimoli--1-l')
    expect(body.current).toHaveLength(1)
    expect(body.current[0]!.low_confidence).toBe(false)
    expect(body.history).toHaveLength(1)
    expect(body.history[0]!.observed_date).toBe('2026-10-20')
  })
})
