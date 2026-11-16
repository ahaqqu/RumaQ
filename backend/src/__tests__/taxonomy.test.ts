import { describe, it, expect } from 'vite-plus/test'
import { safeParse } from 'valibot'
import { backfillCategoriesPayloadSchema } from '@rumaq/contract'
import { apiApp } from '../apps/api.js'
import { applyCategoryBackfill, listUncategorizedProducts } from '../lib/taxonomy-backfill.js'

// The backend tsconfig pins `types` to @cloudflare/workers-types, so Node
// builtin imports carry no declarations — same contained suppressions as
// migrations.test.ts / match-review.test.ts. The taxonomy semantics below
// (NULL-category queueing, IS NULL-guarded writes, idempotent backfill) are
// real SQL behavior: they run against real SQLite (node:sqlite — D1 is
// SQLite), which the string-matching fake db cannot pin.
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
    run(...params: unknown[]): { changes: number | bigint }
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

// Minimal D1-shaped adapter over node:sqlite — the surface the backfill lib
// uses (prepare → bind → all/first/run, plus batch, whose results carry
// meta.changes so the backfill counters mean something).
function sqliteD1(db: SqliteDb): D1Database {
  const prepare = (sql: string) => ({
    sql,
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params
      return this
    },
    async all() {
      return { results: db.prepare(sql).all(...this.params) }
    },
    async first() {
      const rows = db.prepare(sql).all(...this.params)
      return rows.length > 0 ? rows[0] : null
    },
    async run() {
      const info = db.prepare(sql).run(...this.params)
      return { success: true, meta: { changes: Number(info.changes ?? 0) } }
    },
  })
  return {
    prepare: (sql: string) => prepare(sql),
    async batch(statements: Array<ReturnType<typeof prepare>>) {
      return statements.map((stmt) => {
        const info = db.prepare(stmt.sql).run(...stmt.params)
        return { success: true, meta: { changes: Number(info.changes ?? 0) } }
      })
    },
  } as unknown as D1Database
}

// Audit L13 deleted the v1 ingest engine (ingestPrices) these tests used as
// a fixture writer — the backfill tests need rows shaped right, not ingest
// semantics, so they seed with direct SQL. Ids derive from the unique
// product key; the observations ride one seeded source.
function seedProduct(
  sqlite: SqliteDb,
  productKey: string,
  name: string,
  options: { category?: string; observedDates?: string[] } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO price_sources (id, slug, name) VALUES ('seed-source', 'lotte-mart', 'Lotte Mart')
       ON CONFLICT(slug) DO NOTHING`
    )
    .run()
  sqlite
    .prepare(
      `INSERT INTO price_products (id, product_key, name, category, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, '2026-11-01', '2026-11-01')`
    )
    .run(`prod-${productKey}`, productKey, name, options.category ?? null)
  for (const date of options.observedDates ?? []) {
    sqlite
      .prepare(
        `INSERT INTO price_observations
           (id, product_id, source_id, observed_date, price, match_confidence, scraped_at)
         VALUES (?, ?, 'seed-source', ?, 10000, 1, '2026-11-01T23:00:05Z')`
      )
      .run(`obs-${productKey}-${date}`, `prod-${productKey}`, date)
  }
}

describe('replay-backfill (#373)', () => {
  it('queues uncategorized products and stops once everything is classified', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyRealMigrations(sqlite)
    const db = sqliteD1(sqlite)

    seedProduct(sqlite, 'beras--ramos--5-kg', 'Beras Ramos 5kg')
    seedProduct(sqlite, 'gula--gulaku--1-kg', 'Gula Gulaku 1kg')
    seedProduct(sqlite, 'teh--sariwangi--25s', 'Teh Sariwangi', { category: 'teh-kopi' })

    const page = await listUncategorizedProducts(db)
    expect(page.products.map((p) => p.productKey)).toEqual([
      'beras--ramos--5-kg',
      'gula--gulaku--1-kg',
    ])
    expect(page.hasMore).toBe(false)

    const paged = await listUncategorizedProducts(db, { limit: 1, offset: 0 })
    expect(paged.products).toHaveLength(1)
    expect(paged.hasMore).toBe(true)
  })

  it('applies answers idempotently: NULLs filled, present values untouched, rerun is a no-op', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyRealMigrations(sqlite)
    const db = sqliteD1(sqlite)

    seedProduct(sqlite, 'beras--ramos--5-kg', 'Beras Ramos 5kg')
    seedProduct(sqlite, 'gula--gulaku--1-kg', 'Gula Gulaku 1kg', {
      category: 'bumbu-bahan-masak',
    })

    const parsed = safeParse(backfillCategoriesPayloadSchema, {
      schemaVersion: 1,
      taxoVersion: 'v0.2',
      items: [
        { productKey: 'beras--ramos--5-kg', category: 'beras' },
        // Present category + already-stamped-elsewhere observations: the
        // guards must leave them alone.
        { productKey: 'gula--gulaku--1-kg', category: 'lainnya' },
        // Unknown keys: counted (once per DISTINCT key — the duplicate
        // below is the same unknown product, not two), never fatal.
        { productKey: 'hilang--x--y', category: 'lainnya' },
        { productKey: 'hilang--x--y', category: 'lainnya' },
      ],
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return

    const first = await applyCategoryBackfill(db, parsed.output)
    expect(first.productsUpdated).toBe(1)
    expect(first.unknownProducts).toBe(1)
    const beras = sqlite
      .prepare("SELECT category FROM price_products WHERE product_key = 'beras--ramos--5-kg'")
      .get()
    expect(beras).toMatchObject({ category: 'beras' })
    const gula = sqlite
      .prepare("SELECT category FROM price_products WHERE product_key = 'gula--gulaku--1-kg'")
      .get()
    // The live ingest's category is never clobbered by the backfill.
    expect(gula).toMatchObject({ category: 'bumbu-bahan-masak' })

    // Idempotent: a whole-job replay changes nothing.
    const second = await applyCategoryBackfill(db, parsed.output)
    expect(second.productsUpdated).toBe(0)
    expect(second.observationsStamped).toBe(0)

    // The queue drains to empty.
    const page = await listUncategorizedProducts(db)
    expect(page.products).toEqual([])
  })

  it('stamps every observation of the product, not just the latest', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyRealMigrations(sqlite)
    const db = sqliteD1(sqlite)

    seedProduct(sqlite, 'beras--ramos--5-kg', 'Beras Ramos 5kg', {
      observedDates: ['2026-11-01', '2026-11-02'],
    })
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS n FROM price_observations WHERE taxo_version IS NULL')
        .get()
    ).toMatchObject({ n: 2 })

    const parsed = safeParse(backfillCategoriesPayloadSchema, {
      schemaVersion: 1,
      taxoVersion: 'v0.2',
      items: [{ productKey: 'beras--ramos--5-kg', category: 'beras' }],
    })
    if (!parsed.success) throw new Error('fixture invalid')
    const result = await applyCategoryBackfill(db, parsed.output)
    expect(result.observationsStamped).toBe(2)
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS n FROM price_observations WHERE taxo_version = ?')
        .get('v0.2')
    ).toMatchObject({ n: 2 })
  })
})

describe('internal backfill routes (#373)', () => {
  function createEnv(db: D1Database, secret?: string) {
    return {
      DB: db,
      RECEIPTS: { put: () => {}, get: () => {} },
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

  it('gate the queue and the write-back behind the ingest bearer secret', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyRealMigrations(sqlite)

    const noSecret = createEnv(sqliteD1(sqlite))
    const missing = await apiApp.request('/api/internal/prices/backfill/queue', {}, noSecret)
    expect(missing.status).toBe(503)

    const env = createEnv(sqliteD1(sqlite), 'secret-123')
    const wrong = await apiApp.request(
      '/api/internal/prices/backfill/queue',
      { headers: { Authorization: 'Bearer nope' } },
      env
    )
    expect(wrong.status).toBe(401)
    const unauthPost = await apiApp.request(
      '/api/internal/prices/backfill/categories',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env
    )
    expect(unauthPost.status).toBe(401)
  })

  it('serves the queue page and applies a valid write-back', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyRealMigrations(sqlite)
    const env = createEnv(sqliteD1(sqlite), 'secret-123')

    seedProduct(sqlite, 'beras--ramos--5-kg', 'Beras Ramos 5kg', {
      observedDates: ['2026-11-01'],
    })

    const queue = await apiApp.request(
      '/api/internal/prices/backfill/queue',
      { headers: { Authorization: 'Bearer secret-123' } },
      env
    )
    expect(queue.status).toBe(200)
    expect(await queue.json()).toEqual({
      products: [{ productKey: 'beras--ramos--5-kg', name: 'Beras Ramos 5kg' }],
      hasMore: false,
    })

    const apply = await apiApp.request(
      '/api/internal/prices/backfill/categories',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-123' },
        body: JSON.stringify({
          schemaVersion: 1,
          taxoVersion: 'v0.2',
          items: [{ productKey: 'beras--ramos--5-kg', category: 'beras' }],
        }),
      },
      env
    )
    expect(apply.status).toBe(200)
    expect(await apply.json()).toEqual({
      productsUpdated: 1,
      observationsStamped: 1,
      unknownProducts: 0,
    })

    // The strict contract rejects a junk write before any D1 work.
    const bad = await apiApp.request(
      '/api/internal/prices/backfill/categories',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-123' },
        body: JSON.stringify({ schemaVersion: 2, taxoVersion: 'v0.2', items: [] }),
      },
      env
    )
    expect(bad.status).toBe(400)
  })
})
