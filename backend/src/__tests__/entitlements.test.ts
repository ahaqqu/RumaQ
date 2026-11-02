import { describe, it, expect, vi } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import {
  resolvePlan,
  requireEntitlement,
  PLAN_ENTITLEMENTS,
  type Entitlement,
} from '../lib/entitlements.js'
// The backend tsconfig pins `types` to @cloudflare/workers-types, so Node
// builtin imports carry no declarations — same contained suppressions as
// migrations.test.ts / match-review.test.ts: the entitlement wiring below is
// exercised against real SQLite (node:sqlite — D1 is SQLite), which the
// string-matching fake db cannot give (the prices routes' CTEs and window
// functions must actually execute).
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

type Bindings = Parameters<typeof resolvePlan>[0]

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations')

function migrationFiles(upTo?: string): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name: string) => name.endsWith('.sql'))
    .filter((name: string) => !upTo || name <= upTo)
    .sort()
}

function applyMigrations(db: SqliteDb, files: string[]): void {
  for (const file of files) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

// Minimal D1-shaped adapter over node:sqlite — the surface the prices routes
// and the entitlement guard use (prepare → bind → all/first/run, batch).
// Every executed SQL string is recorded so tests can pin that the entitlement
// lookup actually ran per request (a silently-detached middleware would still
// answer 200s but skip the lookup).
function sqliteD1(db: SqliteDb) {
  const sqlCalls: string[] = []
  const makeStatement = (sql: string) => {
    const exec = {
      sql,
      params: [] as unknown[],
      bind(...params: unknown[]) {
        exec.params = params
        return exec
      },
      async all() {
        return { results: db.prepare(sql).all(...exec.params) }
      },
      async first() {
        return (db.prepare(sql).get(...exec.params) ?? null) as unknown
      },
      async run() {
        db.prepare(sql).run(...exec.params)
        return { success: true }
      },
    }
    sqlCalls.push(sql)
    return exec
  }
  const d1 = {
    prepare: (sql: string) => makeStatement(sql),
    async batch(statements: Array<ReturnType<typeof makeStatement>>) {
      return statements.map((statement) => ({
        results: db.prepare(statement.sql).all(...statement.params),
        success: true,
      }))
    },
  }
  return { db: d1 as unknown as D1Database, sqlCalls }
}

const PLAN_LOOKUP = 'SELECT plan FROM user_plans WHERE user_id = ?'

function createSqliteEnv(db: D1Database, userId = 'u1') {
  return {
    DB: db,
    RECEIPTS: {},
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    WORKER_JWT_SECRET: 'test-secret',
    WORKER_ENCRYPTION_KEY: 'test-encryption-key-32-bytes-long!!',
    EMAIL_AUTH_ENABLED: 'false',
    ASSETS: undefined as unknown as Fetcher,
    props: { userId, householdId: 'h1' },
    TEST_MODE: 'true',
  }
}

function bindingsEnv(db: D1Database): Bindings {
  return { DB: db } as unknown as Bindings
}

function seedCatalog(db: SqliteDb): void {
  db.prepare(
    `INSERT INTO price_sources (id, slug, name) VALUES ('src-1', 'lotte-mart', 'Lotte Mart')`
  ).run()
  db.prepare(
    `INSERT INTO price_products (id, product_key, name)
     VALUES ('prod-1', 'minyak-goreng--bimoli--1-l', 'Minyak Goreng Bimoli')`
  ).run()
  db.prepare(
    `INSERT INTO price_observations
       (id, product_id, source_id, observed_date, price, match_confidence, scraped_at)
     VALUES ('obs-1', 'prod-1', 'src-1', '2026-11-02', 21500, 1.0, '2026-11-02T23:00:05Z')`
  ).run()
}

// Flip PLAN_ENTITLEMENTS.premium for one test and restore it no matter how
// the test ends — the map is module state shared by the whole backend suite.
async function withPremiumEntitlements<T>(entitlements: Entitlement[], run: () => Promise<T>) {
  const original = PLAN_ENTITLEMENTS.premium
  PLAN_ENTITLEMENTS.premium = new Set<Entitlement>(entitlements)
  try {
    return await run()
  } finally {
    PLAN_ENTITLEMENTS.premium = original
  }
}

describe('resolvePlan', () => {
  it('defaults to free when the user_plans table is absent (pre-migration deploy)', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyMigrations(sqlite, migrationFiles('0017_observation_source_url.sql'))
    const { db } = sqliteD1(sqlite)

    expect(await resolvePlan(bindingsEnv(db), 'u1')).toBe('free')
  })

  it('defaults to free for a missing row, an unknown plan value, and a free row', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyMigrations(sqlite, migrationFiles())
    const { db } = sqliteD1(sqlite)

    expect(await resolvePlan(bindingsEnv(db), 'u1')).toBe('free') // missing row

    sqlite.prepare(`INSERT INTO user_plans (user_id) VALUES ('u1')`).run() // DEFAULT 'free'
    expect(await resolvePlan(bindingsEnv(db), 'u1')).toBe('free')

    sqlite.prepare(`INSERT INTO user_plans (user_id, plan) VALUES ('u2', 'enterprise')`).run()
    expect(await resolvePlan(bindingsEnv(db), 'u2')).toBe('free') // unknown value ⇒ free

    sqlite.prepare(`INSERT INTO user_plans (user_id, plan) VALUES ('u3', 'premium')`).run()
    expect(await resolvePlan(bindingsEnv(db), 'u3')).toBe('premium')
  })

  it('never throws when the read fails (free on error) — and logs the swallow', async () => {
    // Fail-open is the documented contract, but the swallowed error must stay
    // visible: once 'free' stops carrying every entitlement, a silent D1
    // outage would hold the fail-open door open with no signal (thermos A1).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const throwing = {
        prepare: () => {
          throw new Error('D1 unavailable')
        },
      } as unknown as D1Database
      expect(await resolvePlan(bindingsEnv(throwing), 'u1')).toBe('free')
      expect(warn).toHaveBeenCalledWith(
        '[entitlements] user_plans lookup failed; resolving free:',
        expect.any(Error)
      )
    } finally {
      warn.mockRestore()
    }
  })
})

describe('requireEntitlement', () => {
  it('answers ok for every entitlement the plan carries', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyMigrations(sqlite, migrationFiles())
    const { db } = sqliteD1(sqlite)
    sqlite.prepare(`INSERT INTO user_plans (user_id, plan) VALUES ('u1', 'premium')`).run()

    const env = bindingsEnv(db)
    await expect(requireEntitlement(env, 'u1', 'prices.explore')).resolves.toEqual({ ok: true })
    await expect(requireEntitlement(env, 'u1', 'prices.history')).resolves.toEqual({ ok: true })
  })

  it('returns the bare 403 shape when the plan lacks the entitlement (map override)', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyMigrations(sqlite, migrationFiles())
    const { db } = sqliteD1(sqlite)
    sqlite.prepare(`INSERT INTO user_plans (user_id, plan) VALUES ('u1', 'premium')`).run()
    const env = bindingsEnv(db)

    await withPremiumEntitlements(['prices.explore'], async () => {
      const verdict = await requireEntitlement(env, 'u1', 'prices.history')
      expect(verdict).toEqual({ ok: false, status: 403, error: 'Forbidden' })
      // The denial never names the plan.
      expect(JSON.stringify(verdict)).not.toContain('premium')
    })
  })

  it('keeps the free plan untouched by the override (only premium was flipped)', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyMigrations(sqlite, migrationFiles())
    const { db } = sqliteD1(sqlite)
    const env = bindingsEnv(db)

    await withPremiumEntitlements([], async () => {
      // u1 has no row ⇒ free ⇒ still carries everything.
      await expect(requireEntitlement(env, 'u1', 'prices.history')).resolves.toEqual({ ok: true })
    })
  })
})

// Behavior-neutral pins (design §7.3): with no user_plans row the guard
// resolves 'free', which carries every entitlement — all five /api/prices*
// routes answer exactly as before, and the plan lookup is observable in the
// SQL log.
describe('prices routes — entitlement wiring, behavior-neutral tonight', () => {
  it('plan-missing ⇒ 200 on all five routes, with one plan lookup each', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyMigrations(sqlite, migrationFiles())
    seedCatalog(sqlite)
    const { db, sqlCalls } = sqliteD1(sqlite)
    const env = createSqliteEnv(db)

    const list = await apiApp.request('/api/prices', {}, env)
    expect(list.status).toBe(200)

    const meta = await apiApp.request('/api/prices/meta', {}, env)
    expect(meta.status).toBe(200)
    expect(await meta.json()).toEqual({
      latestObservedDate: '2026-11-02',
      latestScrapedAt: '2026-11-02T23:00:05Z',
      observationCount: 1,
    })

    const promos = await apiApp.request('/api/prices/promos', {}, env)
    expect(promos.status).toBe(200)

    const brochures = await apiApp.request('/api/prices/brochures', {}, env)
    expect(brochures.status).toBe(200)

    const detail = await apiApp.request('/api/prices/minyak-goreng--bimoli--1-l', {}, env)
    expect(detail.status).toBe(200)
    const body = (await detail.json()) as { product: { product_key: string } }
    expect(body.product.product_key).toBe('minyak-goreng--bimoli--1-l')

    expect(sqlCalls.filter((sql) => sql === PLAN_LOOKUP)).toHaveLength(5)
  })

  it('maps explore routes to prices.explore and only the detail route to prices.history', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyMigrations(sqlite, migrationFiles())
    seedCatalog(sqlite)
    const { db } = sqliteD1(sqlite)
    sqlite.prepare(`INSERT INTO user_plans (user_id, plan) VALUES ('u1', 'premium')`).run()
    const env = createSqliteEnv(db)
    const exploreRoutes = [
      '/api/prices',
      '/api/prices/meta',
      '/api/prices/promos',
      '/api/prices/brochures',
    ]

    // Premium stripped of prices.history: the four explore routes stay open,
    // the detail/history route denies — the route-level attachment keeps the
    // statics from being captured by :productKey (double-gating landmine).
    await withPremiumEntitlements(['prices.explore'], async () => {
      for (const path of exploreRoutes) {
        const res = await apiApp.request(path, {}, env)
        expect(res.status).toBe(200)
      }
      const denied = await apiApp.request('/api/prices/minyak-goreng--bimoli--1-l', {}, env)
      expect(denied.status).toBe(403)
      expect(await denied.json()).toEqual({ error: 'Forbidden' })
    })

    // Mirror image: premium stripped of prices.explore denies the listing and
    // the statics while the detail route stays open.
    await withPremiumEntitlements(['prices.history'], async () => {
      for (const path of exploreRoutes) {
        const res = await apiApp.request(path, {}, env)
        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'Forbidden' })
      }
      const detail = await apiApp.request('/api/prices/minyak-goreng--bimoli--1-l', {}, env)
      expect(detail.status).toBe(200)
    })
  })

  it('runs the entitlement check after the session guard (401 wins over 403)', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyMigrations(sqlite, migrationFiles())
    seedCatalog(sqlite)
    const { db } = sqliteD1(sqlite)
    sqlite.prepare(`INSERT INTO user_plans (user_id, plan) VALUES ('u1', 'premium')`).run()
    const env = { ...createSqliteEnv(db), props: undefined }

    // A stripped plan would 403, but the session guard runs first.
    await withPremiumEntitlements([], async () => {
      const res = await apiApp.request('/api/prices', {}, env)
      expect(res.status).toBe(401)
    })
  })
})
