import { describe, expect, it, vi } from 'vite-plus/test'
import { parse } from 'valibot'

import { apiApp } from '../apps/api.js'
import { getCanonicalIndex, ingestPricesV2 } from '../lib/ingest-v2.js'
import { D1_QUERY_BUDGET, D1QueryBudgetExceededError } from '../lib/d1.js'
import { ingestPayloadV2Schema } from '@rumaq/contract'
import type { Env } from '../types.js'
import fixture from '../../../contract/fixtures/valid/ingest-v2.json'
import v1Fixture from '../../../contract/fixtures/invalid/ingest-v1.json'
import unknownFieldFixture from '../../../contract/fixtures/invalid/ingest-unknown-field.json'
import missingRawNameFixture from '../../../contract/fixtures/invalid/ingest-missing-raw-name.json'
import undeclaredStoreFixture from '../../../contract/fixtures/invalid/ingest-undeclared-store.json'

// Same contained node:sqlite suppressions as migrations.test.ts / taxonomy.test.ts:
// the v2 write path is real SQL (D1 is SQLite), not a string-matching fake.
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

function applyMigrations(db: SqliteDb): void {
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name: string) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

type ShimTrace = { statements: string[]; batchSizes: number[]; queries: number }

function sqliteD1(db: SqliteDb, trace?: ShimTrace): D1Database {
  // Each call below is one query against D1's per-invocation budget, a batch
  // included — that is the number the ingest guard has to agree with.
  const charge = () => {
    if (trace) trace.queries += 1
  }
  const prepare = (sql: string) => ({
    sql,
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params
      return this
    },
    async all() {
      charge()
      trace?.statements.push(sql)
      return { results: db.prepare(sql).all(...this.params) }
    },
    async first() {
      charge()
      trace?.statements.push(sql)
      const rows = db.prepare(sql).all(...this.params)
      return rows.length > 0 ? rows[0] : null
    },
    async run() {
      charge()
      trace?.statements.push(sql)
      const info = db.prepare(sql).run(...this.params)
      return { success: true, meta: { changes: Number(info.changes ?? 0) } }
    },
  })
  return {
    prepare: (sql: string) => prepare(sql),
    // D1's batch() is one transaction that returns each statement's rows,
    // including SELECTs (getCanonicalIndex reads its snapshot through it). The
    // shim matches both properties so a partial write and a chunked read are
    // testable instead of silently passing.
    async batch(statements: Array<ReturnType<typeof prepare>>) {
      charge()
      trace?.batchSizes.push(statements.length)
      for (const stmt of statements) trace?.statements.push(stmt.sql)
      db.exec('BEGIN')
      try {
        const results = statements.map((stmt) => ({
          success: true,
          results: db.prepare(stmt.sql).all(...stmt.params),
          meta: { changes: 0 },
        }))
        db.exec('COMMIT')
        return results
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
}

function setup() {
  const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
  applyMigrations(sqlite)
  return { sqlite, db: sqliteD1(sqlite) }
}

function env(db: D1Database, secret = 'secret-123'): Env {
  return { DB: db, HAQITA_INGEST_SECRET: secret } as unknown as Env
}

function payload() {
  return parse(ingestPayloadV2Schema, fixture)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function request(db: D1Database, body: unknown, secret = 'secret-123') {
  return apiApp.request(
    '/api/internal/ingest/prices',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    },
    env(db, secret)
  )
}

function indexRequest(db: D1Database, secret = 'secret-123') {
  return apiApp.request(
    '/api/internal/canonical-index',
    { headers: { Authorization: `Bearer ${secret}` } },
    env(db, secret)
  )
}

describe('ingestPricesV2', () => {
  it('creates a provisional product, a candidate alias, and a raw observation', async () => {
    const { sqlite, db } = setup()
    const input = payload()
    const receipt = await ingestPricesV2(db, input)

    expect(receipt).toMatchObject({
      schemaVersion: 2,
      accepted: 1,
      skipped: 0,
      productsCreated: 1,
      observationsUpserted: 1,
      indexVersion: 1,
    })
    expect(receipt.products).toHaveLength(1)
    expect(receipt.products[0]?.status).toBe('created')

    const product = sqlite.prepare('SELECT * FROM price_products').get()!
    expect(product).toMatchObject({
      product_key: input.items[0]!.productKey,
      name: 'FILMA MINYAK GORENG PCH 2L',
      brand: 'Filma',
      unit: '2 L',
      category: 'minyak-goreng',
      status: 'provisional',
      metadata_version: 1,
    })

    const alias = sqlite.prepare('SELECT * FROM price_product_aliases').get()!
    expect(alias).toMatchObject({
      product_id: product.id,
      name: 'FILMA MINYAK GORENG PCH 2L',
      store_slug: 'superindo',
      status: 'candidate',
      source: 'ocr',
    })

    const observation = sqlite.prepare('SELECT * FROM price_observations').get()!
    expect(observation).toMatchObject({
      product_id: product.id,
      raw_name: 'FILMA MINYAK GORENG PCH 2L',
      raw_brand: 'Filma',
      raw_unit: '2 L',
      page: 2,
      ocr_model: 'gemini-3.8-flash',
      observed_date: '2026-11-05',
    })
  })

  it('writes the member price beside the shelf price (#627)', async () => {
    const { sqlite, db } = setup()
    await ingestPricesV2(db, payload())

    expect(sqlite.prepare('SELECT price, member_price FROM price_observations').get()).toEqual({
      price: 34500,
      member_price: 29900,
    })

    // A repeated observation upserts the member price, not just the shelf one.
    const changed = payload()
    changed.items[0]!.memberPrice = 27900
    await ingestPricesV2(db, changed)
    expect(sqlite.prepare('SELECT member_price FROM price_observations').get()?.member_price).toBe(
      27900
    )
  })

  it('leaves the member price null for a payload without it (#627)', async () => {
    const { sqlite, db } = setup()
    const input = payload()
    // Old scraper shape: the field is absent/null; the row stays null (no
    // zero, no backfill).
    input.items[0]!.memberPrice = null
    await ingestPricesV2(db, input)
    expect(
      sqlite.prepare('SELECT member_price FROM price_observations').get()?.member_price
    ).toBeNull()
  })

  it('is idempotent: a retry keeps the ID and reports existing', async () => {
    const { sqlite, db } = setup()
    const first = await ingestPricesV2(db, payload())
    const second = await ingestPricesV2(db, payload())

    expect(second.products[0]?.productId).toBe(first.products[0]?.productId)
    expect(second.products[0]?.status).toBe('existing')
    expect(second.productsCreated).toBe(0)
    expect(second.indexVersion).toBe(2)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM price_products').get()?.count).toBe(1)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM price_observations').get()?.count).toBe(1)
  })

  it('never overwrites an existing category', async () => {
    const { sqlite, db } = setup()
    await ingestPricesV2(db, payload())
    const changed = payload()
    changed.items[0]!.category = 'other-category'
    await ingestPricesV2(db, changed)
    expect(sqlite.prepare('SELECT category FROM price_products').get()?.category).toBe(
      'minyak-goreng'
    )
  })

  it('never stamps a taxonomy version on a category this pipeline did not classify', async () => {
    const { sqlite, db } = setup()
    await ingestPricesV2(db, payload())
    // An admin set the category but no version: the next ingest's proposal must
    // not borrow the admin's category for its own taxoVersion (§6.2).
    sqlite
      .prepare('UPDATE price_products SET category = ?, category_version = NULL')
      .run('admin-pick')
    await ingestPricesV2(db, payload())
    expect(sqlite.prepare('SELECT category, category_version FROM price_products').get()).toEqual({
      category: 'admin-pick',
      category_version: null,
    })
  })

  it('derives the provisional name from the key when the raw name is blank', async () => {
    const { sqlite, db } = setup()
    const input = payload()
    input.items[0]!.rawName = '   '
    await ingestPricesV2(db, input)
    expect(sqlite.prepare('SELECT name FROM price_products').get()?.name).toBe(
      input.items[0]!.productKey
    )
    const index = await getCanonicalIndex(db)
    expect(index.products[0]?.canonicalName).toBe(input.items[0]!.productKey)
  })

  it('defaults observedDate to the UTC date of scrapedAt, not the producer local date', async () => {
    const { sqlite, db } = setup()
    const input = payload()
    input.scrapedAt = '2026-11-06T01:00:05+07:00'
    delete input.items[0]!.observedDate
    await ingestPricesV2(db, input)
    expect(
      sqlite.prepare('SELECT observed_date FROM price_observations').get()?.observed_date
    ).toBe('2026-11-05')
  })

  it('dedupes a repeated productKey and reports rows, not statements', async () => {
    const { sqlite, db } = setup()
    const input = payload()
    const secondStore = clone(input.items[0]!)
    secondStore.storeSlug = 'lotte-mart'
    secondStore.rawName = 'FILMA MINYAK GORENG 2 LITER'
    input.stores.push({
      slug: 'lotte-mart',
      name: 'Lotte Mart',
      region: null,
      website: null,
    })
    input.items.push(secondStore)

    const receipt = await ingestPricesV2(db, input)

    expect(receipt.accepted).toBe(2)
    expect(receipt.products).toHaveLength(1)
    expect(receipt.observationsUpserted).toBe(2)
    // One canonical product, named from its FIRST item — array order is not
    // allowed to decide the provisional name.
    expect(sqlite.prepare('SELECT name FROM price_products').get()?.name).toBe(
      'FILMA MINYAK GORENG PCH 2L'
    )
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM price_product_aliases').get()?.count).toBe(
      2
    )

    // The exact same (product, store, date) twice is one row, and the receipt
    // says so instead of counting the statement twice.
    input.items.push(clone(input.items[0]!))
    const again = await ingestPricesV2(db, input)
    expect(again.observationsUpserted).toBe(2)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM price_observations').get()?.count).toBe(2)
  })

  it('never downgrades an approved alias', async () => {
    const { sqlite, db } = setup()
    await ingestPricesV2(db, payload())
    sqlite.prepare("UPDATE price_product_aliases SET status = 'approved'").run()
    await ingestPricesV2(db, payload())
    expect(sqlite.prepare('SELECT status FROM price_product_aliases').get()?.status).toBe(
      'approved'
    )
  })

  it('returns only approved aliases and parses the canonical index', async () => {
    const { sqlite, db } = setup()
    await ingestPricesV2(db, payload())

    const before = await getCanonicalIndex(db)
    expect(before.products[0]?.aliases).toEqual([])
    expect(before.products[0]?.status).toBe('provisional')

    sqlite.prepare("UPDATE price_product_aliases SET status = 'approved'").run()
    const after = await getCanonicalIndex(db)
    expect(after.products[0]?.aliases).toHaveLength(1)
    expect(after.products[0]?.aliases[0]).toMatchObject({
      name: 'FILMA MINYAK GORENG PCH 2L',
      storeSlug: 'superindo',
      source: 'ocr',
    })
  })

  it('reads the index version and the rows it stamps in one transaction', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyMigrations(sqlite)
    const trace: ShimTrace = { statements: [], batchSizes: [], queries: 0 }
    const db = sqliteD1(sqlite, trace)
    await ingestPricesV2(db, payload())
    trace.batchSizes.length = 0
    await getCanonicalIndex(db)
    // version + products + approved aliases, one batch: a concurrent ingest
    // cannot slip between the counter and the content (§6.2/§6.3).
    expect(trace.batchSizes).toEqual([3])
  })

  it('normalizes legacy timestamps instead of failing the index', async () => {
    const { sqlite, db } = setup()
    await ingestPricesV2(db, payload())
    sqlite
      .prepare(
        `UPDATE price_products
         SET first_seen_at = '2026-10-24', last_seen_at = '2026-10-25 10:00:00',
             updated_at = '2026-10-24'`
      )
      .run()
    const index = await getCanonicalIndex(db)
    expect(index.products[0]?.firstSeenAt).toBe('2026-10-24T00:00:00Z')
    expect(index.products[0]?.lastSeenAt).toBe('2026-10-25T10:00:00Z')
    expect(index.products[0]?.updatedAt).toBe('2026-10-24T00:00:00Z')
  })

  it('fails the index with a typed, data-free error when a row cannot satisfy the contract', async () => {
    const { sqlite, db } = setup()
    await ingestPricesV2(db, payload())
    // A legacy row that cannot satisfy the contract (non-UUID id) — what a
    // pre-reset or hand-written row looks like, and what the strict parse
    // must not answer with a valibot message.
    sqlite
      .prepare(
        `INSERT INTO price_products (id, product_key, name, status, metadata_version)
         VALUES ('legacy-1', 'legacy--row--1', 'Legacy row', 'provisional', 1)`
      )
      .run()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await indexRequest(db)
      expect(res.status).toBe(500)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('Canonical index does not match the contract')
      // No valibot text, no row value: the details are in the server log.
      expect(JSON.stringify(body)).not.toContain('UUID')
      expect(JSON.stringify(body)).not.toContain('legacy-1')
      expect(logged.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('legacy-1')
    } finally {
      logged.mockRestore()
    }
  })

  it('chunks the write path under the D1 limits at catalog scale', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyMigrations(sqlite)
    const trace: ShimTrace = { statements: [], batchSizes: [], queries: 0 }
    const db = sqliteD1(sqlite, trace)

    // 205 keys — the automation suite's bulk-catalog size (bulkCatalogueSnapshot)
    // — so an IN list that stopped being chunked would bind 205 parameters and
    // fail the ceiling assertion below; at exactly 100 it would still pass.
    const count = 205
    const items = Array.from({ length: count }, (_, index) => ({
      productKey: `bulk-item-${index}--acme--1-pcs`,
      rawName: `Bulk Item ${index}`,
      rawBrand: 'Acme',
      storeSlug: 'lotte-mart',
      price: 1000 + index,
      matchConfidence: 1,
    }))
    const input = parse(ingestPayloadV2Schema, {
      schemaVersion: 2,
      scrapedAt: '2026-11-05T23:00:05Z',
      stores: [{ slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' }],
      items,
    })

    const receipt = await ingestPricesV2(db, input)

    expect(receipt.productsCreated).toBe(count)
    expect(receipt.products).toHaveLength(count)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM price_products').get()?.count).toBe(count)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM price_observations').get()?.count).toBe(
      count
    )
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM price_product_aliases').get()?.count).toBe(
      count
    )
    // More than one batch (so the loop is exercised) and never more than the
    // 50-statement chunk D1's per-invocation budget is sized for.
    expect(trace.batchSizes.length).toBeGreaterThan(1)
    expect(Math.max(...trace.batchSizes)).toBeLessThanOrEqual(50)
    // 205 keys are past SELECT_IN_CHUNK, so this only holds if selectIn still
    // chunks: every statement stays under D1's 100-bound-parameter ceiling.
    for (const statement of trace.statements) {
      expect((statement.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100)
    }
  })
})

// D1's per-invocation query budget is a hard stop, not a tuning knob: past it
// the invocation dies mid-chunk, and the chunks that already committed carry
// the version they had before the ingest (lib/d1.ts). So the guard has to fire
// before the canonical write, and its arithmetic has to match what the path
// really issues — otherwise the ceiling it promises is fiction.
describe('ingestPricesV2 query budget', () => {
  function bulkPayload(count: number) {
    return parse(ingestPayloadV2Schema, {
      schemaVersion: 2,
      scrapedAt: '2026-11-05T23:00:05Z',
      stores: [
        { slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' },
        { slug: 'superindo', name: 'Superindo', region: 'jakarta' },
      ],
      items: Array.from({ length: count }, (_, index) => ({
        productKey: `bulk-item-${index}--acme--1-pcs`,
        rawName: `Bulk Item ${index}`,
        storeSlug: index % 2 === 0 ? 'lotte-mart' : 'superindo',
        price: 1000 + index,
        matchConfidence: 1,
      })),
    })
  }

  it('refuses a payload over the budget before the canonical write', async () => {
    const { sqlite, db } = setup()
    // 1,700 items — the nightly catalog size the budget is sized against —
    // needs ~125 queries, so D1 would abort it after ~30 of 103 batches.
    await expect(ingestPricesV2(db, bulkPayload(1700))).rejects.toThrow(D1QueryBudgetExceededError)
    // A refused payload must not half-write: no product, alias or observation
    // may land, or the index version ends up older than its content.
    for (const table of ['price_products', 'price_product_aliases', 'price_observations']) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count).toBe(0)
    }
  })

  it('accepts the largest cold catalog the budget allows', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyMigrations(sqlite)
    const trace: ShimTrace = { statements: [], batchSizes: [], queries: 0 }
    const db = sqliteD1(sqlite, trace)
    // 649 items is the cold ceiling: every product is a new INSERT, so the
    // path spends exactly the 50 queries the guard estimated — one per read,
    // per batch and for the version read, the number D1 counts.
    const receipt = await ingestPricesV2(db, bulkPayload(649))
    expect(receipt.productsCreated).toBe(649)
    expect(trace.queries).toBe(D1_QUERY_BUDGET)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM price_products').get()?.count).toBe(649)
  })

  it('refuses the first catalog size that would cross the budget', async () => {
    const { db } = setup()
    await expect(ingestPricesV2(db, bulkPayload(650))).rejects.toThrow(D1QueryBudgetExceededError)
  })
})

describe('POST /api/internal/ingest/prices v2 boundary', () => {
  it('accepts the shared valid fixture and sets no-store', async () => {
    const { sqlite, db } = setup()
    const res = await request(db, fixture)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({
      schemaVersion: 2,
      accepted: 1,
      skipped: 0,
      productsCreated: 1,
      observationsUpserted: 1,
      indexVersion: 1,
    })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM price_products').get()?.count).toBe(1)
  })

  // §8.3 consumer test: the backend route rejects every shared invalid
  // fixture with 400 and writes nothing — the fixtures are the contract, so a
  // drift between fixture and route fails here instead of in the pipeline.
  it.each([
    ['v1 payload', v1Fixture],
    ['unknown field', unknownFieldFixture],
    ['missing raw name', missingRawNameFixture],
    ['undeclared store', undeclaredStoreFixture],
  ])('rejects the shared %s fixture with 400 and writes nothing', async (_label, body) => {
    const { sqlite, db } = setup()
    const res = await request(db, body)
    expect(res.status).toBe(400)
    const parsed = (await res.json()) as { error: string; issues: unknown[] }
    expect(parsed.error).toBe('Validation failed')
    expect(parsed.issues.length).toBeGreaterThan(0)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM price_products').get()?.count).toBe(0)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM price_sources').get()?.count).toBe(0)
  })

  it('returns 400 with a single stable shape for invalid JSON', async () => {
    const { db } = setup()
    const res = await apiApp.request(
      '/api/internal/ingest/prices',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-123' },
        body: '{not json',
      },
      env(db)
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid JSON' })
  })

  it('serves the canonical index behind the same bearer secret', async () => {
    const { db } = setup()
    await request(db, fixture)
    const res = await indexRequest(db)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const index = (await res.json()) as { schemaVersion: number; products: unknown[] }
    expect(index.schemaVersion).toBe(2)
    expect(index.products).toHaveLength(1)

    const unauthorized = await apiApp.request('/api/internal/canonical-index', {}, env(db))
    expect(unauthorized.status).toBe(401)
  })
})

// The shim is the only D1 stand-in the write path is tested against, so its
// transaction has to behave like D1's: a batch that fails part-way must leave
// nothing behind, or a future partial-write assertion would pass against a
// rollback that never happened.
describe('sqlite D1 shim', () => {
  it('rolls a failed batch back as one transaction', async () => {
    const { sqlite, db } = setup()
    const insert = (slug: string) =>
      db.prepare("INSERT INTO price_sources (id, slug, name) VALUES ('src-1', ?, 'S')").bind(slug)
    await expect(db.batch([insert('a'), insert('b')])).rejects.toThrow()
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM price_sources WHERE id = 'src-1'").get()?.count
    ).toBe(0)
  })
})
