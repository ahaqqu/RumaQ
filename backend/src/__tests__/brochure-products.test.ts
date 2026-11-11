import { describe, it, expect } from 'vite-plus/test'
import { generateSpecs } from 'hono-openapi'
import { apiApp } from '../apps/api.js'
import {
  BROCHURE_PRODUCTS_DEFAULT_LIMIT,
  BROCHURE_PRODUCTS_MAX_LIMIT,
  BROCHURE_URL_MAX_LENGTH,
  BROCHURE_URL_PREFIX,
  getBrochureProducts,
} from '../lib/brochures.js'
// The backend tsconfig pins `types` to @cloudflare/workers-types, so Node
// builtin imports carry no declarations — same contained suppressions as
// canonical-products.test.ts / entitlements.test.ts. The per-brochure list is
// SQL (CTE + window function + LIMIT/OFFSET) plus an exact COUNT: only a real
// SQLite engine can pin that the 5-row example cap is gone, that pagination
// slices the same ordered set, and that superseded/low-confidence rows vanish.
// @ts-expect-error — no node types in this tsconfig
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error — no node types in this tsconfig
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error — no node types in this tsconfig
import { join, dirname } from 'node:path'
// @ts-expect-error — no node types in this tsconfig
import { fileURLToPath } from 'node:url'

type SqliteDb = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): Record<string, unknown> | undefined
    all(...params: unknown[]): Array<Record<string, unknown>>
  }
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations')

function applyRealMigrations(db: SqliteDb): void {
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name: string) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

// Minimal D1-shaped adapter over node:sqlite (the canonical-products.test.ts
// idiom): prepare → bind → all/first/run, and a batch that runs every
// statement against the same in-memory DB.
class TestStatement {
  constructor(
    private readonly sqlite: SqliteDb,
    readonly sql: string,
    readonly params: unknown[] = []
  ) {}

  bind(...params: unknown[]): TestStatement {
    return new TestStatement(this.sqlite, this.sql, params)
  }

  async first<T>(): Promise<T | null> {
    return (this.sqlite.prepare(this.sql).get(...this.params) ?? null) as T | null
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.sqlite.prepare(this.sql).all(...this.params) as T[] }
  }

  async run(): Promise<{ success: true }> {
    this.sqlite.prepare(this.sql).run(...this.params)
    return { success: true }
  }
}

function sqliteD1(sqlite: SqliteDb): D1Database {
  return {
    prepare: (sql: string) => new TestStatement(sqlite, sql),
    batch: async (statements: TestStatement[]) =>
      statements.map((statement) => ({
        results: sqlite.prepare(statement.sql).all(...statement.params),
        success: true,
      })),
  } as unknown as D1Database
}

function createSqliteEnv(db: D1Database, authenticated = true) {
  return {
    DB: db,
    RECEIPTS: {},
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    WORKER_JWT_SECRET: 'test-secret',
    WORKER_ENCRYPTION_KEY: 'test-encryption-key-32-bytes-long!!',
    EMAIL_AUTH_ENABLED: 'false',
    ASSETS: undefined as unknown as Fetcher,
    props: authenticated ? { userId: 'u1', householdId: 'h1' } : undefined,
    TEST_MODE: 'true',
  }
}

const BROCHURE_A = `${BROCHURE_URL_PREFIX}lotte-mart/20261029/page_1_2ad1c95b.jpg`
const BROCHURE_MULTI = `${BROCHURE_URL_PREFIX}lotte-mart/20261029/page_2_multi.jpg`
const BROCHURE_OLD = `${BROCHURE_URL_PREFIX}lotte-mart/20261001/page_old.jpg`
const BROCHURE_LOW = `${BROCHURE_URL_PREFIX}lotte-mart/20261029/page_low.jpg`

const A_PRODUCTS = [
  ['beras--pandan-wangi--5-kg', 'Beras Pandan Wangi 5 kg'],
  ['gula--gulaku--1-kg', 'Gula Gulaku 1 kg'],
  ['kopi--kapal-api--250-g', 'Kopi Kapal Api 250 g'],
  ['minyak--bimoli--2-l', 'Minyak Goreng Bimoli 2 L'],
  ['susu--ultra--1-l', 'Susu Ultra 1 L'],
  ['teh--sariwangi--25-pcs', 'Teh Sariwangi 25 pcs'],
  ['telur--ayam--1-kg', 'Telur Ayam 1 kg'],
] as const

function seed(sqlite: SqliteDb): void {
  sqlite
    .prepare(
      `INSERT INTO price_sources (id, slug, name, website)
       VALUES ('src-lotte', 'lotte-mart', 'Lotte Mart', 'https://www.lottemart.co.id')`
    )
    .run()
  sqlite
    .prepare(
      `INSERT INTO price_sources (id, slug, name, website)
       VALUES ('src-super', 'superindo', 'Superindo', NULL)`
    )
    .run()

  const insertProduct = sqlite.prepare(
    `INSERT INTO price_products
       (id, product_key, name, brand, unit, category, category_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const insertObservation = sqlite.prepare(
    `INSERT INTO price_observations
       (id, product_id, source_id, observed_date, price, effective_unit_price,
        promo_type, promo_label, valid_from, valid_until, match_method,
        match_confidence, brochure_url, scraped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  // Seven current products on brochure A — more than the old ≤5 example cap.
  A_PRODUCTS.forEach(([key, name], index) => {
    insertProduct.run(`prod-${index}`, key, name, null, null, 'sembako', '2026-01')
    insertObservation.run(
      `obs-a-${index}`,
      `prod-${index}`,
      'src-lotte',
      '2026-10-29',
      10_000 + index * 1_000,
      null,
      null,
      null,
      null,
      null,
      'exact',
      1,
      BROCHURE_A,
      '2026-10-29T23:00:05Z'
    )
  })

  // Full provenance on one row, so the response mapping is pinned field by
  // field (promo, validity window, match method/confidence, store website).
  sqlite
    .prepare(
      `UPDATE price_products
       SET brand = 'Pandan Wangi', unit = '5 kg', category = 'beras'
       WHERE id = 'prod-0'`
    )
    .run()
  sqlite
    .prepare(
      `UPDATE price_observations
       SET price = 72000, effective_unit_price = 14400,
           promo_type = 'discount_pct', promo_label = 'DISKON 20%',
           valid_from = '2026-10-29', valid_until = '2026-11-04',
           match_method = 'embedding', match_confidence = 0.92
       WHERE id = 'obs-a-0'`
    )
    .run()

  // A superseded observation: the Beras row on the old page is no longer the
  // latest for (product, source), so that brochure has no current rows.
  insertObservation.run(
    'obs-old-0',
    'prod-0',
    'src-lotte',
    '2026-10-01',
    50_000,
    null,
    null,
    null,
    null,
    null,
    'exact',
    1,
    BROCHURE_OLD,
    '2026-10-01T23:00:05Z'
  )

  // A below-floor observation: Gula is current at Lotte (brochure A) but the
  // Superindo row (its own latest) is under PRICE_MIN_CONFIDENCE, so the low
  // brochure has no current rows either.
  insertObservation.run(
    'obs-low-1',
    'prod-1',
    'src-super',
    '2026-10-29',
    11_000,
    null,
    null,
    null,
    null,
    null,
    'ai',
    0.4,
    BROCHURE_LOW,
    '2026-10-29T23:00:05Z'
  )

  // Cheapest-offer basis: two current offers for the same product on one
  // brochure; the lower COALESCE(effective, price) wins.
  insertProduct.run(
    'prod-multi',
    'apel--fuji--1-kg',
    'Apel Fuji 1 kg',
    null,
    null,
    'buah',
    '2026-01'
  )
  insertObservation.run(
    'obs-multi-lotte',
    'prod-multi',
    'src-lotte',
    '2026-10-29',
    30_000,
    15_000,
    null,
    null,
    null,
    null,
    'exact',
    1,
    BROCHURE_MULTI,
    '2026-10-29T23:00:05Z'
  )
  insertObservation.run(
    'obs-multi-super',
    'prod-multi',
    'src-super',
    '2026-10-29',
    20_000,
    null,
    null,
    null,
    null,
    null,
    'exact',
    1,
    BROCHURE_MULTI,
    '2026-10-29T23:00:05Z'
  )
}

function freshDb() {
  const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
  applyRealMigrations(sqlite)
  seed(sqlite)
  return { sqlite, db: sqliteD1(sqlite) }
}

function request(path: string, authenticated = true) {
  const { db } = freshDb()
  return apiApp.request(path, {}, createSqliteEnv(db, authenticated))
}

function pagePath(url: string, params: Record<string, string | number> = {}): string {
  const search = new URLSearchParams({
    url,
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
  })
  return `/api/prices/brochures/products?${search.toString()}`
}

describe('getBrochureProducts', () => {
  it('returns every current product on the brochure — no five-row cap', async () => {
    const { db } = freshDb()
    const page = await getBrochureProducts(db, { brochureUrl: BROCHURE_A, limit: 50, offset: 0 })

    expect(page.total).toBe(7)
    expect(page.items).toHaveLength(7)
    expect(page.items.map((item) => item.name)).toEqual([
      'Beras Pandan Wangi 5 kg',
      'Gula Gulaku 1 kg',
      'Kopi Kapal Api 250 g',
      'Minyak Goreng Bimoli 2 L',
      'Susu Ultra 1 L',
      'Teh Sariwangi 25 pcs',
      'Telur Ayam 1 kg',
    ])
    expect(page.items.map((item) => item.product_key)).toEqual([
      'beras--pandan-wangi--5-kg',
      'gula--gulaku--1-kg',
      'kopi--kapal-api--250-g',
      'minyak--bimoli--2-l',
      'susu--ultra--1-l',
      'teh--sariwangi--25-pcs',
      'telur--ayam--1-kg',
    ])
  })

  it('maps the full QA provenance of a row', async () => {
    const { db } = freshDb()
    const page = await getBrochureProducts(db, { brochureUrl: BROCHURE_A, limit: 1, offset: 0 })
    expect(page.items[0]).toEqual({
      product_key: 'beras--pandan-wangi--5-kg',
      name: 'Beras Pandan Wangi 5 kg',
      brand: 'Pandan Wangi',
      unit: '5 kg',
      category: 'beras',
      category_version: '2026-01',
      price: 72000,
      effective_unit_price: 14400,
      promo_type: 'discount_pct',
      promo_label: 'DISKON 20%',
      valid_from: '2026-10-29',
      valid_until: '2026-11-04',
      match_method: 'embedding',
      match_confidence: 0.92,
      source_slug: 'lotte-mart',
      source_name: 'Lotte Mart',
      source_website: 'https://www.lottemart.co.id',
      observed_date: '2026-10-29',
      brochure_url: BROCHURE_A,
      scraped_at: '2026-10-29T23:00:05Z',
    })
  })

  it('slices the same ordered set with offset/limit and keeps the exact total', async () => {
    const { db } = freshDb()
    const first = await getBrochureProducts(db, { brochureUrl: BROCHURE_A, limit: 2, offset: 0 })
    const second = await getBrochureProducts(db, { brochureUrl: BROCHURE_A, limit: 2, offset: 2 })
    const tail = await getBrochureProducts(db, { brochureUrl: BROCHURE_A, limit: 50, offset: 6 })
    const past = await getBrochureProducts(db, { brochureUrl: BROCHURE_A, limit: 50, offset: 99 })

    expect(first.items.map((item) => item.name)).toEqual([
      'Beras Pandan Wangi 5 kg',
      'Gula Gulaku 1 kg',
    ])
    expect(second.items.map((item) => item.name)).toEqual([
      'Kopi Kapal Api 250 g',
      'Minyak Goreng Bimoli 2 L',
    ])
    expect(tail.items.map((item) => item.name)).toEqual(['Telur Ayam 1 kg'])
    expect(past.items).toEqual([])
    for (const page of [first, second, tail, past]) expect(page.total).toBe(7)
  })

  it('picks the cheapest current offer per product', async () => {
    const { db } = freshDb()
    const page = await getBrochureProducts(db, {
      brochureUrl: BROCHURE_MULTI,
      limit: 50,
      offset: 0,
    })
    expect(page.total).toBe(1)
    expect(page.items[0]).toMatchObject({
      product_key: 'apel--fuji--1-kg',
      price: 30000,
      effective_unit_price: 15000,
      source_slug: 'lotte-mart',
    })
  })

  it('returns nothing for a brochure whose rows are superseded or below the floor', async () => {
    const { db } = freshDb()
    for (const brochureUrl of [BROCHURE_OLD, BROCHURE_LOW, `${BROCHURE_URL_PREFIX}nope.jpg`]) {
      const page = await getBrochureProducts(db, { brochureUrl, limit: 50, offset: 0 })
      expect(page).toEqual({ items: [], total: 0 })
    }
  })
})

describe('GET /api/prices/brochures/products', () => {
  it('requires authentication', async () => {
    const res = await request(pagePath(BROCHURE_A), false)
    expect(res.status).toBe(401)
  })

  it('returns the paginated page with an exact total', async () => {
    const res = await request(pagePath(BROCHURE_A, { limit: 2, offset: 1 }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
    const body = (await res.json()) as { items: Array<{ name: string }>; total: number }
    expect(body.total).toBe(7)
    expect(body.items.map((item) => item.name)).toEqual([
      'Gula Gulaku 1 kg',
      'Kopi Kapal Api 250 g',
    ])
  })

  it('defaults to 50 per page and accepts the maximum of 200', async () => {
    const defaulted = await request(pagePath(BROCHURE_A))
    expect(defaulted.status).toBe(200)
    const defaultBody = (await defaulted.json()) as { items: unknown[]; total: number }
    expect(defaultBody.items).toHaveLength(7)
    expect(defaultBody.total).toBe(7)

    const maxed = await request(pagePath(BROCHURE_A, { limit: BROCHURE_PRODUCTS_MAX_LIMIT }))
    expect(maxed.status).toBe(200)
  })

  it('400s on a missing, non-servable, or over-long URL', async () => {
    const cases = [
      '/api/prices/brochures/products',
      pagePath('https://retailer.example/page.jpg'),
      pagePath('/api/products/lotte-mart/20261029/page.jpg'),
      pagePath(`${BROCHURE_URL_PREFIX}${'a'.repeat(BROCHURE_URL_MAX_LENGTH)}`),
    ]
    for (const path of cases) {
      const res = await request(path)
      expect(res.status, path).toBe(400)
    }
  })

  it('400s on out-of-range pagination', async () => {
    const cases = [
      pagePath(BROCHURE_A, { limit: 0 }),
      pagePath(BROCHURE_A, { limit: 201 }),
      pagePath(BROCHURE_A, { limit: 'abc' }),
      pagePath(BROCHURE_A, { offset: -1 }),
      pagePath(BROCHURE_A, { offset: '1.5' }),
    ]
    for (const path of cases) {
      const res = await request(path)
      expect(res.status, path).toBe(400)
    }
  })
})

describe('brochure products OpenAPI schema', () => {
  it('publishes the route, query bounds, and every QA field', async () => {
    const specs = (await generateSpecs(apiApp, {
      documentation: { info: { title: 'RumaQ API', version: '0.1.0' } },
    })) as Record<string, any>
    const operation = specs.paths['/api/prices/brochures/products'].get
    expect(operation).toBeDefined()

    const params = new Map(
      (operation.parameters as Array<Record<string, any>>).map((param) => [param.name, param])
    )
    expect(params.get('url')!.required).toBe(true)
    expect(params.get('url')!.in).toBe('query')
    expect(params.get('limit')!.schema.maximum).toBe(BROCHURE_PRODUCTS_MAX_LIMIT)
    expect(params.get('limit')!.schema.default).toBe(BROCHURE_PRODUCTS_DEFAULT_LIMIT)
    expect(params.get('offset')!.schema.minimum).toBe(0)
    expect(operation.responses['400']).toBeDefined()

    const schema = operation.responses['200'].content['application/json'].schema
    expect(schema.required).toEqual(['items', 'total'])
    expect(schema.properties.total.type).toBe('integer')
    expect(schema.properties.items.items.required).toEqual([
      'product_key',
      'name',
      'brand',
      'unit',
      'category',
      'category_version',
      'price',
      'effective_unit_price',
      'promo_type',
      'promo_label',
      'valid_from',
      'valid_until',
      'match_method',
      'match_confidence',
      'source_slug',
      'source_name',
      'source_website',
      'observed_date',
      'brochure_url',
      'scraped_at',
    ])
  })
})
