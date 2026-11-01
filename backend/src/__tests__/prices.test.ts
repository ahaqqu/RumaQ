import { describe, it, expect } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import { LATEST_OBSERVATION_PREDICATE } from '../lib/prices.js'

type FakeRow = Record<string, unknown>

function createPricesEnv(
  rows: {
    list?: FakeRow[]
    product?: FakeRow | null
    current?: FakeRow[]
    history?: FakeRow[]
    status?: FakeRow | null
    promoTotals?: FakeRow[]
    promoSources?: FakeRow[]
    promoExamples?: FakeRow[]
    promoTotal?: FakeRow[]
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
          if (sql.includes('ORDER BY COALESCE(o.effective_unit_price, o.price) ASC, s.slug ASC')) {
            return { results: rows.current ?? [] }
          }
          return { results: rows.list ?? [] }
        },
        async first() {
          if (sql.includes('FROM price_products WHERE product_key')) {
            return rows.product === undefined ? null : rows.product
          }
          if (sql.includes('MAX(observed_date)')) {
            return rows.status === undefined ? null : rows.status
          }
          return null
        },
        async run() {
          return { success: true }
        },
      }
      return stmt
    },
    async batch(statements: Array<{ sql: string; params?: unknown[] }>) {
      // Batched statements never hit all(), so record them for the SQL
      // assertions; unique `-- promos: <name>` markers route canned results
      // per statement (the real D1 executes the SQL).
      for (const stmt of statements) {
        prepareCalls.push({ sql: stmt.sql, params: stmt.params ?? [] })
      }
      return statements.map((stmt) => {
        if (stmt.sql.includes('-- promos: totals')) {
          return { results: rows.promoTotals ?? [], success: true }
        }
        if (stmt.sql.includes('-- promos: sources')) {
          return { results: rows.promoSources ?? [], success: true }
        }
        if (stmt.sql.includes('-- promos: examples')) {
          return { results: rows.promoExamples ?? [], success: true }
        }
        if (stmt.sql.includes('-- promos: total')) {
          return { results: rows.promoTotal ?? [], success: true }
        }
        return { success: true }
      })
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
  // Canonical unit normalization (issue #368 phase A) — null on rows the
  // producer could not normalize.
  unit_qty: 2000,
  unit_qty_unit: 'ml',
  unit_price: 10750,
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

  // Issue #368 phase A: the canonical unit fields mirror the observation
  // columns additively on both the flat and the sorted list paths.
  it('carries the canonical unit fields on the flat and sorted list paths', async () => {
    for (const sort of [undefined, 'cheapest'] as const) {
      const { env } = createPricesEnv({
        list: [
          listRow,
          // a not-normalized row rides through with nulls
          {
            ...listRow,
            product_key: 'misteri--item----',
            unit_qty: null,
            unit_qty_unit: null,
            unit_price: null,
          },
        ],
      })
      const res = await apiApp.request(`/api/prices${sort ? `?sort=${sort}` : ''}`, {}, env)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: Array<typeof listRow> }
      expect(body.items[0]!.unit_qty).toBe(2000)
      expect(body.items[0]!.unit_qty_unit).toBe('ml')
      expect(body.items[0]!.unit_price).toBe(10750)
      expect(body.items[1]!.unit_price).toBeNull()
    }
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

describe('GET /api/prices sort', () => {
  it('absent sort keeps the legacy flat query and the exact legacy response shape', async () => {
    const { env, prepareCalls } = createPricesEnv({ list: [listRow] })
    const res = await apiApp.request('/api/prices', {}, env)
    expect(res.status).toBe(200)

    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['items', 'total'])

    const listCall = prepareCalls.find((call) => call.sql.includes('FROM price_observations'))!
    expect(listCall.sql).not.toContain('WITH latest AS')
    expect(listCall.sql).toContain('ORDER BY p.name COLLATE NOCASE, s.name COLLATE NOCASE')
    expect(listCall.sql).toContain('LIMIT 200')
  })

  it('rejects an unknown sort value', async () => {
    const { env } = createPricesEnv({ list: [] })
    const res = await apiApp.request('/api/prices?sort=popular', {}, env)
    expect(res.status).toBe(400)
  })

  it('pages products after aggregation (LIMIT 201) for every sort value', async () => {
    for (const sort of ['name', 'cheapest', 'savings', 'expiry'] as const) {
      const { env, prepareCalls } = createPricesEnv({ list: [] })
      const res = await apiApp.request(`/api/prices?sort=${sort}`, {}, env)
      expect(res.status).toBe(200)

      const listCall = prepareCalls.find((call) => call.sql.includes('WITH latest AS'))
      expect(listCall, `sort=${sort}`).toBeDefined()
      expect(listCall!.sql).toContain(
        'COALESCE(o.effective_unit_price, o.price) AS effective_price'
      )
      expect(listCall!.sql).toContain('ROW_NUMBER() OVER')
      expect(listCall!.sql).toContain(`LIMIT 201`)
      // The sort expression drives both the page CTE and the outer query so
      // row order equals product order.
      expect(listCall!.sql.match(new RegExp(`ORDER BY`, 'g'))?.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('sort=cheapest orders product minima of the effective price', async () => {
    const { env, prepareCalls } = createPricesEnv({ list: [] })
    const res = await apiApp.request('/api/prices?sort=cheapest', {}, env)
    expect(res.status).toBe(200)

    const listCall = prepareCalls.find((call) => call.sql.includes('WITH latest AS'))!
    expect(listCall.sql).toContain('ORDER BY a.price_min, pp.name COLLATE NOCASE, a.product_key')
    expect(listCall.sql).toContain('ORDER BY a.price_min, l.name COLLATE NOCASE')
  })

  it('sort=savings orders savings_pct desc with 0-gap products last', async () => {
    const { env, prepareCalls } = createPricesEnv({ list: [] })
    const res = await apiApp.request('/api/prices?sort=savings', {}, env)
    expect(res.status).toBe(200)

    const listCall = prepareCalls.find((call) => call.sql.includes('WITH latest AS'))!
    expect(listCall.sql).toContain('CASE WHEN a.price_max > a.price_min THEN 0 ELSE 1 END')
    expect(listCall.sql).toContain('a.savings_pct DESC')
  })

  it('sort=expiry orders the cheapest offer validity with nulls last', async () => {
    const { env, prepareCalls } = createPricesEnv({ list: [] })
    const res = await apiApp.request('/api/prices?sort=expiry', {}, env)
    expect(res.status).toBe(200)

    const listCall = prepareCalls.find((call) => call.sql.includes('WITH latest AS'))!
    expect(listCall.sql).toContain(
      'CASE WHEN ch.cheapest_valid_until IS NULL THEN 1 ELSE 0 END, ch.cheapest_valid_until'
    )
  })

  it('never interpolates the source filter into the sorted SQL', async () => {
    const { env, prepareCalls } = createPricesEnv({ list: [] })
    const res = await apiApp.request('/api/prices?source=lotte-mart&sort=cheapest', {}, env)
    expect(res.status).toBe(200)

    const listCall = prepareCalls.find((call) => call.sql.includes('WITH latest AS'))!
    expect(listCall.sql).toContain('s.slug = ?')
    expect(listCall.sql).not.toContain('lotte-mart')
    expect(listCall.params).toContain('lotte-mart')
  })

  it('applies the q filter inside the CTE so aggregates reflect the filtered set', async () => {
    const { env, prepareCalls } = createPricesEnv({ list: [] })
    const res = await apiApp.request('/api/prices?q=minyak&sort=savings', {}, env)
    expect(res.status).toBe(200)

    const listCall = prepareCalls.find((call) => call.sql.includes('WITH latest AS'))!
    expect(listCall.params).toContain('%minyak%')
    // Filters must sit inside `latest`, i.e. before the window CTE.
    const filterAt = listCall.sql.indexOf('AND (p.name LIKE')
    const windowAt = listCall.sql.indexOf('ROW_NUMBER() OVER')
    expect(filterAt).toBeGreaterThan(-1)
    expect(filterAt).toBeLessThan(windowAt)
  })

  it('returns product aggregates and the truncated flag when a 201st product exists', async () => {
    const rows: FakeRow[] = Array.from({ length: 201 }, (_, i) => ({
      ...listRow,
      product_key: `product-${i}`,
      price_min: 1000 + i,
      price_max: 2000 + i,
      savings_pct: 5.5,
      cheapest_source_slug: 'lotte-mart',
      cheapest_valid_until: '2026-10-28',
    }))
    const { env } = createPricesEnv({ list: rows })
    const res = await apiApp.request('/api/prices?sort=cheapest', {}, env)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      items: Array<Record<string, unknown> & { product_key: string }>
      total: number
      truncated: boolean
    }
    expect(body.truncated).toBe(true)
    expect(body.total).toBe(201)
    expect(body.items[0]).toMatchObject({
      price_min: 1000,
      price_max: 2000,
      savings_pct: 5.5,
      cheapest_source_slug: 'lotte-mart',
      cheapest_valid_until: '2026-10-28',
    })
  })

  it('reports truncated=false when 200 rows all belong to 200 products or fewer', async () => {
    // 200 rows spanning only 100 products: the old row-count heuristic would
    // have cried wolf — the flag must key off distinct products.
    const rows: FakeRow[] = []
    for (let i = 0; i < 100; i++) {
      rows.push({ ...listRow, product_key: `product-${i}` })
      rows.push({
        ...listRow,
        product_key: `product-${i}`,
        source_slug: 'superindo',
        source_name: 'Superindo',
      })
    }
    const { env } = createPricesEnv({ list: rows })
    const res = await apiApp.request('/api/prices?sort=cheapest', {}, env)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { total: number; truncated: boolean }
    expect(body.total).toBe(200)
    expect(body.truncated).toBe(false)
  })
})

describe('GET /api/prices/meta', () => {
  const status = {
    latest_observed_date: '2026-10-24',
    latest_scraped_at: '2026-10-24T23:00:05Z',
    observation_count: 3,
  }

  it('requires authentication', async () => {
    const { env } = createPricesEnv({ status }, { authenticated: false })
    const res = await apiApp.request('/api/prices/meta', {}, env)
    expect(res.status).toBe(401)
  })

  it('returns the freshness status without falling through to the detail route', async () => {
    const { env, prepareCalls } = createPricesEnv({ status })
    const res = await apiApp.request('/api/prices/meta', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')

    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({
      latestObservedDate: '2026-10-24',
      latestScrapedAt: '2026-10-24T23:00:05Z',
      observationCount: 3,
    })
    // "meta" must never be treated as a productKey by the detail handler.
    expect(
      prepareCalls.some((call) => call.sql.includes('FROM price_products WHERE product_key'))
    ).toBe(false)
  })

  it('returns null freshness fields before the first ingest', async () => {
    const { env } = createPricesEnv({ status: null })
    const res = await apiApp.request('/api/prices/meta', {}, env)
    expect(res.status).toBe(200)

    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({ latestObservedDate: null, latestScrapedAt: null, observationCount: 0 })
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

  it('orders current offers by effective price with a source-slug tiebreak', async () => {
    const { env, prepareCalls } = createPricesEnv({
      product,
      current: [
        {
          source_slug: 'superindo',
          source_name: 'Superindo',
          observed_date: '2026-10-24',
          // Raw price 26000 but effective 23000: the effective-price basis
          // must put this store first even though its tag price is higher.
          price: 26000,
          effective_unit_price: 23000,
          promo_type: 'discount_pct',
          promo_label: 'Diskon 15%',
          valid_from: null,
          valid_until: '2026-10-28',
          match_method: 'exact',
          match_confidence: 1.0,
          brochure_url: null,
        },
        {
          source_slug: 'lotte-mart',
          source_name: 'Lotte Mart',
          observed_date: '2026-10-24',
          price: 25000,
          effective_unit_price: null,
          promo_type: null,
          promo_label: null,
          valid_from: null,
          valid_until: null,
          match_method: 'exact',
          match_confidence: 1.0,
          brochure_url: null,
        },
      ],
    })

    const res = await apiApp.request('/api/prices/minyak-goreng--bimoli--1-l', {}, env)
    expect(res.status).toBe(200)

    const currentCall = prepareCalls.find((call) => call.sql.includes('FROM price_observations'))!
    expect(currentCall.sql).toContain(
      'ORDER BY COALESCE(o.effective_unit_price, o.price) ASC, s.slug ASC'
    )

    const body = (await res.json()) as { current: Array<{ source_slug: string }> }
    expect(body.current).toHaveLength(2)
    // Fake rows arrive in effective-price order — the handler preserves it.
    expect(body.current[0]!.source_slug).toBe('superindo')
  })
})

describe('GET /api/prices/promos', () => {
  const exampleRow = (overrides: FakeRow = {}): FakeRow => ({
    group_key: 'discount_pct',
    product_key: 'minyak-goreng--bimoli--1-l',
    name: 'Minyak Goreng Bimoli',
    brand: 'Bimoli',
    unit: '1 L',
    source_slug: 'lotte-mart',
    source_name: 'Lotte Mart',
    price: 21500,
    effective_unit_price: 21500,
    ...overrides,
  })

  it('requires authentication', async () => {
    const { env } = createPricesEnv({ promoTotal: [] }, { authenticated: false })
    const res = await apiApp.request('/api/prices/promos', {}, env)
    expect(res.status).toBe(401)
  })

  it('answers the catalog instead of falling through to the detail route', async () => {
    const { env, prepareCalls } = createPricesEnv({
      promoTotals: [{ group_key: 'discount_pct', product_count: 1 }],
      promoSources: [{ group_key: 'discount_pct', source_slug: 'lotte-mart', product_count: 1 }],
      promoExamples: [exampleRow()],
      promoTotal: [{ total: 1 }],
    })
    const res = await apiApp.request('/api/prices/promos', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')

    const body = (await res.json()) as {
      types: Array<{
        promo_type: string
        product_count: number
        stores: Record<string, number>
        example_products: Array<Record<string, unknown>>
      }>
      total: number
    }
    expect(body.types[0]!.promo_type).toBe('discount_pct')
    expect(body.types[0]!.product_count).toBe(1)
    expect(body.types[0]!.stores).toEqual({ 'lotte-mart': 1 })
    expect(body.types[0]!.example_products[0]).toMatchObject({
      product_key: 'minyak-goreng--bimoli--1-l',
      name: 'Minyak Goreng Bimoli',
      source_slug: 'lotte-mart',
      source_name: 'Lotte Mart',
      price: 21500,
      effective_unit_price: 21500,
    })
    expect(body.total).toBe(1)
    // "promos" must never be treated as a productKey by the detail handler.
    expect(
      prepareCalls.some((call) => call.sql.includes('FROM price_products WHERE product_key'))
    ).toBe(false)
  })

  it('orders groups by the fixed enum order and omits empty ones', async () => {
    const { env } = createPricesEnv({
      promoTotals: [
        { group_key: 'other', product_count: 2 },
        { group_key: 'discount_pct', product_count: 3 },
      ],
      promoTotal: [{ total: 5 }],
    })
    const res = await apiApp.request('/api/prices/promos', {}, env)
    const body = (await res.json()) as { types: Array<{ promo_type: string }> }
    // 'other' sorts last; absent types are omitted entirely.
    expect(body.types.map((g) => g.promo_type)).toEqual(['discount_pct', 'other'])
  })

  it('takes the group product_count from totals, not the per-source sum', async () => {
    // Double-count hazard: one product on promo at two sources shows 1
    // distinct product in the group but 2 across the stores badges.
    const { env } = createPricesEnv({
      promoTotals: [{ group_key: 'discount_pct', product_count: 1 }],
      promoSources: [
        { group_key: 'discount_pct', source_slug: 'lotte-mart', product_count: 1 },
        { group_key: 'discount_pct', source_slug: 'superindo', product_count: 1 },
      ],
      promoTotal: [{ total: 1 }],
    })
    const res = await apiApp.request('/api/prices/promos', {}, env)
    const body = (await res.json()) as {
      types: Array<{ product_count: number; stores: Record<string, number> }>
    }
    expect(body.types[0]!.product_count).toBe(1)
    expect(body.types[0]!.stores).toEqual({ 'lotte-mart': 1, superindo: 1 })
  })

  it('routes unknown and NULL-type rows through the Other group by construction', async () => {
    const { env, prepareCalls } = createPricesEnv({
      promoTotals: [
        { group_key: 'get_free', product_count: 1 },
        { group_key: 'other', product_count: 2 },
      ],
      promoSources: [{ group_key: 'other', source_slug: 'lotte-mart', product_count: 2 }],
      promoExamples: [
        // Absorption inputs the SQL must handle: an unknown future enum value
        // and a NULL type with a label both group into 'other'.
        exampleRow({
          group_key: 'other',
          product_key: 'tepung--segitiga-biru--1-kg',
          name: 'Tepung Segitiga Biru 1 kg',
          promo_type: null,
          promo_label: 'Beli 2 gratis 1',
        }),
        exampleRow({
          group_key: 'other',
          product_key: 'mystery--future--1-pcs',
          name: 'Mystery Future Item',
          promo_type: 'mystery_future',
          promo_label: 'Mystery deal',
        }),
      ],
      promoTotal: [{ total: 3 }],
    })
    const res = await apiApp.request('/api/prices/promos', {}, env)
    const body = (await res.json()) as {
      types: Array<{ promo_type: string; example_products: Array<{ product_key: string }> }>
    }
    expect(body.types.map((g) => g.promo_type)).toEqual(['get_free', 'other'])
    expect(body.types[1]!.example_products.map((p) => p.product_key)).toEqual([
      'tepung--segitiga-biru--1-kg',
      'mystery--future--1-pcs',
    ])

    // The CASE … ELSE 'other' over the closed 5-value enum is the only place
    // those values live — unknown and NULL types cannot escape it.
    const totalsCall = prepareCalls.find((call) => call.sql.includes('-- promos: totals'))!
    expect(totalsCall.sql).toContain("THEN o.promo_type ELSE 'other' END")
    expect(totalsCall.sql).toContain(
      "'discount_pct','discount_fixed','get_free','bundle_buy','multi_price'"
    )
    // The evidence filter rides on the totals too — without it plain
    // non-promo rows fall into 'other' and pollute the group counts.
    expect(totalsCall.sql).toContain(
      "o.promo_type IS NOT NULL OR (o.promo_label IS NOT NULL AND o.promo_label <> '')"
    )
  })

  it('returns an empty catalog before any promo evidence', async () => {
    const { env } = createPricesEnv({ promoTotal: [] })
    const res = await apiApp.request('/api/prices/promos', {}, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ types: [], total: 0 })
  })

  it('pins the shared predicate: list and catalog SQL carry the identical base', async () => {
    // Layer-1 count-parity guarantee: the identical LATEST_OBSERVATION_PREDICATE
    // string (latest-obs subquery + 0.55 confidence floor) rides in both.
    const { env, prepareCalls } = createPricesEnv({ list: [], promoTotals: [] })
    await apiApp.request('/api/prices', {}, env)
    await apiApp.request('/api/prices/promos', {}, env)

    const listCall = prepareCalls.find(
      (call) => call.sql.includes('FROM price_observations') && !call.sql.includes('-- promos:')
    )
    const totalsCall = prepareCalls.find((call) => call.sql.includes('-- promos: totals'))
    expect(listCall).toBeDefined()
    expect(totalsCall).toBeDefined()
    expect(listCall!.sql).toContain(LATEST_OBSERVATION_PREDICATE)
    expect(totalsCall!.sql).toContain(LATEST_OBSERVATION_PREDICATE)
  })

  it('structures the examples SQL: ≤5 per group, name-ordered, cheapest-offer basis', async () => {
    const { env, prepareCalls } = createPricesEnv({ promoTotals: [] })
    await apiApp.request('/api/prices/promos', {}, env)

    const examplesCall = prepareCalls.find((call) => call.sql.includes('-- promos: examples'))!
    expect(examplesCall.sql).toContain('WHERE group_rn <= 5')
    expect(examplesCall.sql).toContain('ORDER BY name COLLATE NOCASE ASC, product_key ASC')
    // Cheapest offer per (group, product) on the effective-price basis.
    expect(examplesCall.sql).toContain(
      'ORDER BY COALESCE(effective_unit_price, price) ASC, source_slug ASC'
    )
    // The evidence filter admits label-only (NULL type) rows.
    expect(examplesCall.sql).toContain(
      "o.promo_type IS NOT NULL OR (o.promo_label IS NOT NULL AND o.promo_label <> '')"
    )

    const totalCall = prepareCalls.find((call) => call.sql.includes('-- promos: total'))!
    expect(totalCall.sql).toContain('COUNT(DISTINCT p.product_key)')
  })
})
