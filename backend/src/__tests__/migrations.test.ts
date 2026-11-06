import { describe, it, expect } from 'vite-plus/test'
import {
  PLUGIN_ENABLEMENT_SQL,
  HOUSEHOLD_ENABLEMENT_ROWS_SQL,
  HOUSEHOLD_CATALOG_ROWS_SQL,
  PLUGIN_PURGE_STATE_SQL,
  PLUGIN_PURGE_ROW_SQL,
  HOUSEHOLDS_ENABLED_BY_DEFAULT_SQL,
  HOUSEHOLDS_ENABLED_EXPLICIT_SQL,
} from '../plugins/enablement.js'
import { PURGING_HOUSEHOLDS_SQL } from '../lib/plugin-purge.js'
import { deploymentFlagKey } from '../plugins/flags.js'
import { AUDIT_INSERT_SQL, ENABLEMENT_UPSERT_SQL } from '../lib/plugins.js'
import { EVENT_SELECT, VISIBLE_PREDICATE } from '../lib/calendar.js'
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

// Document vault (ahaqqu/RumaQ#388 MVP): documents + document_audit. The
// interesting questions are the FK semantics — which row removals cascade,
// which keep the document — and the audit trail's deliberate FK-less design.
// These tests pin the 0022-era shape, so the chain stops at 0024: #422's 0025
// rebuilds documents around the free-text name and moves the file columns
// into document_files (see the 0025 describe below).
describe('migration 0022: document vault (#388)', () => {
  const filesBelow0025 = () => migrationFiles().filter((file: string) => file < '0025')

  it('creates documents with the closed category set and both-mode member FK', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, filesBelow0025())

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO household_members (id, household_id, user_id, role)
       VALUES ('m-linked', 'h1', 'u1', 'owner')`
    ).run()
    // Mode B: a profile-only member (toddler, no account).
    db.prepare(
      `INSERT INTO household_members (id, household_id, user_id, role)
       VALUES ('m-profile', 'h1', NULL, 'member')`
    ).run()

    const insertDoc = db.prepare(
      `INSERT INTO documents
         (id, household_id, member_id, category, file_name, mime_type, size_bytes,
          storage_key, sha256, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    // Linked member relation.
    insertDoc.run(
      'doc-1',
      'h1',
      'm-linked',
      'ktp',
      'ktp.jpg',
      'image/jpeg',
      1234,
      'documents/h1/doc-1',
      'a'.repeat(64),
      'u1'
    )
    // Profile-only member relation — the vault's core use (akta lahir of a
    // child with no account).
    insertDoc.run(
      'doc-2',
      'h1',
      'm-profile',
      'akta',
      'akta.pdf',
      'application/pdf',
      5678,
      'documents/h1/doc-2',
      'b'.repeat(64),
      'u1'
    )
    // Household-level document: no member at all.
    insertDoc.run(
      'doc-3',
      'h1',
      null,
      'kartu_keluarga',
      'kk.jpg',
      'image/jpeg',
      90,
      'documents/h1/doc-3',
      'c'.repeat(64),
      'u1'
    )

    const columns = db.prepare('PRAGMA table_info(documents)').all()
    const names = columns.map((c: Record<string, unknown>) => c.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'household_id',
        'member_id',
        'category',
        'file_name',
        'mime_type',
        'size_bytes',
        'storage_key',
        'sha256',
        'uploaded_by',
        'created_at',
      ])
    )

    // The category CHECK is a real constraint, not just an app-side allowlist.
    expect(() =>
      insertDoc.run(
        'doc-x',
        'h1',
        null,
        'ijazah',
        'x.jpg',
        'image/jpeg',
        1,
        'documents/h1/doc-x',
        'd'.repeat(64),
        'u1'
      )
    ).toThrow()
  })

  it('deleting a member (either mode) keeps their documents and clears the link', () => {
    // ON DELETE SET NULL, never CASCADE: a D1 cascade cannot reach the R2
    // object, so member removal must not orphan the bytes — the household
    // still owns the document, only the person link is cleared.
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, filesBelow0025())

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO household_members (id, household_id, user_id, role)
       VALUES ('m-linked', 'h1', 'u1', 'owner')`
    ).run()
    db.prepare(
      `INSERT INTO household_members (id, household_id, user_id, role)
       VALUES ('m-profile', 'h1', NULL, 'member')`
    ).run()
    const insertDoc = db.prepare(
      `INSERT INTO documents
         (id, household_id, member_id, category, file_name, mime_type, size_bytes,
          storage_key, sha256, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    insertDoc.run(
      'doc-1',
      'h1',
      'm-linked',
      'ktp',
      'ktp.jpg',
      'image/jpeg',
      1,
      'documents/h1/doc-1',
      'a'.repeat(64),
      'u1'
    )
    insertDoc.run(
      'doc-2',
      'h1',
      'm-profile',
      'akta',
      'akta.pdf',
      'application/pdf',
      2,
      'documents/h1/doc-2',
      'b'.repeat(64),
      'u1'
    )

    db.prepare('DELETE FROM household_members WHERE id = ?').run('m-linked')
    db.prepare('DELETE FROM household_members WHERE id = ?').run('m-profile')

    expect(db.prepare('SELECT member_id FROM documents WHERE id = ?').get('doc-1')).toMatchObject({
      member_id: null,
    })
    expect(db.prepare('SELECT member_id FROM documents WHERE id = ?').get('doc-2')).toMatchObject({
      member_id: null,
    })
  })

  it('deleting the household cascades documents; audit rows keep their document reference', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, filesBelow0025())

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO household_members (id, household_id, user_id, role)
       VALUES ('m1', 'h1', 'u1', 'owner')`
    ).run()
    db.prepare(
      `INSERT INTO documents
         (id, household_id, member_id, category, file_name, mime_type, size_bytes,
          storage_key, sha256, uploaded_by)
       VALUES ('doc-1', 'h1', NULL, 'akta', 'akta.pdf', 'application/pdf', 1,
               'documents/h1/doc-1', '${'a'.repeat(64)}', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO document_audit (id, document_id, household_id, actor_user_id, action)
       VALUES ('aud-1', 'doc-1', 'h1', 'u1', 'upload')`
    ).run()

    // Household deletion cascades both tables (household_id FKs).
    db.prepare('DELETE FROM households WHERE id = ?').run('h1')
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM documents').all()).toEqual([{ cnt: 0 }])
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM document_audit').all()).toEqual([{ cnt: 0 }])
  })

  it('audit rows survive the document deletion they record (no FK on document_id)', () => {
    // The delete route writes the 'delete' audit record in the same batch as
    // the DELETE — an FK + cascade on document_id would erase exactly that
    // record. The trail must outlive the row it names.
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, filesBelow0025())

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO documents
         (id, household_id, member_id, category, file_name, mime_type, size_bytes,
          storage_key, sha256, uploaded_by)
       VALUES ('doc-1', 'h1', NULL, 'paspor', 'p.pdf', 'application/pdf', 1,
               'documents/h1/doc-1', '${'a'.repeat(64)}', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO document_audit (id, document_id, household_id, actor_user_id, action)
       VALUES ('aud-view', 'doc-1', 'h1', 'u1', 'view')`
    ).run()

    db.prepare('DELETE FROM documents WHERE id = ?').run('doc-1')

    const audit = db
      .prepare('SELECT document_id, action FROM document_audit WHERE id = ?')
      .get('aud-view')
    expect(audit).toEqual({ document_id: 'doc-1', action: 'view' })

    // The action CHECK is real.
    expect(() =>
      db
        .prepare(
          `INSERT INTO document_audit (id, document_id, household_id, actor_user_id, action)
           VALUES ('aud-bad', 'doc-1', 'h1', 'u1', 'share')`
        )
        .run()
    ).toThrow()
  })

  it('indexes the household listing and audit lookups for seeks (no scan, no temp B-tree)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, filesBelow0025())

    const listingPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM documents WHERE household_id = ?
          ORDER BY created_at DESC, id DESC`
      )
      .all('h1')
    const listing = listingPlan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(listing).toContain('idx_documents_household')
    expect(listing).not.toMatch(/SCAN|TEMP B-TREE/i)

    const auditPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT action FROM document_audit WHERE document_id = ?
          ORDER BY created_at`
      )
      .all('doc-1')
    const audit = auditPlan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(audit).toContain('idx_document_audit_document')
    expect(audit).not.toMatch(/SCAN|TEMP B-TREE/i)
  })
})

// Link-later (ahaqqu/RumaQ#397): household_invites.target_member_id — the
// additive column that marks an invite for one profile-only member. The
// interesting questions are the FK semantics: CASCADE (unlike 0022's
// documents SET NULL) because a pending invite is transient data, plus the
// referential integrity of the mark itself.
describe('migration 0023: invite target member (#397)', () => {
  it('adds the nullable target column on top of the pre-0023 schema; old invites stay null', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0023')
    )

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO household_invites (id, household_id, code_hash, code_encrypted, created_by, expires_at)
       VALUES ('inv-1', 'h1', '${'a'.repeat(64)}', 'enc', 'u1', '2026-11-10 00:00:00')`
    ).run()

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0023_invite_target_member.sql'), 'utf8'))

    // The pre-existing invite survives with target_member_id NULL — no
    // backfill; NULL IS the plain-invite marker the join path branches on.
    const old = db.prepare('SELECT * FROM household_invites WHERE id = ?').get('inv-1')
    expect(old).toMatchObject({ id: 'inv-1', target_member_id: null })

    // New invites may carry the mark.
    db.prepare(
      `INSERT INTO household_members (id, household_id, user_id, role)
       VALUES ('m-profile', 'h1', NULL, 'member')`
    ).run()
    db.prepare(
      `INSERT INTO household_invites (id, household_id, code_hash, code_encrypted, created_by, expires_at, target_member_id)
       VALUES ('inv-2', 'h1', '${'b'.repeat(64)}', 'enc', 'u1', '2026-11-10 00:00:00', 'm-profile')`
    ).run()
    const fresh = db.prepare('SELECT * FROM household_invites WHERE id = ?').get('inv-2')
    expect(fresh).toMatchObject({ target_member_id: 'm-profile' })
  })

  it('cascades the invite away when its target member is deleted (transient data)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO household_members (id, household_id, user_id, role)
       VALUES ('m-profile', 'h1', NULL, 'member')`
    ).run()
    db.prepare(
      `INSERT INTO household_invites (id, household_id, code_hash, code_encrypted, created_by, expires_at, target_member_id)
       VALUES ('inv-1', 'h1', '${'a'.repeat(64)}', 'enc', 'u1', '2026-11-10 00:00:00', 'm-profile')`
    ).run()

    // The pending invite is dead weight once the member it names is gone —
    // the 0023 comment's rationale (opposite of documents' SET NULL: a
    // document outlives the member, an unredeemed invite must not survive to
    // attach a redeemer to a ghost row).
    db.prepare('DELETE FROM household_members WHERE id = ?').run('m-profile')
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM household_invites').all()).toEqual([{ cnt: 0 }])
  })

  it('enforces the FK: the target must be a real member row', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()

    expect(() =>
      db
        .prepare(
          `INSERT INTO household_invites (id, household_id, code_hash, code_encrypted, created_by, expires_at, target_member_id)
           VALUES ('inv-x', 'h1', '${'a'.repeat(64)}', 'enc', 'u1', '2026-11-10 00:00:00', 'no-such-member')`
        )
        .run()
    ).toThrow()
  })

  it('keeps the full chain green on a fresh database', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    const columns = db.prepare('PRAGMA table_info(household_invites)').all()
    const names = columns.map((c: Record<string, unknown>) => c.name)
    expect(names).toContain('target_member_id')
  })
})

// Session-epoch logout revocation (ahaqqu/RumaQ#405, owner decision: option 2).
// users.session_epoch is the server-side counter logout bumps; the auth
// middleware compares the epoch signed into the JWT against it. The
// interesting properties: the additive default (no backfill — every existing
// user and every invite-created account sits at 0, which is what pre-feature
// tokens without the claim normalize to), and the per-request lookup cost
// (the middleware's subquery must seek the users primary key, not scan).
describe('migration 0024: users.session_epoch (#405)', () => {
  it('adds the counter column on top of the pre-0024 schema; old rows default to 0', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0024')
    )

    // Rows that predate the feature: email-auth users, Google users, and the
    // profile-only members' would-be accounts all start at epoch 0.
    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO users (id, email, name, picture, google_id)
       VALUES ('u2', 'c@d.com', 'Google User', NULL, 'g-1')`
    ).run()

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0024_session_epoch.sql'), 'utf8'))

    const old = db.prepare('SELECT * FROM users WHERE id = ?').get('u1')
    expect(old).toMatchObject({ id: 'u1', session_epoch: 0 })
    expect(db.prepare('SELECT * FROM users WHERE id = ?').get('u2')).toMatchObject({
      session_epoch: 0,
    })

    // New rows default too — a fresh login flow inserts without naming the
    // column and must land at the compatible epoch.
    db.prepare("INSERT INTO users (id, email) VALUES ('u3', 'e@f.com')").run()
    expect(db.prepare('SELECT * FROM users WHERE id = ?').get('u3')).toMatchObject({
      session_epoch: 0,
    })

    // The logout bump is a monotonic += 1 — representable and persistent.
    db.prepare('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?').run('u1')
    expect(db.prepare('SELECT session_epoch FROM users WHERE id = ?').get('u1')).toMatchObject({
      session_epoch: 1,
    })
  })

  it('keeps the middleware epoch subquery on an indexed seek (no scan, no temp B-tree)', () => {
    // The epoch comparison rides in the SAME statement as the active-household
    // resolution (backend/src/auth.ts) — the per-request budget stays at one
    // indexed lookup. The users half must seek the primary key.
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()

    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT session_epoch FROM users WHERE id = ?')
      .all('u1')
    const detail = plan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(detail).not.toMatch(/SCAN|TEMP B-TREE/i)
  })

  it('keeps the full chain green on a fresh database (additive, nothing dropped)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    const columns = db.prepare('PRAGMA table_info(users)').all()
    const names = columns.map((c: Record<string, unknown>) => c.name)
    expect(names).toContain('session_epoch')
  })
})

// Free-text names + multi-file documents (ahaqqu/RumaQ#422): documents
// rebuilds around `name` (the preset category CHECK and its per-document file
// columns go — the latter move into document_files), document_files carries
// one row per file, and document_audit rebuilds around the widened action
// CHECK + the nullable document_file_id. The migration is real SQL against a
// real SQLite engine: seeded pre-0025 rows ride the actual INSERT..SELECT
// backfills, nothing mocked.
describe('migration 0025: document names + multi-file (#422)', () => {
  it('backfills names from the old categories and mints attachment #1 per legacy document (up from 0024)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0025')
    )

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO household_members (id, household_id, user_id, role)
       VALUES ('m-linked', 'h1', 'u1', 'owner')`
    ).run()

    // One legacy document per category — every label branch of the backfill.
    const categories = [
      ['doc-kk', 'kartu_keluarga'],
      ['doc-ktp', 'ktp'],
      ['doc-anak', 'kartu_anak'],
      ['doc-akta', 'akta'],
      ['doc-paspor', 'paspor'],
      ['doc-bpjs', 'bpjs'],
      ['doc-lain', 'lainnya'],
    ] as const
    const insertDoc = db.prepare(
      `INSERT INTO documents
         (id, household_id, member_id, category, file_name, mime_type, size_bytes,
          storage_key, sha256, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const [id, category] of categories) {
      insertDoc.run(
        id,
        'h1',
        'm-linked',
        category,
        `${id}.jpg`,
        'image/jpeg',
        1234,
        `documents/h1/${id}`,
        ('a' + id).slice(0, 4).padEnd(64, 'b'),
        'u1'
      )
    }
    db.prepare(
      `INSERT INTO document_audit (id, document_id, household_id, actor_user_id, action)
       VALUES ('aud-1', 'doc-ktp', 'h1', 'u1', 'upload')`
    ).run()

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0025_document_names_multifile.sql'), 'utf8'))

    // The category list is GONE from the schema — no remnant anywhere.
    const columns = db.prepare('PRAGMA table_info(documents)').all()
    const names = columns.map((c: Record<string, unknown>) => String(c.name))
    expect(names).toEqual(['id', 'household_id', 'member_id', 'name', 'uploaded_by', 'created_at'])

    // Names backfilled from the old category's human (EN locale) label —
    // readable starting points the owner can rename freely.
    const nameById = Object.fromEntries(
      db
        .prepare('SELECT id, name FROM documents')
        .all()
        .map((r: Record<string, unknown>) => [String(r.id), String(r.name)])
    )
    expect(nameById).toEqual({
      'doc-kk': 'Kartu Keluarga',
      'doc-ktp': 'KTP',
      'doc-anak': 'Kartu Anak',
      'doc-akta': 'Akta Lahir',
      'doc-paspor': 'Paspor',
      'doc-bpjs': 'BPJS',
      'doc-lain': 'Other',
    })
    // Member relation and audit survive the rebuild untouched.
    const ktp = db.prepare('SELECT * FROM documents WHERE id = ?').get('doc-ktp') as Record<
      string,
      unknown
    >
    expect(ktp).toMatchObject({ member_id: 'm-linked', uploaded_by: 'u1' })
    expect(
      db.prepare('SELECT action, document_file_id FROM document_audit WHERE id = ?').get('aud-1')
    ).toEqual({ action: 'upload', document_file_id: null })

    // Attachment #1 per legacy document: the old per-document file metadata,
    // reusing the existing R2 key (no byte movement), sort_order 1, label
    // NULL (optional per the owner decision), upload time = the document's
    // own created_at — that IS when those bytes were uploaded.
    const createdAtById = Object.fromEntries(
      db
        .prepare('SELECT id, created_at FROM documents')
        .all()
        .map((r: Record<string, unknown>) => [String(r.id), String(r.created_at)])
    )
    const files = db.prepare('SELECT * FROM document_files ORDER BY document_id').all() as Array<
      Record<string, unknown>
    >
    expect(files).toHaveLength(categories.length)
    for (const [id] of categories) {
      const file = files.find((f) => f.document_id === id)
      expect(file).toMatchObject({
        id: `file-${id}`,
        r2_key: `documents/h1/${id}`,
        file_name: `${id}.jpg`,
        content_type: 'image/jpeg',
        size_bytes: 1234,
        label: null,
        sort_order: 1,
        uploaded_by: 'u1',
        uploaded_at: createdAtById[id],
      })
    }
  })

  it('enforces the new bounds and the FK semantics on the rebuilt schema', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()

    // name is NOT NULL and bounded — the CHECK is a real constraint, not just
    // an app-side rule.
    const insertDoc = db.prepare(
      `INSERT INTO documents (id, household_id, member_id, name, uploaded_by)
       VALUES (?, ?, ?, ?, ?)`
    )
    expect(() => insertDoc.run('doc-1', 'h1', null, null, 'u1')).toThrow()
    expect(() => insertDoc.run('doc-1', 'h1', null, 'x'.repeat(121), 'u1')).toThrow()
    insertDoc.run('doc-1', 'h1', null, 'x'.repeat(120), 'u1')

    const insertFile = db.prepare(
      `INSERT INTO document_files
         (id, document_id, r2_key, file_name, size_bytes, content_type, label,
          sort_order, sha256, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    // The file FK points at a real document; the label bound is the same 120.
    expect(() =>
      insertFile.run(
        'f-ghost',
        'doc-none',
        'documents/h1/x',
        'a.jpg',
        1,
        'image/jpeg',
        null,
        1,
        'a'.repeat(64),
        'u1'
      )
    ).toThrow()
    expect(() =>
      insertFile.run(
        'f-1',
        'doc-1',
        'documents/h1/doc-1/f-1',
        'a.jpg',
        1,
        'image/jpeg',
        'y'.repeat(121),
        1,
        'a'.repeat(64),
        'u1'
      )
    ).toThrow()
    insertFile.run(
      'f-1',
      'doc-1',
      'documents/h1/doc-1/f-1',
      'a.jpg',
      1,
      'image/jpeg',
      null,
      1,
      'a'.repeat(64),
      'u1'
    )
    insertFile.run(
      'f-2',
      'doc-1',
      'documents/h1/doc-1/f-2',
      'b.pdf',
      2,
      'application/pdf',
      'z'.repeat(120),
      2,
      'b'.repeat(64),
      'u1'
    )

    // The widened audit vocabulary accepts the file-scoped actions and still
    // rejects unknown ones; document_file_id is nullable for document-level
    // rows and carries the file id for file-scoped ones.
    const insertAudit = db.prepare(
      `INSERT INTO document_audit (id, document_id, household_id, actor_user_id, action, document_file_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    for (const [id, action, fileId] of [
      ['aud-add', 'file_add', 'f-1'],
      ['aud-del', 'file_delete', 'f-2'],
      ['aud-view', 'view', 'f-1'],
    ] as const) {
      insertAudit.run(id, 'doc-1', 'h1', 'u1', action, fileId)
    }
    expect(() => insertAudit.run('aud-bad', 'doc-1', 'h1', 'u1', 'share', null)).toThrow()

    // Document deletion cascades the file rows; the audit trail (FK-less)
    // survives both the document and the files it names.
    db.prepare('DELETE FROM documents WHERE id = ?').run('doc-1')
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM document_files').all()).toEqual([{ cnt: 0 }])
    expect(
      (db.prepare('SELECT COUNT(*) AS cnt FROM document_audit').all() as Array<{ cnt: number }>)[0]
        ?.cnt
    ).toBe(3)
  })

  it('keeps the document-files listing and the audit lookups on indexed seeks (no scan, no temp B-tree)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    const filesPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM document_files WHERE document_id = ?
          ORDER BY sort_order`
      )
      .all('doc-1')
    const files = filesPlan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(files).toContain('idx_document_files_document')
    expect(files).not.toMatch(/SCAN|TEMP B-TREE/i)

    const auditPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT action FROM document_audit WHERE document_id = ?
          ORDER BY created_at`
      )
      .all('doc-1')
    const audit = auditPlan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(audit).toContain('idx_document_audit_document')
    expect(audit).not.toMatch(/SCAN|TEMP B-TREE/i)
  })
})

// Expiry & renewal reminders (ahaqqu/RumaQ#426): two nullable metadata
// columns on documents, an expiry-listing index, and the widened audit
// CHECK ('update'). The interesting properties: pure additivity (no
// backfill — expiry starts empty everywhere), the app-level default choice
// (no column DEFAULT: the default is conditional on expires_on being set),
// and that the audit rebuild preserves every row verbatim.
describe('migration 0026: document expiry metadata (#426)', () => {
  it('adds the nullable columns on top of the pre-0026 schema; old rows stay null', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0026')
    )

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    const insertDoc = db.prepare(
      `INSERT INTO documents (id, household_id, member_id, name, uploaded_by)
       VALUES (?, 'h1', NULL, 'KTP Bapak', 'u1')`
    )
    insertDoc.run('doc-1')

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0026_document_expiry_reminders.sql'), 'utf8'))

    // Pre-#426 rows survive with no expiry — expiry is opt-in metadata.
    const old = db.prepare('SELECT * FROM documents WHERE id = ?').get('doc-1')
    expect(old).toMatchObject({ id: 'doc-1', expires_on: null, remind_days_before: null })

    // New rows land at NULL too — the app (PATCH) is the only writer and
    // owns the conditional 30-day default; the column carries no DEFAULT.
    insertDoc.run('doc-2')
    const fresh = db.prepare('SELECT expires_on, remind_days_before FROM documents').all()
    expect(fresh.every((r: Record<string, unknown>) => r.expires_on === null)).toBe(true)
    expect(fresh.every((r: Record<string, unknown>) => r.remind_days_before === null)).toBe(true)
  })

  it('carries the expiry metadata values and the audit vocabulary forward (rebuild copies rows verbatim)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0026')
    )

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO documents (id, household_id, member_id, name, uploaded_by)
       VALUES ('doc-1', 'h1', NULL, 'Paspor', 'u1')`
    ).run()
    const insertAuditSql = `INSERT INTO document_audit (id, document_id, household_id, actor_user_id, action, document_file_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    db.prepare(insertAuditSql).run(
      'aud-1',
      'doc-1',
      'h1',
      'u1',
      'upload',
      null,
      '2026-11-01 00:00:00'
    )
    db.prepare(insertAuditSql).run(
      'aud-2',
      'doc-1',
      'h1',
      'u1',
      'file_add',
      'f-1',
      '2026-11-02 00:00:00'
    )

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0026_document_expiry_reminders.sql'), 'utf8'))

    // The expiry values are representable — ISO date text + integer window.
    db.prepare(`UPDATE documents SET expires_on = ?, remind_days_before = ? WHERE id = ?`).run(
      '2027-05-20',
      60,
      'doc-1'
    )
    expect(
      db.prepare('SELECT expires_on, remind_days_before FROM documents WHERE id = ?').get('doc-1')
    ).toMatchObject({
      expires_on: '2027-05-20',
      remind_days_before: 60,
    })

    // Every pre-0026 audit row survived the rebuild with its exact shape.
    const audit = db.prepare('SELECT * FROM document_audit ORDER BY id').all()
    expect(audit).toHaveLength(2)
    expect(audit[0]).toMatchObject({
      id: 'aud-1',
      action: 'upload',
      document_file_id: null,
      created_at: '2026-11-01 00:00:00',
    })
    expect(audit[1]).toMatchObject({ id: 'aud-2', action: 'file_add', document_file_id: 'f-1' })

    // The widened CHECK accepts 'update' and still rejects unknown actions.
    // Fresh statements: the rebuild dropped and recreated the table.
    expect(() =>
      db
        .prepare(insertAuditSql)
        .run('aud-3', 'doc-1', 'h1', 'u1', 'update', null, '2026-11-03 00:00:00')
    ).not.toThrow()
    expect(() =>
      db
        .prepare(insertAuditSql)
        .run('aud-bad', 'doc-1', 'h1', 'u1', 'share', null, '2026-11-04 00:00:00')
    ).toThrow()
  })

  it('keeps the expiring_within filter on an indexed seek (no scan), with and without the files join', () => {
    // The claim is deliberately scoped to what the plan proves (V2-B4): the
    // household scope + expiry window bound is index-SERVED by
    // (household_id, expires_on) and never degrades to a table SCAN. The
    // shipped statement adds the document_files LEFT JOIN and the
    // created_at/id/sort_order tiebreaker terms, whose sort takes a bounded
    // per-household TEMP B-TREE — unavoidable once the join rides along (the
    // same simplification the 0022/0025 listing proofs make), so no
    // "no TEMP B-TREE" claim is made here. The second plan asserts the seek
    // survives the real join shape.
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    const filterPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM documents
          WHERE household_id = ? AND expires_on IS NOT NULL AND expires_on <= ?
          ORDER BY expires_on ASC`
      )
      .all('h1', '2026-12-31')
    const filterDetail = filterPlan
      .map((r: Record<string, unknown>) => String(r.detail))
      .join(' | ')
    expect(filterDetail).toContain('idx_documents_household_expiry')
    expect(filterDetail).not.toMatch(/SCAN/i)

    const joinPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT d.id AS document_id, d.household_id, d.member_id,
           d.name, d.uploaded_by, d.created_at, d.expires_on, d.remind_days_before,
           f.id AS file_id, f.file_name, f.size_bytes, f.content_type,
           f.label, f.sort_order, f.sha256 AS file_sha256,
           f.uploaded_by AS file_uploaded_by, f.uploaded_at
         FROM documents d
         LEFT JOIN document_files f ON f.document_id = d.id
         WHERE d.household_id = ? AND d.expires_on IS NOT NULL AND d.expires_on <= ?
         ORDER BY d.expires_on ASC, d.created_at DESC, d.id DESC, f.sort_order ASC, f.id ASC`
      )
      .all('h1', '2026-12-31')
    const joinDetail = joinPlan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(joinDetail).toContain('idx_documents_household_expiry')
    expect(joinDetail).not.toMatch(/SCAN documents/i)
    // Pinned, not hidden: the shipped plan takes the bounded tiebreaker sort —
    // the assertion says so explicitly so a future "silent" change to the
    // sort shape cannot go unnoticed in either direction.
    expect(joinDetail).toContain('USE TEMP B-TREE FOR LAST 4 TERMS OF ORDER BY')
    expect(joinDetail).toContain('SEARCH f USING INDEX idx_document_files_document')
  })

  it('keeps the full chain green on a fresh database (additive; default listing untouched)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    const columns = db.prepare('PRAGMA table_info(documents)').all()
    const names = columns.map((c: Record<string, unknown>) => c.name)
    expect(names).toEqual([
      'id',
      'household_id',
      'member_id',
      'name',
      'uploaded_by',
      'created_at',
      'expires_on',
      'remind_days_before',
    ])

    // The old listing index still exists for the newest-first default order.
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM documents
          WHERE household_id = ? ORDER BY created_at DESC, id DESC`
      )
      .all('h1')
    const detail = plan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(detail).toContain('idx_documents_household')
    expect(detail).not.toMatch(/SCAN|TEMP B-TREE/i)
  })
})

// Household tasks (ahaqqu/RumaQ#429): per-member task assignments. The
// interesting questions mirror the vault's: which row removals cascade vs
// SET NULL (a member removal keeps the household's tasks, unattributed), the
// audit trail's FK-less design (deletion records — and recurring completions —
// outlive the row), and the board listing's index plan.
describe('migration 0027: household tasks (#429)', () => {
  it('keeps the full chain green on a fresh database and applies defaults', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('household_tasks', 'household_task_audit') ORDER BY name"
      )
      .all()
    expect(tables.map((r: Record<string, unknown>) => r.name)).toEqual([
      'household_task_audit',
      'household_tasks',
    ])

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO household_members (id, household_id, user_id, role)
       VALUES ('m1', 'h1', 'u1', 'owner')`
    ).run()

    // The INSERT the lib writes omits status/needs_approval/created_at/
    // updated_at — the DEFAULTs must fill them.
    db.prepare(
      `INSERT INTO household_tasks
         (id, household_id, title, assignee_member_id, created_by_member_id, due_date, recurrence)
       VALUES ('t1', 'h1', 'Sapu halaman', NULL, 'm1', '2026-11-10', 'daily')`
    ).run()
    const row = db.prepare('SELECT * FROM household_tasks WHERE id = ?').get('t1')
    expect(row).toMatchObject({
      status: 'open',
      needs_approval: 0,
      due_date: '2026-11-10',
      recurrence: 'daily',
    })
    expect(String(row?.created_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(String(row?.updated_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('cascades the household delete, SET NULLs member references, and lets the audit outlive the task', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO household_members (id, household_id, user_id, role, display_name)
       VALUES ('m1', 'h1', 'u1', 'owner', 'Ibu')`
    ).run()
    // Mode B: the profile-only kid the chores get assigned to.
    db.prepare(
      `INSERT INTO household_members (id, household_id, user_id, role, display_name)
       VALUES ('m2', 'h1', NULL, 'member', 'Adik')`
    ).run()
    db.prepare(
      `INSERT INTO household_tasks
         (id, household_id, title, assignee_member_id, created_by_member_id, needs_approval)
       VALUES ('t1', 'h1', 'Sapu halaman', 'm2', 'm1', 1)`
    ).run()
    db.prepare(
      `INSERT INTO household_task_audit (id, task_id, household_id, actor_user_id, action)
       VALUES ('a1', 't1', 'h1', 'u1', 'create')`
    ).run()

    // Removing the assignee keeps the task and clears the link. The STORED
    // needs_approval column keeps its last lib-maintained value (it is the
    // write-side flag, 0027) — reads derive the honest answer from the live
    // member join instead (lib/tasks.ts toTaskRow), so nothing here can lie.
    db.prepare('DELETE FROM household_members WHERE id = ?').run('m2')
    let row = db.prepare('SELECT * FROM household_tasks WHERE id = ?').get('t1')
    expect(row).toMatchObject({ assignee_member_id: null, needs_approval: 1 })

    // Removing the creator keeps the task; provenance falls to NULL and
    // authorization falls to the owners (lib/tasks.ts).
    db.prepare('DELETE FROM household_members WHERE id = ?').run('m1')
    row = db.prepare('SELECT * FROM household_tasks WHERE id = ?').get('t1')
    expect(row).toMatchObject({ created_by_member_id: null })

    // The task delete cascades NOTHING from the audit: task_id is a plain
    // TEXT handle — the deletion record (and every completion history) must
    // outlive the row it names.
    db.prepare('DELETE FROM household_tasks WHERE id = ?').run('t1')
    const audit = db.prepare('SELECT action FROM household_task_audit WHERE task_id = ?').all('t1')
    expect(audit.map((r: Record<string, unknown>) => r.action)).toEqual(['create'])
  })

  it('keeps the board listing on the shipped SQL: index seek, no scan, sort as an explicit temp B-tree', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    // The EXACT shipped statement (lib/tasks.ts listTasks, status-filtered
    // variant): household+status filter with the (due_date IS NULL)
    // undated-last ordering and the created_at/id tiebreakers. Pinned
    // verbatim — the earlier pin tested an ORDER BY the lib never runs
    // (ahaqqu/RumaQ#445 thermos B1, the #434-B4 precedent).
    //
    // What is true and load-bearing: the 0027 index serves the FILTER (no
    // table SCAN). The expression term in ORDER BY defeats index-order
    // satisfaction, so the sort is a TEMP B-TREE — asserted EXPLICITLY
    // rather than denied: at household scale (tens to low hundreds of rows)
    // the sort is harmless, and an honest pin makes any future plan change
    // (e.g. restructuring undated tasks out) a conscious diff.
    const BOARD_PROJECTION = `SELECT t.id, t.household_id, t.title, t.assignee_member_id,
            am.user_id AS assignee_user_id, t.created_by_member_id, t.due_date,
            t.recurrence, t.status, t.needs_approval, t.approved_by_member_id,
            t.created_at, t.updated_at
       FROM household_tasks t
       LEFT JOIN household_members am ON am.id = t.assignee_member_id`
    const boardPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN ${BOARD_PROJECTION}
       WHERE t.household_id = ? AND t.status = 'open'
       ORDER BY (t.due_date IS NULL), t.due_date, t.created_at, t.id`
      )
      .all('h1')
    const board = boardPlan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(board).toContain('idx_household_tasks_household')
    expect(board).not.toMatch(/\bSCAN\b/)
    expect(board).toContain('TEMP B-TREE FOR ORDER BY')

    // The household-prefix variant (status=all) — same seek, same honest sort.
    const allPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN ${BOARD_PROJECTION}
       WHERE t.household_id = ?
       ORDER BY (t.due_date IS NULL), t.due_date, t.created_at, t.id`
      )
      .all('h1')
    const all = allPlan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(all).toContain('idx_household_tasks_household')
    expect(all).not.toMatch(/\bSCAN\b/)
    expect(all).toContain('TEMP B-TREE FOR ORDER BY')

    // The audit lookups (per task, per household) seek too — the 0022 pair.
    const auditPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT action FROM household_task_audit
          WHERE task_id = ? ORDER BY created_at`
      )
      .all('t1')
    const audit = auditPlan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(audit).toContain('idx_household_task_audit_task')
    expect(audit).not.toMatch(/\bSCAN\b|TEMP B-TREE/i)
  })
})

// Plugin enablement rows (ahaqqu/RumaQ#435, phase A): one row per
// (household, plugin) for the household's EXPLICIT choice. The composite PK
// is BOTH the uniqueness constraint and the household_id-prefix index every
// read seeks — EXPLAIN proves the resolver's exact statements (imported from
// plugins/enablement.ts, the ACTIVE_HOUSEHOLD_SQL pattern: the real-SQL test
// runs the EXACT statement the middleware runs) seek the implicit PK index
// with no table scan. The ABSENT-row resolution (manifest.defaultEnabled)
// and the fail-closed read posture live in the resolver, table-tested in
// plugin-enablement.test.ts. NOTE: 0027 is reserved for the in-flight #429
// task-assignments branch — 0028/0029 are numbered to let both land.
describe('migration 0028: household_plugins (#435)', () => {
  it('records explicit choices only: PK uniqueness, status CHECK, cascade, config_json', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()

    const insert = db.prepare(
      `INSERT INTO household_plugins (household_id, plugin_id, status) VALUES (?, ?, ?)`
    )
    insert.run('h1', 'documents', 'enabled')
    // The composite PK: one row per (household, plugin) — a household cannot
    // hold two opinions about one plugin.
    expect(() => insert.run('h1', 'documents', 'disabled')).toThrow()
    // The status CHECK is a real constraint, not just an app-side enum.
    expect(() => insert.run('h1', 'other', 'paused')).toThrow()

    // config_json (small non-secret per-plugin settings, §4.6) is
    // representable now so ticket 3 writes it without a schema change; the
    // updated_at default fills itself.
    insert.run('h1', 'other-plugin', 'disabled')
    db.prepare(
      `UPDATE household_plugins SET config_json = ? WHERE household_id = ? AND plugin_id = ?`
    ).run('{"order":"alpha"}', 'h1', 'other-plugin')
    const row = db.prepare(`SELECT * FROM household_plugins WHERE plugin_id = 'other-plugin'`).get()
    expect(row).toMatchObject({
      household_id: 'h1',
      plugin_id: 'other-plugin',
      status: 'disabled',
      config_json: '{"order":"alpha"}',
    })
    expect(row).toHaveProperty('updated_at')

    // config_json carries the same CHECK discipline as `status`: real JSON or
    // NULL, never garbage (a settings writer's bug must not poison the column).
    expect(() =>
      db
        .prepare(
          `UPDATE household_plugins SET config_json = ? WHERE household_id = ? AND plugin_id = ?`
        )
        .run('not json', 'h1', 'other-plugin')
    ).toThrow()

    // Deleting the household cascades its enablement rows — they are
    // household-scoped facts (unlike the lifecycle audit table, 0032, which
    // is deliberately FK-less, plan §3.4).
    db.prepare('DELETE FROM households WHERE id = ?').run('h1')
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM household_plugins').all()).toEqual([{ cnt: 0 }])
  })

  it('keeps the gate reads and the bootstrap listing on PK-prefix seeks (no scan)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    // The per-request gate read: one indexed seek — the planned §3.6 cost.
    const gatePlan = db
      .prepare(`EXPLAIN QUERY PLAN ${PLUGIN_ENABLEMENT_SQL}`)
      .all('h1', 'documents')
    const gate = gatePlan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(gate).toContain('SEARCH household_plugins')
    expect(gate).not.toMatch(/SCAN|TEMP B-TREE/i)

    // The bootstrap advertisement read: household-prefix seek.
    const listPlan = db.prepare(`EXPLAIN QUERY PLAN ${HOUSEHOLD_ENABLEMENT_ROWS_SQL}`).all('h1')
    const list = listPlan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(list).toContain('SEARCH household_plugins')
    expect(list).not.toMatch(/SCAN|TEMP B-TREE/i)
  })

  it('keeps the full chain green on a fresh database (additive, no backfill)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    const columns = db.prepare('PRAGMA table_info(household_plugins)').all()
    // 0035 appended the purge state machine (ticket 5 #439) after updated_at
    // — ALTER TABLE ADD COLUMN order, never a rebuild (the additive chain).
    expect(columns.map((c: Record<string, unknown>) => c.name)).toEqual([
      'household_id',
      'plugin_id',
      'status',
      'config_json',
      'updated_at',
      'purge_state',
      'purge_cursor',
      'purge_requested_by',
      'purge_requested_at',
      'purge_completed_at',
    ])
    // Phase A ships ZERO rows — the manifest default covers every existing
    // household (no grandfathering backfill, plan §4.3).
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM household_plugins').all()).toEqual([{ cnt: 0 }])
  })
})

// Purge state machine columns (ahaqqu/RumaQ#439 — plugin architecture ticket
// 5, plan §3.4): the CHECK domains are real constraints (a hand-edited row
// must not invent a state), the cursor must be real JSON (a corrupted one
// degrades to a re-read, never to a failed drain), and the nightly work-set
// seek rides the partial index — a scan of the enablement table every night
// would be the wrong shape for a work set that is ~always empty.
describe('migration 0035: plugin purge state (#439)', () => {
  it('enforces the purge state domain and the JSON cursor shape', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    // The 0028 resting shape: no purge state (NULL passes every CHECK).
    db.prepare(
      `INSERT INTO household_plugins (household_id, plugin_id, status) VALUES (?, ?, ?)`
    ).run('h1', 'documents', 'enabled')

    const setCursor = (value: string | null) =>
      db
        .prepare('UPDATE household_plugins SET purge_cursor = ? WHERE household_id = ?')
        .run(value, 'h1')
    // A real cursor (the job's JSON) is fine…
    setCursor(JSON.stringify({ created_at: '2026-11-01 10:00:00', id: 'd1' }))
    // …junk is not — the json_valid CHECK catches it.
    expect(() => setCursor('d1-after-10:00')).toThrow()
    setCursor(null)

    const setState = (value: string) =>
      db
        .prepare('UPDATE household_plugins SET purge_state = ? WHERE household_id = ?')
        .run(value, 'h1')
    for (const legal of ['pending', 'running', 'done']) setState(legal)
    expect(() => setState('paused')).toThrow()
  })

  it('keeps the nightly work-set seek on the partial purging index (no scan)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    // The EXACT statement the tick ships (imported, not transcribed — the
    // C1-B2 verbatim-by-construction discipline from #469): a drift in the
    // work-set query fails this pin instead of passing against a query
    // nothing runs.
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${PURGING_HOUSEHOLDS_SQL}`).all('documents')
    const detail = plan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(detail).toContain('idx_household_plugins_purging')
    expect(detail).not.toMatch(/SCAN|TEMP B-TREE/i)
  })

  it('pins the ticket-5 statement vocabulary (the reads the catalog, gate and initiation run)', () => {
    expect(HOUSEHOLD_CATALOG_ROWS_SQL).toBe(
      'SELECT plugin_id, status, purge_state, purge_requested_at, purge_completed_at FROM household_plugins WHERE household_id = ?'
    )
    expect(PLUGIN_PURGE_STATE_SQL).toBe(
      'SELECT purge_state FROM household_plugins WHERE household_id = ? AND plugin_id = ?'
    )
    expect(PLUGIN_PURGE_ROW_SQL).toBe(
      'SELECT status, purge_state, purge_requested_at, purge_completed_at FROM household_plugins WHERE household_id = ? AND plugin_id = ?'
    )
    // The catalog/enablement advertisement statement is untouched — its own
    // pin lives in plugin-enablement.test.ts; this asserts the ticket-5
    // columns did NOT leak into it.
    expect(HOUSEHOLD_ENABLEMENT_ROWS_SQL).toBe(
      'SELECT plugin_id, status FROM household_plugins WHERE household_id = ?'
    )
  })
})

// Deployment flags (ahaqqu/RumaQ#435, phase A): the ops kill-switch as data
// (§3.3 — a config-file flag is a deploy; an incident lever must not be).
// The reader (plugins/flags.ts) takes the WHOLE tiny table once per isolate
// with a ≤30 s cache and fails OPEN on a read error — the deliberate opposite
// of household enablement, which fails closed. A whole-table read needs no
// lookup index (the table is a handful of rows by design); the interesting
// constraints here are the key PK and the closed value domain.
describe('migration 0029: deployment_flags (#435)', () => {
  it('stores the kill-switch as data: one row per key, on/off value domain', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    const insert = db.prepare(`INSERT INTO deployment_flags (key, value) VALUES (?, ?)`)
    insert.run(deploymentFlagKey('documents'), 'off')
    // PK: one opinion per flag key.
    expect(() => insert.run(deploymentFlagKey('documents'), 'on')).toThrow()
    // The value CHECK is a real constraint.
    expect(() => insert.run(deploymentFlagKey('other'), 'maybe')).toThrow()

    // The reader's key construction and the row shape agree.
    const rows = db.prepare(`SELECT * FROM deployment_flags`).all()
    expect(rows).toEqual([
      expect.objectContaining({ key: 'plugin.documents.available', value: 'off' }),
    ])
    expect(rows[0]).toHaveProperty('updated_at')

    // Flipping the lever is an UPDATE, not a deploy — the whole point (§3.3).
    db.prepare(`UPDATE deployment_flags SET value = 'on' WHERE key = ?`).run(
      deploymentFlagKey('documents')
    )
    expect(
      db
        .prepare(`SELECT value FROM deployment_flags WHERE key = ?`)
        .get(deploymentFlagKey('documents'))
    ).toMatchObject({ value: 'on' })
  })

  it('keeps the full chain green on a fresh database (additive)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    const columns = db.prepare('PRAGMA table_info(deployment_flags)').all()
    expect(columns.map((c: Record<string, unknown>) => c.name)).toEqual([
      'key',
      'value',
      'updated_at',
    ])
  })
})

// Canonical product boundary for pipeline contract v2 (ahaqqu/RumaQ#454): the
// migration is additive, and D1 already holds price rows when it runs, so the
// interesting behavior is on TOP of existing data — the NOT NULL defaults for
// rows that predate the columns, the updated_at backfill, the seeded
// canonical-index counter, and the alias FK that D1 enforces (node:sqlite does
// too, so the cascade assertion is real).
describe('migration 0030: canonical products (#454)', () => {
  it('adds the canonical columns on top of a pre-0030 database with rows', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    db.exec('PRAGMA foreign_keys = ON')
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0030')
    )

    db.prepare(
      `INSERT INTO price_sources (id, slug, name) VALUES ('src-1', 'lotte-mart', 'Lotte Mart')`
    ).run()
    // A row with both timestamps in the legacy shapes a v1 writer produced
    // (ISO, and SQLite's datetime('now')) and a row with neither.
    db.prepare(
      `INSERT INTO price_products (id, product_key, name, category, first_seen_at, last_seen_at)
       VALUES ('prod-1', 'beras--ramos--5-kg', 'Beras Ramos 5kg', 'beras',
               '2026-10-24T23:00:05Z', '2026-10-25 10:00:00')`
    ).run()
    db.prepare(
      `INSERT INTO price_products (id, product_key, name) VALUES ('prod-2', 'gula--gulaku--1-kg', 'Gula')`
    ).run()

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0030_canonical_products.sql'), 'utf8'))

    // Existing rows are provisional, versioned, and keep their category; the
    // backfill copies last_seen_at so updated_at is never NULL afterwards.
    expect(db.prepare("SELECT * FROM price_products WHERE id = 'prod-1'").get()).toMatchObject({
      status: 'provisional',
      metadata_version: 1,
      category: 'beras',
      category_version: null,
      updated_at: '2026-10-25 10:00:00',
    })
    // A row with no timestamps at all falls back to the migration's clock.
    const bare = db.prepare("SELECT * FROM price_products WHERE id = 'prod-2'").get()!
    expect(bare).toMatchObject({ status: 'provisional', metadata_version: 1 })
    expect(bare.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)

    // One seeded counter row — the ingest's `version = version + 1` needs it.
    expect(db.prepare('SELECT * FROM canonical_index_state').all()).toEqual([{ id: 1, version: 0 }])

    // The new domain constraints are real, not documentation.
    expect(() =>
      db
        .prepare(
          `INSERT INTO price_products (id, product_key, name, status)
           VALUES ('prod-3', 'k3', 'N', 'bogus')`
        )
        .run()
    ).toThrow()
    expect(() =>
      db
        .prepare(
          `INSERT INTO price_product_aliases
             (id, product_id, store_slug, name, status, first_seen_at, last_seen_at)
           VALUES ('a1', 'prod-1', 'lotte-mart', 'N', 'bogus', 't', 't')`
        )
        .run()
    ).toThrow()

    // An alias belongs to its product: deleting the product takes it along
    // (a plain REFERENCES would fail here — D1 enforces foreign keys).
    db.prepare(
      `INSERT INTO price_product_aliases
         (id, product_id, store_slug, name, first_seen_at, last_seen_at)
       VALUES ('a2', 'prod-1', 'lotte-mart', 'Beras Ramos', '2026-11-01T00:00:00Z',
               '2026-11-01T00:00:00Z')`
    ).run()
    db.prepare("DELETE FROM price_products WHERE id = 'prod-1'").run()
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM price_product_aliases').get()).toEqual({
      cnt: 0,
    })
  })
})

describe('migration 0031: household calendar (#430)', () => {
  it('keeps the full chain green on a fresh database and applies defaults', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'
          AND name IN ('household_calendar_events', 'household_calendar_event_members',
                       'household_calendar_event_audit') ORDER BY name`
      )
      .all()
    expect(tables.map((r: Record<string, unknown>) => r.name)).toEqual([
      'household_calendar_event_audit',
      'household_calendar_event_members',
      'household_calendar_events',
    ])

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO household_members (id, household_id, user_id, role)
       VALUES ('m1', 'h1', 'u1', 'owner')`
    ).run()

    // The INSERT the lib writes omits event_time/visibility/created_at/
    // updated_at — the DEFAULTs must fill them (visibility defaults to 'all',
    // time to NULL = all-day).
    db.prepare(
      `INSERT INTO household_calendar_events
         (id, household_id, title, event_date, created_by_member_id)
       VALUES ('e1', 'h1', 'Kontrol dokter', '2026-11-15', 'm1')`
    ).run()
    const row = db.prepare('SELECT * FROM household_calendar_events WHERE id = ?').get('e1')
    expect(row).toMatchObject({
      event_date: '2026-11-15',
      event_time: null,
      visibility: 'all',
      created_by_member_id: 'm1',
    })
    expect(String(row?.created_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(String(row?.updated_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('enforces the CHECK constraints (visibility, audit action) as the backstop', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO household_members (id, household_id, user_id, role)
       VALUES ('m1', 'h1', 'u1', 'owner')`
    ).run()

    expect(() =>
      db
        .prepare(
          `INSERT INTO household_calendar_events
             (id, household_id, title, event_date, visibility)
           VALUES ('e1', 'h1', 'Bogus', '2026-11-15', 'family')`
        )
        .run()
    ).toThrow()
    expect(() =>
      db
        .prepare(
          `INSERT INTO household_calendar_event_audit
             (id, event_id, household_id, actor_user_id, action)
           VALUES ('a1', 'e1', 'h1', 'u1', 'rsvp')`
        )
        .run()
    ).toThrow()
    // The audience table's composite PK refuses duplicate grants.
    db.prepare(
      `INSERT INTO household_calendar_events
         (id, household_id, title, event_date, visibility)
       VALUES ('e1', 'h1', 'Ok', '2026-11-15', 'members')`
    ).run()
    db.prepare(
      `INSERT INTO household_calendar_event_members (event_id, member_id) VALUES ('e1', 'm1')`
    ).run()
    expect(() =>
      db
        .prepare(
          `INSERT INTO household_calendar_event_members (event_id, member_id) VALUES ('e1', 'm1')`
        )
        .run()
    ).toThrow()
  })

  it('cascades the household delete, drops audience rows with their event, SET NULLs the creator, and lets the audit outlive the event', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO household_members (id, household_id, user_id, role, display_name)
       VALUES ('m1', 'h1', 'u1', 'owner', 'Ibu')`
    ).run()
    db.prepare(
      `INSERT INTO household_members (id, household_id, user_id, role, display_name)
       VALUES ('m2', 'h1', NULL, 'member', 'Adik')`
    ).run()
    db.prepare(
      `INSERT INTO household_calendar_events
         (id, household_id, title, event_date, visibility, created_by_member_id)
       VALUES ('e1', 'h1', 'Imunisasi', '2026-11-15', 'members', 'm1')`
    ).run()
    db.prepare(
      `INSERT INTO household_calendar_event_members (event_id, member_id) VALUES ('e1', 'm2')`
    ).run()
    db.prepare(
      `INSERT INTO household_calendar_event_audit (id, event_id, household_id, actor_user_id, action)
       VALUES ('a1', 'e1', 'h1', 'u1', 'create')`
    ).run()

    // Removing a listed member drops ONLY their visibility grant — the event
    // stays (it degrades to creator-only in the read model).
    db.prepare('DELETE FROM household_members WHERE id = ?').run('m2')
    expect(
      (
        db.prepare('SELECT COUNT(*) AS cnt FROM household_calendar_event_members').get() as {
          cnt: number
        }
      ).cnt
    ).toBe(0)
    expect(
      db.prepare('SELECT * FROM household_calendar_events WHERE id = ?').get('e1')
    ).not.toBeUndefined()

    // Removing the creator keeps the event; provenance falls to NULL and
    // authorization falls to the owners (lib/calendar.ts).
    db.prepare('DELETE FROM household_members WHERE id = ?').run('m1')
    expect(
      db.prepare('SELECT * FROM household_calendar_events WHERE id = ?').get('e1')
    ).toMatchObject({ created_by_member_id: null })

    // The event delete cascades NOTHING from the audit: event_id is a plain
    // TEXT handle — the deletion record must outlive the row it names. But the
    // (already-cascaded) audience table would have followed the event.
    db.prepare('DELETE FROM household_calendar_events WHERE id = ?').run('e1')
    const audit = db
      .prepare('SELECT action FROM household_calendar_event_audit WHERE event_id = ?')
      .all('e1')
    expect(audit.map((r: Record<string, unknown>) => r.action)).toEqual(['create'])
  })

  it('keeps the month listing on the shipped SQL: index seek, no scan, sort as an explicit temp B-tree', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    // The EXACT shipped statement (lib/calendar.ts listCalendarEntries, the
    // windowed variant): household + visibility + date range. The projection
    // and the visibility predicate are IMPORTED from the lib — verbatim by
    // construction, so a predicate edit re-proves the plan instead of leaving
    // this pin EXPLAINing a stale copy (ahaqqu/RumaQ#445 thermos B1, the
    // #434-B4 precedent).
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN ${EVENT_SELECT}
        WHERE e.household_id = ? AND ${VISIBLE_PREDICATE}
          AND e.event_date >= ? AND e.event_date <= ?
        ORDER BY e.event_date, e.event_time, e.created_at, e.id`
      )
      .all('h1', 'm1', 'm1', 'm1', '2026-11-01', '2026-11-30')
    const detail = plan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(detail).toContain('idx_household_calendar_events_household')
    expect(detail).not.toMatch(/\bSCAN\b/)
    // The event_time/created_at/id tiebreakers go beyond the index's two
    // columns, so the day-chronological sort is a TEMP B-TREE — asserted
    // EXPLICITLY rather than denied (the 0027 discipline): at household scale
    // (tens of entries per month) the sort is harmless, and an honest pin
    // makes any future plan change a conscious diff.
    // SQLite satisfies only the leading event_date term from the index; the
    // remaining three ORDER BY terms sort via 'USE TEMP B-TREE FOR LAST 3
    // TERMS OF ORDER BY'.
    expect(detail).toContain('TEMP B-TREE FOR LAST 3 TERMS OF ORDER BY')

    // The unbounded variant (no window) seeks the same index.
    const openPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN ${EVENT_SELECT}
        WHERE e.household_id = ? AND ${VISIBLE_PREDICATE}
        ORDER BY e.event_date, e.event_time, e.created_at, e.id`
      )
      .all('h1', 'm1', 'm1', 'm1')
    expect(openPlan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')).toContain(
      'idx_household_calendar_events_household'
    )

    // The deadline derivation rides the 0026 expiry index (household +
    // expires_on) — the derive-on-read view costs one seek per read.
    const docsPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id, name, member_id, expires_on, remind_days_before
           FROM documents
          WHERE household_id = ? AND expires_on IS NOT NULL
            AND expires_on >= ? AND expires_on <= ?
          ORDER BY expires_on, id`
      )
      .all('h1', '2026-11-01', '2026-11-30')
    const docsDetail = docsPlan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(docsDetail).toContain('idx_documents_household_expiry')
    expect(docsDetail).not.toMatch(/\bSCAN\b/)

    // The audit lookups (per event, per household) seek too — the 0022/0027
    // index pair.
    const auditPlan = db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM household_calendar_event_audit WHERE event_id = ? ORDER BY created_at'
      )
      .all('e1')
    expect(auditPlan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')).toContain(
      'idx_household_calendar_event_audit_event'
    )
    const householdAuditPlan = db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM household_calendar_event_audit WHERE household_id = ? ORDER BY created_at'
      )
      .all('h1')
    expect(
      householdAuditPlan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    ).toContain('idx_household_calendar_event_audit_household')
  })
})

// Plugin lifecycle audit (ahaqqu/RumaQ#437, ticket 3): the core-owned
// receipt table for plugin_enabled / plugin_disabled (ticket 5 adds
// plugin_purged — the CHECK already admits it, because widening a CHECK
// would need a table rebuild and the event vocabulary is fixed by plan
// §3.4). The household handle is deliberately FK-less: an audit row is a
// receipt, not a child — deleting the household must not erase the record
// that a plugin was toggled (the exact opposite of household_plugins, whose
// rows cascade away).
describe('migration 0032: household_plugin_audit (#437)', () => {
  it('accepts the plan lifecycle vocabulary and rejects anything else', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    const insert = db.prepare(
      `INSERT INTO household_plugin_audit (id, household_id, plugin_id, actor_user_id, action)
       VALUES (?, ?, ?, ?, ?)`
    )
    insert.run('a1', 'h1', 'documents', 'u1', 'plugin_enabled')
    insert.run('a2', 'h1', 'documents', 'u1', 'plugin_disabled')
    // Ticket 5's completion receipt is representable from day one.
    insert.run('a3', 'h1', 'documents', null, 'plugin_purged')
    // The closed action domain: a bare status word or junk is not an event.
    expect(() => insert.run('a4', 'h1', 'documents', 'u1', 'enabled')).toThrow()

    // The system-actor row (a purge job, ticket 5) is representable —
    // actor_user_id is a plain nullable handle, no FK.
    const row = db.prepare(`SELECT * FROM household_plugin_audit WHERE id = 'a3'`).get()
    expect(row).toMatchObject({ household_id: 'h1', plugin_id: 'documents', actor_user_id: null })
  })

  it('keeps the receipt when the household is deleted (plain handles, no FK)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    db.prepare(
      `INSERT INTO household_plugin_audit (id, household_id, plugin_id, actor_user_id, action)
       VALUES ('a1', 'h1', 'documents', 'u1', 'plugin_disabled')`
    ).run()

    // household_plugins cascades (0028); the receipt does NOT — the audit is
    // not a child of the household (plan §3.4).
    db.prepare('DELETE FROM households WHERE id = ?').run('h1')
    expect(db.prepare(`SELECT COUNT(*) AS cnt FROM household_plugin_audit`).all()).toEqual([
      { cnt: 1 },
    ])
  })

  it('keeps the lifecycle feed on an indexed seek (no scan)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT plugin_id, action, created_at
           FROM household_plugin_audit
          WHERE household_id = ?
          ORDER BY created_at`
      )
      .all('h1')
    const detail = plan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(detail).toContain('idx_household_plugin_audit_household')
    expect(detail).not.toMatch(/SCAN|TEMP B-TREE/i)
  })
})

// Canonical product rename audit (ahaqqu/RumaQ#423, PR A of A/B/C): the
// append-only receipt for admin renames — plain handles, no FK (the 0027/0032
// pattern) — plus the two NOCASE expression indexes the duplicate-name guard
// seeks. The interesting behaviors are the DEFAULTs the batch INSERT omits,
// the closed action vocabulary, the receipt outliving the product it names,
// and the fact that a collation index only answers a matching collation.
describe('migration 0037: price_product_audit (#423)', () => {
  // The migration is additive and D1 already holds price rows when it runs
  // (the 0030/0031 shape), so the case applies 0037 on TOP of the chain
  // rather than on a fresh database.
  function preAuditDb(): Db {
    const db = new DatabaseSync(':memory:') as unknown as Db
    // D1 enforces foreign keys; node:sqlite must too for the cascade
    // assertion below to mean anything.
    db.exec('PRAGMA foreign_keys = ON')
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0037')
    )
    return db
  }

  function apply0037(db: Db): void {
    db.exec(readFileSync(join(MIGRATIONS_DIR, '0037_price_product_audit.sql'), 'utf8'))
  }

  // The row the rename batch writes: every column except the DEFAULTed
  // created_at, with a NULL reason on most renames. action is a parameter so
  // the CHECK test reuses the same statement.
  function insertReceipt(db: Db, id: string, action = 'rename'): void {
    db.prepare(
      `INSERT INTO price_product_audit
         (id, product_id, product_key, actor_user_id, action, old_name, new_name,
          metadata_version_before, metadata_version_after)
       VALUES (?, 'prod-1', 'beras--ramos--5-kg', 'u1', ?,
               'Beras Ramos 5kg', 'Beras Ramos Premium', 1, 2)`
    ).run(id, action)
  }

  it('adds the table on top of the existing chain and fills the INSERT defaults', () => {
    const db = preAuditDb()
    // Nothing of this file exists beforehand — the shape assertions below
    // must not be satisfied by another migration.
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE name IN ('price_product_audit', 'idx_price_product_audit_product',
                           'idx_products_name_nocase', 'idx_aliases_name_nocase')`
        )
        .all()
    ).toEqual([])

    apply0037(db)

    // The column order and NOT NULL surface the batch INSERT writes against.
    // id is declared NOT NULL explicitly: on a rowid table a TEXT PRIMARY KEY
    // does not imply it (the 0021 note).
    const columns = db.prepare('PRAGMA table_info(price_product_audit)').all()
    expect(columns.map((c: Record<string, unknown>) => c.name)).toEqual([
      'id',
      'product_id',
      'product_key',
      'actor_user_id',
      'action',
      'old_name',
      'new_name',
      'reason',
      'metadata_version_before',
      'metadata_version_after',
      'reverts_audit_id',
      'created_at',
    ])
    const notNull = Object.fromEntries(
      columns.map((c: Record<string, unknown>): [string, unknown] => [String(c.name), c.notnull])
    )
    expect(notNull).toMatchObject({
      id: 1,
      product_id: 1,
      product_key: 1,
      actor_user_id: 1,
      action: 1,
      old_name: 1,
      new_name: 1,
      metadata_version_before: 1,
      metadata_version_after: 1,
      reason: 0,
      reverts_audit_id: 0,
      created_at: 1,
    })

    insertReceipt(db, 'aud-1')
    const row = db.prepare(`SELECT * FROM price_product_audit WHERE id = 'aud-1'`).get()
    expect(row).toMatchObject({
      product_id: 'prod-1',
      product_key: 'beras--ramos--5-kg',
      actor_user_id: 'u1',
      action: 'rename',
      old_name: 'Beras Ramos 5kg',
      new_name: 'Beras Ramos Premium',
      reason: null,
      reverts_audit_id: null,
    })
    expect(String(row?.created_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

    // A revert is its own appended receipt, naming the rename it compensates.
    // Plain TEXT, so there is no FK ordering to satisfy and no dangling
    // reference can block pruning an old receipt.
    db.prepare(
      `INSERT INTO price_product_audit
         (id, product_id, product_key, actor_user_id, action, old_name, new_name, reason,
          metadata_version_before, metadata_version_after, reverts_audit_id)
       VALUES ('aud-2', 'prod-1', 'beras--ramos--5-kg', 'u1', 'revert',
               'Beras Ramos Premium', 'Beras Ramos 5kg', 'Undo the rename', 2, 3, 'aud-1')`
    ).run()
    expect(db.prepare(`SELECT * FROM price_product_audit WHERE id = 'aud-2'`).get()).toMatchObject({
      action: 'revert',
      reason: 'Undo the rename',
      reverts_audit_id: 'aud-1',
      metadata_version_before: 2,
      metadata_version_after: 3,
    })
  })

  it('rejects any action outside the rename/revert vocabulary', () => {
    const db = preAuditDb()
    apply0037(db)

    insertReceipt(db, 'aud-rename')
    // The closed domain (the 0001/0027 CHECK pattern): a rename trail only
    // ever appends the edit or its compensation — no 'create'/'delete'/'undo'
    // event, and the vocabulary is case-sensitive.
    for (const bogus of ['create', 'delete', 'renamed', 'RENAME']) {
      expect(() => insertReceipt(db, `aud-${bogus}`, bogus)).toThrow()
    }
    expect(db.prepare('SELECT action FROM price_product_audit').all()).toEqual([
      { action: 'rename' },
    ])
  })

  it('seeks the duplicate-name lookups on the NOCASE expression indexes', () => {
    const db = preAuditDb()
    apply0037(db)

    // The guard's exact shape: bind the candidate name and force the NOCASE
    // comparison. Collation is part of the index, so the plain `name = ?`
    // (BINARY) form cannot use it — the statement and the index have to
    // agree, which is why this plan is pinned rather than assumed.
    const planFor = (sql: string) =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all('Beras Ramos 5kg')
        .map((r: Record<string, unknown>) => String(r.detail))
        .join(' | ')

    const products = planFor('SELECT id FROM price_products WHERE name = ? COLLATE NOCASE')
    expect(products).toContain('USING INDEX idx_products_name_nocase')
    expect(products).not.toMatch(/SCAN price_products/i)

    const aliases = planFor('SELECT id FROM price_product_aliases WHERE name = ? COLLATE NOCASE')
    expect(aliases).toContain('USING INDEX idx_aliases_name_nocase')
    expect(aliases).not.toMatch(/SCAN price_product_aliases/i)

    // The index is only half the contract — it must also answer the question
    // case-insensitively, which is what makes it duplicate DETECTION.
    db.prepare(
      `INSERT INTO price_products (id, product_key, name)
       VALUES ('prod-1', 'beras--ramos--5-kg', 'Beras Ramos 5kg')`
    ).run()
    db.prepare(
      `INSERT INTO price_product_aliases
         (id, product_id, store_slug, name, first_seen_at, last_seen_at)
       VALUES ('al-1', 'prod-1', 'lotte-mart', 'Beras Ramos', '2026-11-01T00:00:00Z',
               '2026-11-01T00:00:00Z')`
    ).run()
    expect(
      db
        .prepare('SELECT id FROM price_products WHERE name = ? COLLATE NOCASE')
        .all('BERAS ramos 5KG')
    ).toEqual([{ id: 'prod-1' }])
    expect(
      db
        .prepare('SELECT id FROM price_product_aliases WHERE name = ? COLLATE NOCASE')
        .all('beras RAMOS')
    ).toEqual([{ id: 'al-1' }])
  })

  it('keeps the per-product history read on the audit index (no scan, no sort)', () => {
    const db = preAuditDb()
    apply0037(db)

    // The admin detail surface's exact statement (PR B): one product's
    // receipts, newest first, bounded. The (product_id, created_at) pair lets
    // SQLite walk that product's range backwards — a scan or a temp B-tree
    // here would mean the index is not doing its one job.
    const detail = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM price_product_audit
          WHERE product_id = ?
          ORDER BY created_at DESC
          LIMIT 10`
      )
      .all('prod-1')
      .map((r: Record<string, unknown>) => String(r.detail))
      .join(' | ')
    expect(detail).toContain('USING INDEX idx_price_product_audit_product')
    expect(detail).not.toMatch(/SCAN|TEMP B-TREE/i)
  })

  it('keeps the receipt when the product row is deleted (plain handles, no FK)', () => {
    const db = preAuditDb()
    apply0037(db)

    db.prepare(
      `INSERT INTO price_products (id, product_key, name)
       VALUES ('prod-1', 'beras--ramos--5-kg', 'Beras Ramos 5kg')`
    ).run()
    // The alias is data about the product and cascades (0030); the receipt is
    // a fact about the catalog and must not — the 0027/0032 distinction.
    db.prepare(
      `INSERT INTO price_product_aliases
         (id, product_id, store_slug, name, first_seen_at, last_seen_at)
       VALUES ('al-1', 'prod-1', 'lotte-mart', 'Beras Ramos', '2026-11-01T00:00:00Z',
               '2026-11-01T00:00:00Z')`
    ).run()
    insertReceipt(db, 'aud-1')

    // FK enforcement is ON: the delete itself must succeed (no FK points at
    // price_products from the audit table) and take only the alias with it.
    db.prepare(`DELETE FROM price_products WHERE id = 'prod-1'`).run()
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM price_products').get()).toEqual({ cnt: 0 })
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM price_product_aliases').get()).toEqual({
      cnt: 0,
    })
    expect(db.prepare('SELECT * FROM price_product_audit').all()).toEqual([
      expect.objectContaining({
        id: 'aud-1',
        product_id: 'prod-1',
        product_key: 'beras--ramos--5-kg',
        action: 'rename',
        old_name: 'Beras Ramos 5kg',
        new_name: 'Beras Ramos Premium',
      }),
    ])
  })
})

// The enablement writer's in-batch receipt guard (lib/plugins.ts
// AUDIT_INSERT_SQL, S1-A2's sibling finding S1-A4 from the PR #470 review):
// two concurrent identical toggles both pass the outside idempotency read —
// D1 serializes the batch, not the surrounding read — so the guard is the
// only thing standing between one transition and a doubled receipt. That is
// SQL semantics, so it is pinned here against a real SQLite engine, not the
// route tests' fake D1 (whose batch just logs).
describe('setPluginEnablement audit guard (lib/plugins.ts, #437)', () => {
  // documents' manifest default is enabled — the vocabulary the guard's
  // absent-row branch binds.
  function seededDb(): Db {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()
    return db
  }

  // The exact batch setPluginEnablement runs — the GUARDED receipt first
  // (it must read the row pre-upsert), then the upsert — inside one
  // transaction, matching D1's batch atomicity.
  function runToggleBatch(db: Db, status: 'enabled' | 'disabled', receiptId: string): void {
    db.exec('BEGIN')
    db.prepare(AUDIT_INSERT_SQL).run(
      receiptId,
      'h1',
      'documents',
      'u1',
      status === 'enabled' ? 'plugin_enabled' : 'plugin_disabled',
      'h1',
      'documents',
      'enabled',
      status
    )
    db.prepare(ENABLEMENT_UPSERT_SQL).run('h1', 'documents', status)
    db.exec('COMMIT')
  }

  const receiptCount = (db: Db) =>
    (
      db.prepare(`SELECT COUNT(*) AS cnt FROM household_plugin_audit`).all() as Array<{
        cnt: number
      }>
    )[0].cnt

  it('writes the receipt for a real transition (absent row resolves to the default)', () => {
    // The common first-disable path: no household_plugins row yet, the
    // manifest default ('enabled') is the resolved state — the guard's
    // COALESCE default branch must let the receipt through.
    const db = seededDb()
    runToggleBatch(db, 'disabled', 'a1')
    expect(receiptCount(db)).toBe(1)
    expect(
      db
        .prepare(
          `SELECT status FROM household_plugins WHERE household_id = 'h1' AND plugin_id = 'documents'`
        )
        .get()
    ).toEqual({ status: 'disabled' })
  })

  it('skips the receipt when a concurrent identical toggle already committed', () => {
    const db = seededDb()
    // The race winner: absent row, disable → receipt + row 'disabled'.
    runToggleBatch(db, 'disabled', 'a1')
    // The duplicate: its outside read happened BEFORE the commit (it also
    // saw an absent row), but its batch runs after — the guard must see the
    // committed row and skip the receipt; the upsert re-lands the same value.
    runToggleBatch(db, 'disabled', 'a2')
    expect(receiptCount(db)).toBe(1)
    expect(db.prepare('SELECT id FROM household_plugin_audit').get()).toEqual({ id: 'a1' })
  })

  it('still audits a real transition when a committed row states the opposite', () => {
    const db = seededDb()
    runToggleBatch(db, 'disabled', 'a1')
    runToggleBatch(db, 'enabled', 'a2')
    expect(db.prepare('SELECT id, action FROM household_plugin_audit ORDER BY id').all()).toEqual([
      { id: 'a1', action: 'plugin_disabled' },
      { id: 'a2', action: 'plugin_enabled' },
    ])
  })
})

// The cron driver's enabled-set reads (ticket 7, #441 — lib/plugin-cron.ts
// resolves each household-scoped task's set through plugins/enablement.ts).
// Both statements are pinned here because the nightly invocation's cost is
// part of their contract:
//
//   - the default-ON statement scans households (bounded by design —
//     household-scale table, nightly cadence, the #426 expiry sweep's own
//     rationale) with the NOT EXISTS probe riding the household_plugins
//     composite PK's (household_id, plugin_id) prefix per row;
//   - the default-OFF statement scans household_plugins (bounded by design —
//     one row per expressed household choice, §3.2; no dedicated index is
//     added for this cold nightly read, the 0035 header's own tradeoff).
//
// Neither may grow a TEMP B-TREE: there is nothing to sort.
describe('migration 0028 chain: the cron driver enabled-set reads (#441)', () => {
  it('the default-ON statement probes the enablement PK per household (no sort)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${HOUSEHOLDS_ENABLED_BY_DEFAULT_SQL}`)
      .all('documents')
    const detail = plan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    // The households scan is the designed shape (bounded, nightly) — pinned,
    // not hidden, so a silent change to either side is noticed.
    expect(detail).toContain('SCAN households')
    expect(detail).toContain(
      'SEARCH household_plugins USING INDEX sqlite_autoindex_household_plugins_1'
    )
    expect(detail).not.toMatch(/TEMP B-TREE/i)
  })

  it('the default-OFF statement scans the enablement rows (no sort, no new index)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${HOUSEHOLDS_ENABLED_EXPLICIT_SQL}`)
      .all('documents')
    const detail = plan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(detail).toContain('SCAN household_plugins')
    expect(detail).not.toMatch(/TEMP B-TREE/i)
  })

  it('answers the driver with real rows per the §4.3 truth table', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(`INSERT INTO households (id, name, created_by) VALUES ('h1', 'A', 'u1')`).run()
    db.prepare(`INSERT INTO households (id, name, created_by) VALUES ('h2', 'B', 'u1')`).run()
    const row = db.prepare(
      'INSERT INTO household_plugins (household_id, plugin_id, status) VALUES (?, ?, ?)'
    )
    row.run('h1', 'on-plugin', 'disabled')
    row.run('h1', 'off-plugin', 'enabled')

    // default ON: the explicit disabled row wins for h1, h2 rides the default.
    expect(db.prepare(HOUSEHOLDS_ENABLED_BY_DEFAULT_SQL).all('on-plugin')).toEqual([
      { household_id: 'h2' },
    ])
    // default OFF: only the explicit enabled rows answer.
    expect(db.prepare(HOUSEHOLDS_ENABLED_EXPLICIT_SQL).all('off-plugin')).toEqual([
      { household_id: 'h1' },
    ])
  })
})
