import { describe, expect, it } from 'vite-plus/test'
import { parse } from 'valibot'

import { apiApp } from '../apps/api.js'
import { getCanonicalIndex, ingestPricesV2 } from '../lib/ingest-v2.js'
import { ingestPayloadV2Schema } from '@rumaq/contract'
import type { Env } from '../types.js'
import fixture from '../../../contract/fixtures/valid/ingest-v2.json'

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
})

describe('POST /api/internal/ingest/prices v2 boundary', () => {
  it('rejects a v1 payload with 400 and writes nothing', async () => {
    const { sqlite, db } = setup()
    const res = await request(db, {
      schemaVersion: 1,
      scrapedAt: '2026-11-05T23:00:05Z',
      stores: [],
      items: [],
    })
    expect(res.status).toBe(400)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM price_products').get()?.count).toBe(0)
  })

  it('rejects an undeclared store with 400 and writes nothing', async () => {
    const { sqlite, db } = setup()
    const input = payload()
    input.items[0]!.storeSlug = 'unknown-store'
    const res = await request(db, input)
    expect(res.status).toBe(400)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM price_products').get()?.count).toBe(0)
  })

  it('accepts a valid v2 payload and returns the receipt', async () => {
    const { db } = setup()
    const res = await request(db, fixture)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      schemaVersion: 2,
      accepted: 1,
      skipped: 0,
      productsCreated: 1,
      observationsUpserted: 1,
      indexVersion: 1,
    })
  })

  it('serves the canonical index behind the same bearer secret', async () => {
    const { db } = setup()
    await request(db, fixture)
    const res = await apiApp.request(
      '/api/internal/canonical-index',
      { headers: { Authorization: 'Bearer secret-123' } },
      env(db)
    )
    expect(res.status).toBe(200)
    const index = (await res.json()) as { schemaVersion: number; products: unknown[] }
    expect(index.schemaVersion).toBe(2)
    expect(index.products).toHaveLength(1)
  })
})
