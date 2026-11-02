import { describe, it, expect } from 'vite-plus/test'
// The backend tsconfig pins `types` to @cloudflare/workers-types, so Node
// builtin imports carry no declarations. These suppressions are contained to
// this file: the migration chain is real SQL exercised against a real SQLite
// engine (node:sqlite — D1 is SQLite), which a structural string test cannot
// give.
// @ts-expect-error — no node types in this tsconfig
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error — no node types in this tsconfig
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error — no node types in this tsconfig
import { join, dirname } from 'node:path'
// @ts-expect-error — no node types in this tsconfig
import { fileURLToPath } from 'node:url'

type Db = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): Record<string, unknown> | undefined
    all(...params: unknown[]): Array<Record<string, unknown>>
  }
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations')

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name: string) => name.endsWith('.sql'))
    .sort()
}

function applyMigrations(db: Db, files: string[]): void {
  for (const file of files) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

// Runs the whole migration chain in a real SQLite (node:sqlite) so D1-side
// semantics — CREATE, seed, DROP — are exercised, not mocked. D1 is SQLite.
describe('migration 0015: ai_usage_events (#353)', () => {
  it('seeds legacy rows and drops ai_usage when applied on top of the pre-0015 schema', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0015')
    )

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare("INSERT INTO users (id, email) VALUES ('u2', 'c@d.com')").run()
    const insertUsage = db.prepare(
      `INSERT INTO ai_usage (id, user_id, date, provider, used, daily_limit, input_tokens, output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    insertUsage.run('day-1', 'u1', '2026-10-30', 'gemini', 3, 20, 1200, 300)
    insertUsage.run('day-2', 'u2', '2026-10-15', null, 0, 20, 0, 0)

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0015_ai_usage_events.sql'), 'utf8'))

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ai_usage', 'ai_usage_events')"
      )
      .all()
    expect(tables.map((r: Record<string, unknown>) => r.name)).toEqual(['ai_usage_events'])

    const events = db.prepare('SELECT * FROM ai_usage_events ORDER BY ts').all()
    expect(events).toEqual([
      expect.objectContaining({
        id: 'legacy-day-2',
        user_id: 'u2',
        ts: '2026-10-15T00:00:00Z',
        date: '2026-10-15',
        provider: null,
        model: null,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: null,
        key_source: null,
      }),
      expect.objectContaining({
        id: 'legacy-day-1',
        user_id: 'u1',
        ts: '2026-10-30T00:00:00Z',
        date: '2026-10-30',
        provider: 'gemini',
        model: null,
        input_tokens: 1200,
        output_tokens: 300,
        cached_tokens: null,
        key_source: null,
      }),
    ])
  })

  it('keeps the full chain green on a fresh database (down-safety: nothing references ai_usage)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ai_usage_events' ORDER BY name"
      )
      .all()
    expect(indexes.map((r: Record<string, unknown>) => r.name)).toEqual(
      expect.arrayContaining(['idx_ai_usage_events_ts', 'idx_ai_usage_events_user_ts'])
    )

    // Live rows carry provider, model, cached tokens and key source.
    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO ai_usage_events
         (id, user_id, ts, date, provider, model, input_tokens, output_tokens, cached_tokens, key_source)
       VALUES ('e1', 'u1', '2026-11-01T07:00:00.000Z', '2026-11-01', 'gemini', 'gemini-3.6-flash', 900, 100, 640, 'user')`
    ).run()
    const row = db.prepare('SELECT * FROM ai_usage_events WHERE id = ?').get('e1')
    expect(row).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.6-flash',
      cached_tokens: 640,
      key_source: 'user',
    })
  })
})

describe('migration 0017: price_observations.source_url (#380)', () => {
  it('adds the nullable evidence column on top of the pre-0017 schema; old rows stay null', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0017')
    )

    db.prepare(
      `INSERT INTO price_sources (id, slug, name) VALUES ('src-1', 'lotte-mart', 'Lotte Mart')`
    ).run()
    db.prepare(
      `INSERT INTO price_products (id, product_key, name) VALUES ('prod-1', 'beras--ramos--5-kg', 'Beras Ramos 5kg')`
    ).run()
    db.prepare(
      `INSERT INTO price_observations
         (id, product_id, source_id, observed_date, price, match_confidence, scraped_at)
       VALUES ('obs-1', 'prod-1', 'src-1', '2026-10-24', 27000, 1.0, '2026-10-24T23:00:05Z')`
    ).run()

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0017_observation_source_url.sql'), 'utf8'))

    // The pre-existing row survives with source_url NULL — no backfill.
    const old = db.prepare('SELECT * FROM price_observations WHERE id = ?').get('obs-1')
    expect(old).toMatchObject({ id: 'obs-1', source_url: null })

    // New rows carry the retailer campaign/listing page.
    db.prepare(
      `INSERT INTO price_observations
         (id, product_id, source_id, observed_date, price, match_confidence, scraped_at, source_url)
       VALUES ('obs-2', 'prod-1', 'src-1', '2026-10-25', 27000, 1.0, '2026-10-25T23:00:05Z',
               'https://www.lottemart.co.id/promosi/katalog')`
    ).run()
    const fresh = db.prepare('SELECT * FROM price_observations WHERE id = ?').get('obs-2')
    expect(fresh).toMatchObject({
      source_url: 'https://www.lottemart.co.id/promosi/katalog',
    })
  })

  it('keeps the full chain green on a fresh database', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    const columns = db.prepare('PRAGMA table_info(price_observations)').all()
    expect(columns.map((c: Record<string, unknown>) => c.name)).toContain('source_url')
  })
})

describe('migration 0018: user_plans (#376)', () => {
  it('creates the additive plan table; rows default to free, keyed by user_id', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    // No writer exists yet (assignment is a future ticket) — the table must
    // still accept a bare row and default it to the everyone-free baseline.
    db.prepare(`INSERT INTO user_plans (user_id) VALUES ('u1')`).run()
    expect(db.prepare('SELECT * FROM user_plans WHERE user_id = ?').get('u1')).toEqual({
      user_id: 'u1',
      plan: 'free',
      updated_at: null,
    })

    // user_id is the PRIMARY KEY — one plan per user.
    expect(() =>
      db.prepare(`INSERT INTO user_plans (user_id, plan) VALUES ('u1', 'premium')`).run()
    ).toThrow()

    // plan is free-form TEXT (no CHECK): a future plan enum grows without
    // another migration; unknown values resolve to 'free' in resolvePlan.
    db.prepare(
      `INSERT INTO user_plans (user_id, plan, updated_at) VALUES ('u2', 'premium', ?)`
    ).run('2026-11-03T00:00:00Z')
    expect(db.prepare('SELECT * FROM user_plans WHERE user_id = ?').get('u2')).toMatchObject({
      plan: 'premium',
      updated_at: '2026-11-03T00:00:00Z',
    })
  })

  it('keeps the full chain green on a fresh database (additive, nothing dropped)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_plans'")
      .all()
    expect(tables.map((r: Record<string, unknown>) => r.name)).toEqual(['user_plans'])
  })
})

describe('migration 0019: price_observations.taxo_version (#373)', () => {
  it('adds the nullable taxonomy stamp on top of the pre-0019 schema; old rows stay null', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0019')
    )

    db.prepare(
      `INSERT INTO price_sources (id, slug, name) VALUES ('src-1', 'lotte-mart', 'Lotte Mart')`
    ).run()
    db.prepare(
      `INSERT INTO price_products (id, product_key, name) VALUES ('prod-1', 'beras--ramos--5-kg', 'Beras Ramos 5kg')`
    ).run()
    db.prepare(
      `INSERT INTO price_observations
         (id, product_id, source_id, observed_date, price, match_confidence, scraped_at)
       VALUES ('obs-1', 'prod-1', 'src-1', '2026-11-01', 27000, 1.0, '2026-11-01T23:00:05Z')`
    ).run()

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0019_observation_taxonomy.sql'), 'utf8'))

    // The pre-existing row survives with taxo_version NULL — the backfill
    // owns stamping it later.
    const old = db.prepare('SELECT * FROM price_observations WHERE id = ?').get('obs-1')
    expect(old).toMatchObject({ id: 'obs-1', taxo_version: null })

    // New rows carry the classifying taxonomy version.
    db.prepare(
      `INSERT INTO price_observations
         (id, product_id, source_id, observed_date, price, match_confidence, scraped_at, taxo_version)
       VALUES ('obs-2', 'prod-1', 'src-1', '2026-11-02', 27000, 1.0, '2026-11-02T23:00:05Z', 'v0.2')`
    ).run()
    const fresh = db.prepare('SELECT * FROM price_observations WHERE id = ?').get('obs-2')
    expect(fresh).toMatchObject({ taxo_version: 'v0.2' })
  })

  it('keeps the full chain green on a fresh database', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    const columns = db.prepare('PRAGMA table_info(price_observations)').all()
    expect(columns.map((c: Record<string, unknown>) => c.name)).toContain('taxo_version')
  })
})
