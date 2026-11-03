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

// Household member management (ahaqqu/RumaQ#331): additive profile fields on
// household_members (display_name, birth_date — stable addressable member
// entities so per-member features like a BayiQ immunization chart can attach
// later without schema surgery) plus the owner-issued invite-code table.
describe('migration 0020: household member profiles + invites (#331)', () => {
  it('adds nullable member profile columns on top of the pre-0020 schema; old rows stay null', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0020')
    )

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO household_members (household_id, user_id, role) VALUES ('h1', 'u1', 'owner')`
    ).run()

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0020_household_member_profiles.sql'), 'utf8'))

    // The pre-existing membership survives with both profile fields NULL —
    // no backfill; the household screen owns collecting them.
    const old = db
      .prepare('SELECT * FROM household_members WHERE household_id = ? AND user_id = ?')
      .get('h1', 'u1')
    expect(old).toMatchObject({
      household_id: 'h1',
      user_id: 'u1',
      role: 'owner',
      display_name: null,
      birth_date: null,
    })

    // New rows carry the per-member profile (dates as TEXT 'YYYY-MM-DD').
    db.prepare("INSERT INTO users (id, email) VALUES ('u2', 'b@c.com')").run()
    db.prepare(
      `INSERT INTO household_members (household_id, user_id, role, display_name, birth_date)
       VALUES ('h1', 'u2', 'member', 'Putri', '2024-05-01')`
    ).run()
    const fresh = db
      .prepare('SELECT * FROM household_members WHERE household_id = ? AND user_id = ?')
      .get('h1', 'u2')
    expect(fresh).toMatchObject({ display_name: 'Putri', birth_date: '2024-05-01' })
  })

  it('creates the household_invites table with a unique code_hash and cascading delete', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO household_invites (id, household_id, code_hash, code_encrypted, created_by, expires_at)
       VALUES ('inv-1', 'h1', '${'a'.repeat(64)}', 'enc-payload', 'u1', '2026-11-10 00:00:00')`
    ).run()
    const invite = db.prepare('SELECT * FROM household_invites WHERE id = ?').get('inv-1')
    expect(invite).toMatchObject({
      id: 'inv-1',
      household_id: 'h1',
      revoked_at: null,
    })

    // code_hash is the join lookup handle — it must be unique. No plaintext
    // `code` column exists at all (review A8): a DB leak yields neither codes
    // nor a hash preimage to search.
    expect(() =>
      db
        .prepare(
          `INSERT INTO household_invites (id, household_id, code_hash, code_encrypted, created_by, expires_at)
           VALUES ('inv-2', 'h1', '${'a'.repeat(64)}', 'enc-payload-2', 'u1', '2026-11-10 00:00:00')`
        )
        .run()
    ).toThrow()
    const columns = db.prepare('PRAGMA table_info(household_invites)').all()
    const names = columns.map((c: Record<string, unknown>) => c.name)
    expect(names).toContain('code_hash')
    expect(names).toContain('code_encrypted')
    expect(names).not.toContain('code')

    // Deleting the household cascades to its invites (no orphan codes).
    db.prepare('DELETE FROM households WHERE id = ?').run('h1')
    const remaining = db.prepare('SELECT COUNT(*) AS cnt FROM household_invites').all()
    expect(remaining).toEqual([{ cnt: 0 }])
  })

  it('indexes household_members(user_id) so per-request membership lookups seek', () => {
    // Review A1: the auth middleware's COALESCE fallback, listHouseholds, and
    // the departure remaining-check all filter by user_id alone — without the
    // index each ran a full scan + temp B-tree sort per request.
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    const index = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_household_members_user'"
      )
      .get()
    expect(index).toMatchObject({
      sql: expect.stringContaining('idx_household_members_user'),
    })

    // The fallback half of the auth resolution must be a SEARCH on that index
    // with no TABLE SCAN and no temp-B-tree sort — the per-request budget.
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT household_id FROM household_members
          WHERE user_id = ? ORDER BY joined_at, household_id LIMIT 1`
      )
      .all('u1')
    const detail = plan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(detail).toContain('idx_household_members_user')
    expect(detail).not.toMatch(/SCAN|TEMP B-TREE/i)
  })

  it('keeps the full chain green on a fresh database', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    const memberColumns = db.prepare('PRAGMA table_info(household_members)').all()
    const names = memberColumns.map((c: Record<string, unknown>) => c.name)
    expect(names).toEqual(expect.arrayContaining(['display_name', 'birth_date']))
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'household_invites'")
      .all()
    expect(tables.map((r: Record<string, unknown>) => r.name)).toEqual(['household_invites'])
  })
})

// Two-mode members (ahaqqu/RumaQ#388): the household_members rebuild —
// surrogate PK, nullable user_id (NULL = profile-only member), and the old
// PK-pair uniqueness re-established as a partial unique index. The rebuild is
// a create-new/copy/rename, so the interesting question is what SURVIVES it.
describe('migration 0021: two-mode household members (#388)', () => {
  it('rebuilds the table: old rows keep their data and gain a surrogate id', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0021')
    )

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare("INSERT INTO users (id, email) VALUES ('u2', 'c@d.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO household_members (household_id, user_id, role, joined_at, display_name, birth_date)
       VALUES ('h1', 'u1', 'owner', '2026-01-01 00:00:00', 'Mama', '1995-01-01')`
    ).run()

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0021_two_mode_household_members.sql'), 'utf8'))

    // The pre-0021 membership survives with every column intact and a
    // backfilled surrogate id (the vault's future attach handle).
    const row = db
      .prepare('SELECT * FROM household_members WHERE household_id = ? AND user_id = ?')
      .get('h1', 'u1') as Record<string, unknown>
    expect(row).toMatchObject({
      household_id: 'h1',
      user_id: 'u1',
      role: 'owner',
      joined_at: '2026-01-01 00:00:00',
      display_name: 'Mama',
      birth_date: '1995-01-01',
    })
    expect(typeof row['id']).toBe('string')
    expect(String(row['id'])).toMatch(/^[0-9a-f]{32}$/)

    // Mode B is representable now: user_id is nullable, so a profile-only
    // member (no account) is a plain row.
    db.prepare(
      `INSERT INTO household_members (id, household_id, user_id, role, display_name, birth_date)
       VALUES ('m-profile', 'h1', NULL, 'member', 'Adik', '2025-03-02')`
    ).run()
    const profile = db.prepare('SELECT * FROM household_members WHERE id = ?').get('m-profile')
    expect(profile).toMatchObject({ user_id: null, role: 'member' })

    // The rebuild left no scaffold table behind.
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'household_members%'"
      )
      .all()
    expect(tables.map((r: Record<string, unknown>) => r.name)).toEqual(['household_members'])
  })

  it('enforces the old PK-pair uniqueness for linked members only (partial index)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()

    const linked = db.prepare(
      'INSERT INTO household_members (id, household_id, user_id, role) VALUES (?, ?, ?, ?)'
    )
    linked.run('m1', 'h1', 'u1', 'owner')
    // The partial unique index carries the old PK guarantee: one row per
    // account per household.
    expect(() => linked.run('m2', 'h1', 'u1', 'member')).toThrow()
    // Profile-only rows (NULL user_id) are exempt — several account-less
    // people may share a household.
    linked.run('m3', 'h1', null, 'member')
    linked.run('m4', 'h1', null, 'member')

    // The partial index is really partial: it fires for user_id IS NOT NULL.
    const index = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_household_members_household_user'"
      )
      .get() as { sql: string | null }
    expect(index.sql).toContain('WHERE user_id IS NOT NULL')
  })

  it('keeps the 0020 auth-fallback index plan fast across the rebuild', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    // Same EXPLAIN contract as the 0020 test — the rebuild recreates the
    // index, and the per-request fast path must not silently regress to a
    // scan or a temp B-tree sort.
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT household_id FROM household_members
          WHERE user_id = ? ORDER BY joined_at, household_id LIMIT 1`
      )
      .all('u1')
    const detail = plan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(detail).toContain('idx_household_members_user')
    expect(detail).not.toMatch(/SCAN|TEMP B-TREE/i)

    // The per-household scans the old PK prefix used to serve (roster,
    // owner counts, member_count) seek through the new household index.
    const rosterPlan = db
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM household_members WHERE household_id = ?')
      .all('h1')
    const rosterDetail = rosterPlan
      .map((r: Record<string, unknown>) => String(r.detail))
      .join(' | ')
    expect(rosterDetail).toContain('idx_household_members_household')
    expect(rosterDetail).not.toMatch(/SCAN|TEMP B-TREE/i)
  })
})
