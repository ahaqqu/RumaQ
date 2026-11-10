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
// append-only receipt for admin renames — plain handles, no FK (the 0032
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

  it('rejects a second compensation for the same rename (partial unique index)', () => {
    const db = preAuditDb()
    apply0037(db)

    // Every rename carries a NULL reverts_audit_id, so the partial index never
    // sees them — any number of renames coexist.
    insertReceipt(db, 'aud-rename-1')
    insertReceipt(db, 'aud-rename-2')
    insertReceipt(db, 'aud-rename-3')

    const compensate = (id: string, target: string) =>
      db
        .prepare(
          `INSERT INTO price_product_audit
             (id, product_id, product_key, actor_user_id, action, old_name, new_name,
              metadata_version_before, metadata_version_after, reverts_audit_id)
           VALUES (?, 'prod-1', 'beras--ramos--5-kg', 'u1', 'revert', 'Beras Ramos Premium',
                   'Beras Ramos 5kg', 2, 3, ?)`
        )
        .run(id, target)

    // Two different renames are each revertable once.
    compensate('aud-revert-1', 'aud-rename-1')
    compensate('aud-revert-2', 'aud-rename-2')
    // The same rename is not: the route's expectedMetadataVersion CAS stays the
    // primary guard, and the partial unique index is the storage-level backstop
    // for any writer that forgets it.
    expect(() => compensate('aud-revert-1b', 'aud-rename-1')).toThrow()

    expect(
      db.prepare(`SELECT id FROM price_product_audit WHERE action = 'revert' ORDER BY id`).all()
    ).toEqual([{ id: 'aud-revert-1' }, { id: 'aud-revert-2' }])
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
    // a fact about the catalog and must not — the 0030/0032 distinction.
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

// Admin candidate-alias decisions (ahaqqu/RumaQ#489, PR 1 of 2): the appended
// decision receipt — plain handles, no FK (the 0032/0037 pattern) — and the
// status-vocabulary widening a rejection needs. The interesting behaviors are
// that the rebuild keeps every alias row and every index, that 'rejected' is a
// legal terminal status now, that the closed action vocabulary holds, and that
// the receipt outlives the alias it names.
describe('migration 0039: price_product_alias_audit + rejected alias status (#489)', () => {
  // The migration is additive and D1 already holds aliases when it runs, so
  // the case applies 0039 on TOP of the chain rather than on a fresh database.
  function preAliasAuditDb(): Db {
    const db = new DatabaseSync(':memory:') as unknown as Db
    // D1 enforces foreign keys; node:sqlite must too for the cascade
    // assertion below to mean anything.
    db.exec('PRAGMA foreign_keys = ON')
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0039')
    )
    return db
  }

  function apply0039(db: Db): void {
    db.exec(readFileSync(join(MIGRATIONS_DIR, '0039_price_alias_audit.sql'), 'utf8'))
  }

  function seedAliases(db: Db): void {
    db.prepare(
      `INSERT INTO price_products (id, product_key, name)
       VALUES ('prod-1', 'beras--ramos--5-kg', 'Beras Ramos 5 kg')`
    ).run()
    db.prepare(
      `INSERT INTO price_product_aliases
         (id, product_id, store_slug, name, status, source, first_seen_at, last_seen_at)
       VALUES ('al-candidate', 'prod-1', 'superindo', 'Beras Ramos', 'candidate', 'ocr',
               '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')`
    ).run()
    db.prepare(
      `INSERT INTO price_product_aliases
         (id, product_id, store_slug, name, status, source, first_seen_at, last_seen_at)
       VALUES ('al-approved', 'prod-1', 'lotte-mart', 'Beras Ramos 5kg', 'approved', 'admin',
               '2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z')`
    ).run()
  }

  it('rebuilds the alias table around the widened status CHECK, copying every row and index', () => {
    const db = preAliasAuditDb()
    seedAliases(db)

    apply0039(db)

    // Nothing of this file existed beforehand; the rebuild must not leave the
    // old definition in place (a CHECK that still lacks 'rejected' would make
    // the CAS below fail in production while every route test passes).
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE name IN ('price_product_alias_audit', 'idx_price_product_alias_audit_product',
                           'idx_aliases_product_status', 'idx_aliases_store_name',
                           'idx_aliases_name_nocase')`
        )
        .all()
        .map((row: Record<string, unknown>) => row.name)
        .sort()
    ).toEqual([
      'idx_aliases_name_nocase',
      'idx_aliases_product_status',
      'idx_aliases_store_name',
      'idx_price_product_alias_audit_product',
      'price_product_alias_audit',
    ])

    // Every pre-existing row survives verbatim, including the UNIQUE key
    // columns and the per-store provenance.
    expect(
      db
        .prepare(
          `SELECT id, product_id, store_slug, name, status, source, first_seen_at, last_seen_at
           FROM price_product_aliases ORDER BY id`
        )
        .all()
    ).toEqual([
      {
        id: 'al-approved',
        product_id: 'prod-1',
        store_slug: 'lotte-mart',
        name: 'Beras Ramos 5kg',
        status: 'approved',
        source: 'admin',
        first_seen_at: '2026-11-01T00:00:00Z',
        last_seen_at: '2026-11-03T00:00:00Z',
      },
      {
        id: 'al-candidate',
        product_id: 'prod-1',
        store_slug: 'superindo',
        name: 'Beras Ramos',
        status: 'candidate',
        source: 'ocr',
        first_seen_at: '2026-11-01T00:00:00Z',
        last_seen_at: '2026-11-02T00:00:00Z',
      },
    ])

    // 'rejected' is now legal; the old vocabulary is unchanged and anything
    // else is still refused.
    db.prepare(
      `UPDATE price_product_aliases SET status = 'rejected' WHERE id = 'al-candidate'`
    ).run()
    expect(
      db.prepare(`SELECT status FROM price_product_aliases WHERE id = 'al-candidate'`).get()
    ).toEqual({ status: 'rejected' })
    for (const bogus of ['deleted', 'APPROVED', 'approved ']) {
      expect(() =>
        db
          .prepare(`UPDATE price_product_aliases SET status = ? WHERE id = 'al-approved'`)
          .run(bogus)
      ).toThrow()
    }

    // The UNIQUE(product_id, store_slug, name) constraint and the CASCADE FK
    // survive the rebuild.
    expect(() =>
      db
        .prepare(
          `INSERT INTO price_product_aliases
             (id, product_id, store_slug, name, status, source, first_seen_at, last_seen_at)
           VALUES ('dup', 'prod-1', 'lotte-mart', 'Beras Ramos 5kg', 'candidate', 'ocr',
                   '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`
        )
        .run()
    ).toThrow()
    db.prepare(`DELETE FROM price_products WHERE id = 'prod-1'`).run()
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM price_product_aliases').get()).toEqual({
      cnt: 0,
    })
  })

  // The rebuilt table's read shapes, as plans rather than index NAMES: a
  // CREATE INDEX recreated with the right name but the wrong columns passes a
  // sqlite_master lookup and silently turns every read into a scan (the 0039
  // review probe: the product-status index moved to (store_slug, status) and
  // this suite stayed green), so each index is pinned by the query it serves.
  function aliasPlan(db: Db, sql: string, ...params: unknown[]): string {
    return db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row: Record<string, unknown>) => String(row.detail))
      .join(' | ')
  }

  it('recreates all three alias indexes so their reads seek, not scan', () => {
    const db = preAliasAuditDb()
    seedAliases(db)
    apply0039(db)

    // The rename guard's exact shape (0037's pin): the rebuilt table must keep
    // answering a NOCASE seek, not fall back to a scan.
    const nocase = aliasPlan(
      db,
      `SELECT id FROM price_product_aliases WHERE name = ? COLLATE NOCASE`,
      'beras ramos'
    )
    expect(nocase).toContain('USING INDEX idx_aliases_name_nocase')
    expect(nocase).not.toMatch(/SCAN price_product_aliases/i)
    expect(
      db
        .prepare('SELECT id FROM price_product_aliases WHERE name = ? COLLATE NOCASE')
        .all('BERAS ramos')
    ).toEqual([{ id: 'al-candidate' }])

    // The product detail read (aliases of one product) and the ingest/rename
    // store+name lookup: both indexes must survive with the columns 0030 gave
    // them, not merely with their names.
    const byProductStatus = aliasPlan(
      db,
      `SELECT id FROM price_product_aliases WHERE product_id = ? AND status = ?`,
      'prod-1',
      'candidate'
    )
    expect(byProductStatus).toContain('USING INDEX idx_aliases_product_status')
    expect(byProductStatus).not.toMatch(/SCAN price_product_aliases/i)
    const byStoreName = aliasPlan(
      db,
      `SELECT id FROM price_product_aliases WHERE store_slug = ? AND name = ?`,
      'superindo',
      'Beras Ramos'
    )
    expect(byStoreName).toContain('USING INDEX idx_aliases_store_name')
    expect(byStoreName).not.toMatch(/SCAN price_product_aliases/i)

    // The rebuild DROPs the alias table, so any object that referenced it by
    // name (a view, a trigger) would either break the migration or survive
    // pointing at nothing; D1 has no way to recreate it from the file.
    expect(
      db
        .prepare(
          `SELECT type, name FROM sqlite_master
            WHERE type IN ('view', 'trigger') AND sql LIKE '%price_product_aliases%'`
        )
        .all()
    ).toEqual([])
  })

  it('fills the receipt defaults and rejects any action outside approve/reject', () => {
    const db = preAliasAuditDb()
    apply0039(db)

    const insert = db.prepare(
      `INSERT INTO price_product_alias_audit
         (id, alias_id, product_id, product_key, store_slug, alias_name, action, actor_user_id)
       VALUES (?, 'al-1', 'prod-1', 'beras--ramos--5-kg', 'superindo', 'Beras Ramos', ?, 'u1')`
    )
    insert.run('rec-approve', 'approve')
    insert.run('rec-reject', 'reject')
    for (const bogus of ['approve_alias', 'remove', 'APPROVE']) {
      expect(() => insert.run(`rec-${bogus}`, bogus)).toThrow()
    }

    const rows = db.prepare('SELECT * FROM price_product_alias_audit ORDER BY id').all()
    expect(rows.map((row: Record<string, unknown>) => row.action)).toEqual(['approve', 'reject'])
    expect(String(rows[0]?.created_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('seeks the per-product receipt feed on its index (no scan, no sort)', () => {
    const db = preAliasAuditDb()
    apply0039(db)

    // The admin detail surface's exact read shape for a future alias history:
    // one product's receipts newest-first, bounded.
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM price_product_alias_audit
          WHERE product_id = ?
          ORDER BY created_at DESC
          LIMIT 10`
      )
      .all('prod-1')
      .map((row: Record<string, unknown>) => String(row.detail))
      .join(' | ')
    expect(plan).toContain('USING INDEX idx_price_product_alias_audit_product')
    expect(plan).not.toMatch(/SCAN|TEMP B-TREE/i)
  })

  it('keeps the receipt when the alias and its product are deleted (plain handles, no FK)', () => {
    const db = preAliasAuditDb()
    seedAliases(db)
    apply0039(db)
    db.prepare(
      `INSERT INTO price_product_alias_audit
         (id, alias_id, product_id, product_key, store_slug, alias_name, action, actor_user_id)
       VALUES ('rec-1', 'al-candidate', 'prod-1', 'beras--ramos--5-kg', 'superindo',
               'Beras Ramos', 'reject', 'u1')`
    ).run()

    // The aliases cascade with their product (0030); the decision receipt is a
    // fact about the catalog and must not — the 0030/0032 distinction.
    db.prepare(`DELETE FROM price_products WHERE id = 'prod-1'`).run()
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM price_product_aliases').get()).toEqual({
      cnt: 0,
    })
    expect(db.prepare('SELECT * FROM price_product_alias_audit').all()).toEqual([
      expect.objectContaining({
        id: 'rec-1',
        alias_id: 'al-candidate',
        product_id: 'prod-1',
        product_key: 'beras--ramos--5-kg',
        store_slug: 'superindo',
        alias_name: 'Beras Ramos',
        action: 'reject',
        actor_user_id: 'u1',
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

// Vision-model setting (ahaqqu/RumaQ#433): the nullable ai_vision_model add
// on user_settings — the vault's OCR resolves it ahead of ai_model. Pure
// additivity (the 0008 ai_model shape), numbered 0033: origin/main shipped
// 0030 (#454 canonical products), 0031 (#430 calendar) and 0032 (#437 plugin
// audit) after this branch forked, and 0035/0036 were reserved for the later
// plugin work — 0033/0034 are this PR's slots (wrangler keys the applied set
// on the filename, so a number is claimed exactly once).
describe('migration 0033: user_settings.ai_vision_model (#433)', () => {
  it('adds the nullable vision-model column on top of the pre-0033 schema; old rows stay null', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0033')
    )

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    // The pre-#433 settings row (the INSERT the settings bootstrap writes).
    db.prepare(`INSERT INTO user_settings (user_id) VALUES ('u1')`).run()

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0033_user_settings_ai_vision_model.sql'), 'utf8'))

    // Existing users keep the fallback behavior (NULL = no explicit vision
    // model — resolution falls to ai_model); no backfill.
    const old = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get('u1')
    expect(old).toMatchObject({ user_id: 'u1', ai_vision_model: null })

    // The explicit choice is representable — the ai_model charset (model ids
    // go into request bodies and, for Gemini, the URL path).
    db.prepare('UPDATE user_settings SET ai_vision_model = ? WHERE user_id = ?').run(
      'gemini-3.6-flash',
      'u1'
    )
    expect(
      db.prepare('SELECT ai_vision_model FROM user_settings WHERE user_id = ?').get('u1')
    ).toMatchObject({ ai_vision_model: 'gemini-3.6-flash' })
  })

  it('keeps the chain green through 0033..0041 (the column 0042 later drops)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    // `ai_vision_model` is dropped by 0042 (#523 P3), so "this migration added
    // it" is asserted on the chain STOPPING before the drop — the historical
    // claim stays true without re-adding a dropped column's assertion.
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0042')
    )
    const columns = db.prepare('PRAGMA table_info(user_settings)').all()
    expect(columns.map((c: Record<string, unknown>) => c.name)).toContain('ai_vision_model')
  })
})

// OCR audit action (ahaqqu/RumaQ#433, review T4-A1): the document_audit
// CHECK widens once more (the 0026 rebuild shape) so the expiry read that
// ships bytes to the caller's AI provider leaves a durable row — 'ocr', not
// 'view': a view previews bytes to the household, an OCR discloses them to a
// third party, and the audit trail must keep the two apart.
describe('migration 0034: document_audit ocr action (#433)', () => {
  it('copies every pre-0034 audit row verbatim through the rebuild', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0034')
    )

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
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
      'view',
      'f-1',
      '2026-11-02 00:00:00'
    )

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0034_document_audit_ocr_action.sql'), 'utf8'))

    const audit = db.prepare('SELECT * FROM document_audit ORDER BY id').all()
    expect(audit).toHaveLength(2)
    expect(audit[0]).toMatchObject({
      id: 'aud-1',
      action: 'upload',
      document_file_id: null,
      created_at: '2026-11-01 00:00:00',
    })
    expect(audit[1]).toMatchObject({ id: 'aud-2', action: 'view', document_file_id: 'f-1' })
  })

  it('accepts ocr and keeps rejecting unknown actions; the lookup index survives the rebuild', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
    ).run()

    const insertAudit = db.prepare(
      `INSERT INTO document_audit (id, document_id, household_id, actor_user_id, action, document_file_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    // The OCR read is representable, file-scoped like a view/download.
    expect(() => insertAudit.run('aud-ocr', 'doc-1', 'h1', 'u1', 'ocr', 'f-1')).not.toThrow()
    // The CHECK is still real.
    expect(() => insertAudit.run('aud-bad', 'doc-1', 'h1', 'u1', 'share', null)).toThrow()

    // The per-document audit lookup still seeks (the 0022/0025 contract).
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT action FROM document_audit
          WHERE document_id = ? ORDER BY created_at`
      )
      .all('doc-1')
    const detail = plan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(detail).toContain('idx_document_audit_document')
    expect(detail).not.toMatch(/SCAN|TEMP B-TREE/i)
  })
})

// AI review of match-review items (ahaqqu/RumaQ#484, backend PR 1): the mode
// switch's key/value table + the per-pair verdict cache + the decision
// provenance column. The lib-level semantics (floor, cache, agreement) live in
// review-ai.test.ts; here the migration chain itself is exercised — the
// backfill for rows that predate 0038 and the seed the admin UI reads.
describe('migration 0038: review AI (#484)', () => {
  function insertPre0038ReviewItem(db: Db, id = 'rev-1', status = 'pending'): void {
    db.prepare(
      `INSERT INTO match_review_items
         (id, item_product_key, entry_product_key, pair_data, reason, match_method,
          confidence, run_started_at, first_flagged_at, last_flagged_at, status)
       VALUES (?, ? || '-item', ? || '-entry', '{}', 'price_ratio', 'exact', 1,
               '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', ?)`
    ).run(id, id, id, status)
  }

  it('seeds review_mode=assist and backfills decided_source=human on decided pre-0038 rows only', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0038')
    )
    insertPre0038ReviewItem(db, 'rev-pending')
    insertPre0038ReviewItem(db, 'rev-decided', 'approved')

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0038_review_ai.sql'), 'utf8'))

    // Default mode is approve-with-AI; the AI-access owner is NOT seeded (the
    // cron has no acting admin until an admin enables auto; #523 P1 removed the
    // server-key fallback that used to stand in for one).
    expect(db.prepare('SELECT key, value FROM app_settings').all()).toEqual([
      { key: 'review_mode', value: 'assist' },
    ])
    // Every pre-existing DECISION was a human one — the backfill attributes
    // decided rows. A pending row has nothing to attribute (the same state
    // undo produces), so it stays NULL (thermos A5).
    expect(
      db.prepare('SELECT decided_source FROM match_review_items WHERE id = ?').get('rev-decided')
    ).toMatchObject({ decided_source: 'human' })
    expect(
      db.prepare('SELECT decided_source FROM match_review_items WHERE id = ?').get('rev-pending')
    ).toMatchObject({ decided_source: null })
  })

  it('keeps the full chain green and enforces the verdict vocabulary + cascade', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    // node:sqlite defaults FKs OFF; D1 enforces them.
    db.exec('PRAGMA foreign_keys = ON')
    insertPre0038ReviewItem(db)

    const insert = db.prepare(
      `INSERT INTO review_ai_verdicts (id, review_item_id, verdict, confidence, mode)
       VALUES (?, ?, ?, ?, ?)`
    )
    expect(() => insert.run('v1', 'rev-1', 'maybe', 0.9, 'assist')).toThrow()
    expect(() => insert.run('v2', 'rev-1', 'same', 0.9, 'manual')).toThrow()
    insert.run('v3', 'rev-1', 'same', 0.9, 'assist')
    // One verdict per review item — the cache's uniqueness.
    expect(() => insert.run('v4', 'rev-1', 'different', 0.2, 'assist')).toThrow()

    // The verdict is a CHILD of the pair: deleting the item drops it.
    db.prepare('DELETE FROM match_review_items WHERE id = ?').run('rev-1')
    expect(db.prepare('SELECT COUNT(*) AS count FROM review_ai_verdicts').get()).toMatchObject({
      count: 0,
    })
  })
})

// The AI gateway (ahaqqu/RumaQ#523, plan §3.2–§3.3): two household-owned tables
// (providers + one assignment per capability), three dimensions on usage rows,
// and a backfill that must agree with the runtime's ACTIVE_HOUSEHOLD_SQL rule.
// Real SQLite (node:sqlite) runs the whole chain, so the CTEs, the window
// functions, the CHECKs, the expression index and the FK cascades are the
// database's behaviour, not the test's description of it.
describe('migration 0041: AI gateway (#523 P1)', () => {
  const PRE_0041 = () => migrationFiles().filter((file: string) => file < '0041')

  function apply0041(db: Db): void {
    db.exec(readFileSync(join(MIGRATIONS_DIR, '0041_ai_gateway.sql'), 'utf8'))
  }

  // The legacy world: users, two households, one user in BOTH (active = h2),
  // per-user AI settings (one keyed custom, one keyless, one non-envelope),
  // and usage rows from the retired server-key era.
  function seedLegacy(db: Db): void {
    const user = db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)')
    for (const [id, name] of [
      ['u1', 'Alice'],
      ['u2', 'Bob'],
      ['u3', 'Carol'],
      ['u4', 'Dave'],
      ['u5', 'Eve'],
      ['u6', 'Frank'],
      ['u7', 'Grace'],
    ] as const) {
      user.run(id, `${id}@x`, name)
    }
    db.prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)').run(
      'h1',
      'H1',
      'u1'
    )
    db.prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)').run(
      'h2',
      'H2',
      'u3'
    )
    const member = db.prepare(
      `INSERT INTO household_members (id, household_id, user_id, role, joined_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    // u1 owns h1 but joined LAST; u2 is the earliest member. Owner precedence
    // must still win the capability assignments.
    member.run('m1', 'h1', 'u1', 'owner', '2026-03-01 00:00:00')
    member.run('m2', 'h1', 'u2', 'member', '2026-01-01 00:00:00')
    member.run('m3', 'h1', 'u3', 'member', '2026-02-01 00:00:00')
    member.run('m4', 'h2', 'u3', 'owner', '2026-04-01 00:00:00')
    member.run('m5', 'h1', 'u6', 'member', '2026-05-01 00:00:00')

    const settings = db.prepare(
      `INSERT INTO user_settings
         (id, user_id, ai_provider, ai_model, ai_vision_model, ai_thinking_level,
          encrypted_ai_key, active_household_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    settings.run('s1', 'u1', 'openai', 'u1-text', 'u1-vision', 'low', 'v1:U1KEY', 'h1')
    settings.run('s2', 'u2', 'openai', 'u2-text', null, 'high', 'v1:U2KEY', 'h1')
    settings.run('s3', 'u3', 'gemini', 'u3-text', null, null, 'v1:U3KEY', 'h2')
    settings.run('s4', 'u4', 'openai', 'u4-text', null, null, 'v1:U4KEY', null)
    settings.run('s5', 'u5', 'openai', 'u5-text', null, null, null, 'h1')
    settings.run('s6', 'u6', 'openai', 'u6-text', null, null, 'plain-slip', 'h1')
    // u7 has no settings row and no membership at all — skipped by both FKs.

    const usage = db.prepare(
      `INSERT INTO ai_usage_events
         (id, user_id, ts, date, provider, model, input_tokens, output_tokens,
          cached_tokens, key_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    usage.run('e1', 'u1', '2026-11-01T00:00:00Z', '2026-11-01', 'gemini', 'old', 1, 2, null, 'user')
    usage.run(
      'e2',
      'u2',
      '2026-11-01T00:00:00Z',
      '2026-11-01',
      'gemini',
      'old',
      1,
      2,
      null,
      'server'
    )
    usage.run('e3', 'u3', '2026-11-01T00:00:00Z', '2026-11-01', 'gemini', 'old', 1, 2, null, 'user')
    usage.run('e4', 'u4', '2026-11-01T00:00:00Z', '2026-11-01', 'gemini', 'old', 1, 2, null, 'user')
    usage.run('e5', 'u2', '2026-11-01T00:00:00Z', '2026-11-01', 'gemini', 'old', 1, 2, null, null)
    usage.run('e6', 'u6', '2026-11-01T00:00:00Z', '2026-11-01', 'gemini', 'old', 1, 2, null, 'user')
  }

  function providerRows(db: Db): Array<Record<string, unknown>> {
    return db
      .prepare(
        `SELECT id, household_id, label, kind, preset, base_url, default_model, encrypted_key
           FROM ai_providers ORDER BY id`
      )
      .all()
  }

  function capabilityRows(db: Db): Array<Record<string, unknown>> {
    return db
      .prepare(
        `SELECT household_id, capability, provider_id, model, thinking_level
           FROM ai_capabilities ORDER BY household_id, capability`
      )
      .all()
  }

  it('backfills one provider per keyed user into their ACTIVE household, labels disambiguated', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, PRE_0041())
    seedLegacy(db)
    apply0041(db)

    expect(providerRows(db)).toEqual([
      {
        id: 'legacy-u1',
        household_id: 'h1',
        label: 'OpenAI (imported)',
        kind: 'openai-compatible',
        preset: 'openai',
        base_url: null,
        // No owner-typed default yet (#523 owner decision): NULL, not a guess.
        default_model: null,
        // Copied VERBATIM: no re-encryption, no re-entry (plan §3.3).
        encrypted_key: 'v1:U1KEY',
      },
      {
        // Same household, same provider: the partition-unique sequence keeps
        // the (household, lower(label)) index satisfiable.
        id: 'legacy-u2',
        household_id: 'h1',
        label: 'OpenAI (imported) · Bob #2',
        kind: 'openai-compatible',
        preset: 'openai',
        base_url: null,
        default_model: null,
        encrypted_key: 'v1:U2KEY',
      },
      {
        // A user in two households lands in the ACTIVE one only (h2), never
        // duplicated into h1.
        id: 'legacy-u3',
        household_id: 'h2',
        label: 'Gemini (imported)',
        kind: 'gemini',
        preset: 'gemini',
        base_url: null,
        default_model: null,
        encrypted_key: 'v1:U3KEY',
      },
    ])

    // Keyless users, users with no household, and non-envelope ciphertext rows
    // are skipped — they land in "not configured", they do not abort the deploy.
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM ai_providers
            WHERE id IN ('legacy-u4', 'legacy-u5', 'legacy-u6', 'legacy-u7')`
        )
        .get()
    ).toEqual({ cnt: 0 })
  })

  it('leaves the provider default_model NULL after backfill (no invented alias)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, PRE_0041())
    seedLegacy(db)
    apply0041(db)

    // Legacy rows carry their per-capability models; the owner's optional
    // "one alias per key" default starts empty (owner decision, #523).
    expect(providerRows(db).map((row) => row.default_model)).toEqual([null, null, null])
    // The column is writable and reads back, so the resolver's inheritance can
    // be configured per provider without touching any capability row.
    db.prepare(
      `UPDATE ai_providers SET default_model = 'chatgpt-4o-latest' WHERE id = 'legacy-u1'`
    ).run()
    expect(providerRows(db).find((row) => row.id === 'legacy-u1')?.default_model).toBe(
      'chatgpt-4o-latest'
    )
    expect(
      capabilityRows(db).filter(
        (row) => row.household_id === 'h1' && row.provider_id === 'legacy-u1'
      )
    ).toHaveLength(3)
  })

  it('inherits all three capabilities: owner precedence, vision model fallback, no vision thinking', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, PRE_0041())
    seedLegacy(db)
    apply0041(db)

    expect(capabilityRows(db)).toEqual([
      // h1: u1 (owner) wins over the earlier-joined u2, deterministically.
      {
        household_id: 'h1',
        capability: 'decision',
        provider_id: 'legacy-u1',
        model: 'u1-text',
        thinking_level: 'low',
      },
      {
        household_id: 'h1',
        capability: 'reasoning',
        provider_id: 'legacy-u1',
        model: 'u1-text',
        thinking_level: 'low',
      },
      {
        // Explicit ai_vision_model wins; the thinking level is forced NULL
        // (the CHECK requires it).
        household_id: 'h1',
        capability: 'vision',
        provider_id: 'legacy-u1',
        model: 'u1-vision',
        thinking_level: null,
      },
      // h2: u3's own values, vision falls back to the text model when unset.
      {
        household_id: 'h2',
        capability: 'decision',
        provider_id: 'legacy-u3',
        model: 'u3-text',
        thinking_level: null,
      },
      {
        household_id: 'h2',
        capability: 'reasoning',
        provider_id: 'legacy-u3',
        model: 'u3-text',
        thinking_level: null,
      },
      {
        household_id: 'h2',
        capability: 'vision',
        provider_id: 'legacy-u3',
        model: 'u3-text',
        thinking_level: null,
      },
    ])

    // Every member's key survives as a provider row even when only the owner's
    // values became assignments (no key is discarded).
    expect(providerRows(db)).toHaveLength(3)
    // A keyless / household-less legacy row produces ZERO rows on both tables.
    expect(
      db
        .prepare(`SELECT COUNT(*) AS cnt FROM ai_capabilities WHERE provider_id LIKE 'legacy-u4%'`)
        .get()
    ).toEqual({ cnt: 0 })
  })

  it('backfills legacy usage rows with the household that paid and the funding source', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, PRE_0041())
    seedLegacy(db)
    apply0041(db)

    const rows = db
      .prepare('SELECT id, household_id, funding, capability FROM ai_usage_events ORDER BY id')
      .all()
    expect(rows).toEqual([
      // user-funded BYOK → household
      { id: 'e1', household_id: 'h1', funding: 'household', capability: null },
      // the retired shared key → platform
      { id: 'e2', household_id: 'h1', funding: 'platform', capability: null },
      // two memberships → the active household
      { id: 'e3', household_id: 'h2', funding: 'household', capability: null },
      // no household membership: the row survives with household NULL
      { id: 'e4', household_id: null, funding: 'household', capability: null },
      // an unknown historical key_source keeps funding NULL ("unknown")
      { id: 'e5', household_id: 'h1', funding: null, capability: null },
      { id: 'e6', household_id: 'h1', funding: 'household', capability: null },
    ])
    // Pre-0041 history has no capability dimension — NULL, not a guess.
    expect(rows.every((row) => row.capability === null)).toBe(true)
  })

  it('enforces case-insensitive label uniqueness per household (expression index)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)').run(
      'h1',
      'H1',
      'u1'
    )
    db.prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)').run(
      'h2',
      'H2',
      'u1'
    )
    const insert = db.prepare(
      'INSERT INTO ai_providers (id, household_id, label, kind) VALUES (?, ?, ?, ?)'
    )
    const index = db
      .prepare(
        `SELECT sql FROM sqlite_master
          WHERE type = 'index' AND name = 'idx_ai_providers_household_label'`
      )
      .get() as { sql: string }
    expect(index.sql).toContain('lower(label)')

    insert.run('p1', 'h1', 'Gemini', 'gemini')
    expect(() => insert.run('p2', 'h1', 'gemini', 'gemini')).toThrow()
    // Different households may reuse a label — the scope is the household.
    insert.run('p3', 'h2', 'gemini', 'gemini')
  })

  it('enforces the kind, capability, vision-thinking, funding and key-envelope CHECKs', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)').run(
      'h1',
      'H1',
      'u1'
    )
    const provider = db.prepare(
      'INSERT INTO ai_providers (id, household_id, label, kind, encrypted_key) VALUES (?, ?, ?, ?, ?)'
    )
    // The wire kinds are closed; a vendor is a preset, never a kind.
    expect(() => provider.run('p-bad', 'h1', 'X', 'gemini-pro', null)).toThrow()
    // Both envelope versions are accepted from day one (D10's v2: arrives in P2)
    // and a plaintext slip is refused.
    provider.run('p-v1', 'h1', 'V1', 'openai-compatible', 'v1:AAAA')
    provider.run('p-v2', 'h1', 'V2', 'openai-compatible', 'v2:AAAA')
    expect(() => provider.run('p-plain', 'h1', 'Plain', 'openai-compatible', 'sk-plain')).toThrow()

    const capability = db.prepare(
      `INSERT INTO ai_capabilities (household_id, capability, provider_id, thinking_level)
       VALUES ('h1', ?, ?, ?)`
    )
    expect(() => capability.run('embedding', 'p-v1', null)).toThrow()
    expect(() => capability.run('vision', 'p-v1', 'low')).toThrow()
    capability.run('reasoning', 'p-v1', 'high')

    // funding is D9's reserved dimension: household | platform, nothing else.
    const usage = db.prepare(
      `INSERT INTO ai_usage_events (id, user_id, ts, date, funding) VALUES (?, 'u1', 'x', 'x', ?)`
    )
    usage.run('e-user', 'household')
    usage.run('e-platform', 'platform')
    expect(() => usage.run('e-premium', 'premium')).toThrow()
  })

  it('cascades provider→assignment and household→both, while usage keeps the record', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, PRE_0041())
    seedLegacy(db)
    apply0041(db)
    db.exec('PRAGMA foreign_keys = ON')

    // Deleting a provider clears the assignments that pointed at it.
    db.prepare(`DELETE FROM ai_providers WHERE id = 'legacy-u1'`).run()
    expect(
      db.prepare(`SELECT COUNT(*) AS cnt FROM ai_capabilities WHERE household_id = 'h1'`).get()
    ).toEqual({ cnt: 0 })
    // h2 is untouched — the cascade is per provider, not per household.
    expect(
      db.prepare(`SELECT COUNT(*) AS cnt FROM ai_capabilities WHERE household_id = 'h2'`).get()
    ).toEqual({ cnt: 3 })

    // Deleting a household takes its providers and assignments; usage rows keep
    // their history with household_id SET NULL (the tokens were still spent).
    // The app re-baselines members' active pointer before deleting (0001's
    // active_household_id FK has no ON DELETE action).
    db.prepare(`UPDATE user_settings SET active_household_id = NULL WHERE user_id = 'u3'`).run()
    db.prepare(`DELETE FROM households WHERE id = 'h2'`).run()
    expect(
      db.prepare(`SELECT COUNT(*) AS cnt FROM ai_providers WHERE household_id = 'h2'`).get()
    ).toEqual({ cnt: 0 })
    expect(
      db.prepare(`SELECT COUNT(*) AS cnt FROM ai_capabilities WHERE household_id = 'h2'`).get()
    ).toEqual({ cnt: 0 })
    expect(db.prepare(`SELECT household_id FROM ai_usage_events WHERE id = 'e3'`).get()).toEqual({
      household_id: null,
    })
  })

  it('indexes the per-user capability and per-household usage reads (no scan)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    const userPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM ai_usage_events
          WHERE user_id = ? AND date = ? AND capability = ?`
      )
      .all('u1', '2026-11-01', 'reasoning')
      .map((row: Record<string, unknown>) => String(row.detail))
      .join(' | ')
    expect(userPlan).toContain('idx_ai_usage_events_user_date_capability')
    expect(userPlan).not.toMatch(/SCAN ai_usage_events|TEMP B-TREE/i)

    const householdPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM ai_usage_events
          WHERE household_id = ? AND date = ?`
      )
      .all('h1', '2026-11-01')
      .map((row: Record<string, unknown>) => String(row.detail))
      .join(' | ')
    expect(householdPlan).toContain('idx_ai_usage_events_household_date')
    expect(householdPlan).not.toMatch(/SCAN ai_usage_events|TEMP B-TREE/i)
  })

  it('keeps the chain green on a fresh database (additive: no legacy column touched by 0041)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    // Stop before 0042: P1's claim is that THIS migration touched no legacy
    // column — the P3 drop is asserted in its own describe below.
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0042')
    )

    const providerColumns = db.prepare('PRAGMA table_info(ai_providers)').all()
    expect(providerColumns.map((column: Record<string, unknown>) => column.name)).toEqual([
      'id',
      'household_id',
      'label',
      'kind',
      'preset',
      'base_url',
      'default_model',
      'encrypted_key',
      'created_at',
      'updated_at',
    ])
    const capabilityColumns = db.prepare('PRAGMA table_info(ai_capabilities)').all()
    expect(capabilityColumns.map((column: Record<string, unknown>) => column.name)).toEqual([
      'household_id',
      'capability',
      'provider_id',
      'model',
      'thinking_level',
      'updated_at',
    ])
    const usageColumns = db.prepare('PRAGMA table_info(ai_usage_events)').all()
    expect(usageColumns.map((column: Record<string, unknown>) => column.name)).toEqual(
      expect.arrayContaining(['capability', 'household_id', 'funding'])
    )
    // P1 is additive: the legacy settings columns are still exactly as they were
    // (P3 drops them with the Settings screen).
    const settingColumns = db.prepare('PRAGMA table_info(user_settings)').all()
    expect(settingColumns.map((column: Record<string, unknown>) => column.name)).toEqual(
      expect.arrayContaining([
        'ai_provider',
        'encrypted_ai_key',
        'ai_base_url',
        'ai_model',
        'ai_vision_model',
        'ai_thinking_level',
      ])
    )
    // Nothing is seeded: an empty account has zero providers and assignments.
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM ai_providers').get()).toEqual({ cnt: 0 })
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM ai_capabilities').get()).toEqual({ cnt: 0 })
  })

  it('drops a non-enum legacy thinking level instead of aborting the deploy (thermos A3)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, PRE_0041())
    // 0009 added ai_thinking_level with no CHECK; only the settings schema
    // constrains it. One hand-edited value must not fail the migration for
    // everyone — the same rule the 'v1:' key filter enforces.
    seedLegacy(db)
    db.prepare(`UPDATE user_settings SET ai_thinking_level = 'max' WHERE user_id = 'u1'`).run()

    expect(() => apply0041(db)).not.toThrow()
    // The owner still wins the assignments; only the corrupt knob is dropped.
    expect(
      db
        .prepare(
          `SELECT capability, thinking_level FROM ai_capabilities
            WHERE household_id = 'h1' ORDER BY capability`
        )
        .all()
    ).toEqual([
      { capability: 'decision', thinking_level: null },
      { capability: 'reasoning', thinking_level: null },
      { capability: 'vision', thinking_level: null },
    ])
    expect(providerRows(db)).toHaveLength(3)
  })

  it('numbers labels by the written label, so two unknown preset ids never collide (thermos A4)', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, PRE_0041())
    // ai_provider is a bare TEXT column (0001): the six-value vocabulary lives
    // only in Valibot. Two DIFFERENT unknown ids both render as
    // 'Custom provider (imported)', so numbering by the id would hand each
    // rn = 1 and abort on idx_ai_providers_household_label.
    seedLegacy(db)
    db.prepare(`UPDATE user_settings SET ai_provider = 'openrouter' WHERE user_id = 'u1'`).run()
    db.prepare(`UPDATE user_settings SET ai_provider = 'together' WHERE user_id = 'u2'`).run()

    expect(() => apply0041(db)).not.toThrow()
    expect(
      db
        .prepare(`SELECT id, label, preset FROM ai_providers WHERE household_id = 'h1' ORDER BY id`)
        .all()
    ).toEqual([
      {
        id: 'legacy-u1',
        label: 'Custom provider (imported)',
        preset: 'openrouter',
      },
      {
        id: 'legacy-u2',
        label: 'Custom provider (imported) · Bob #2',
        preset: 'together',
      },
    ])
  })
})

// ahaqqu/RumaQ#523 P3 (plan §4.3, D6): the legacy per-user AI settings are
// DROPPED. This is the one destructive migration of the AI-gateway project, so
// its contract is pinned against a real SQLite engine: the six columns are gone,
// everything else on `user_settings` survives, and a FRESH database still serves
// a working Settings payload (no route can reference a dropped column).
describe('migration 0042: legacy AI settings dropped (#523 P3)', () => {
  const LEGACY_COLUMNS = [
    'ai_provider',
    'encrypted_ai_key',
    'ai_base_url',
    'ai_model',
    'ai_vision_model',
    'ai_thinking_level',
  ]

  function columnNames(db: Db, table: string): string[] {
    return db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((column: Record<string, unknown>) => String(column.name))
  }

  it('drops exactly the six legacy columns and keeps the rest of user_settings', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0042')
    )
    const before = columnNames(db, 'user_settings')
    // The pre-drop world really has them: the drop below would otherwise be a
    // no-op on an empty set and the assertion meaningless.
    expect(before).toEqual(expect.arrayContaining(LEGACY_COLUMNS))

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0042_drop_legacy_ai_settings.sql'), 'utf8'))

    const after = columnNames(db, 'user_settings')
    expect(after.filter((column: string) => LEGACY_COLUMNS.includes(column))).toEqual([])
    // The surviving columns are exactly (before − the six), so nothing else was
    // rebuilt away with them.
    expect(after).toEqual(before.filter((column: string) => !LEGACY_COLUMNS.includes(column)))
  })

  it('preserves the surviving values of an existing settings row through the drop', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0042')
    )
    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare(
      `INSERT INTO user_settings (id, user_id, motion_preference, language, theme_hue,
                                  persona_user_role, ai_provider, ai_model)
       VALUES ('s1', 'u1', 'reduced', 'id', 210, 'chef', 'gemini', 'gemini-3.6-flash')`
    ).run()

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0042_drop_legacy_ai_settings.sql'), 'utf8'))

    expect(
      db
        .prepare(
          `SELECT motion_preference, language, theme_hue, persona_user_role
             FROM user_settings WHERE user_id = 'u1'`
        )
        .get()
    ).toEqual({
      motion_preference: 'reduced',
      language: 'id',
      theme_hue: 210,
      persona_user_role: 'chef',
    })
  })

  it('the full chain is green and a FRESH database still yields a working Settings payload', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    // 1) The schema the settings route selects from: no legacy column, and every
    //    column the route's SELECT names is present.
    const settingsColumns = columnNames(db, 'user_settings')
    expect(settingsColumns.filter((column: string) => LEGACY_COLUMNS.includes(column))).toEqual([])
    const routeSelect = [
      'motion_preference',
      'language',
      'persona_user_role',
      'persona_ai_role',
      'persona_enabled',
      'theme_hue',
      'active_household_id',
    ]
    expect(settingsColumns).toEqual(expect.arrayContaining(routeSelect))

    // 2) A fresh account: the bootstrap row exists (the settings route and the
    //    auth middleware both rely on it) and the SELECT returns the documented
    //    defaults — this is the payload the UI receives on a brand-new database.
    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    db.prepare("INSERT INTO households (id, name, created_by) VALUES ('h1', 'H1', 'u1')").run()
    db.prepare(
      "INSERT INTO household_members (id, household_id, user_id, role) VALUES ('m1', 'h1', 'u1', 'owner')"
    ).run()
    db.prepare("INSERT INTO user_settings (id, user_id) VALUES ('s1', 'u1')").run()
    const fresh = db
      .prepare(`SELECT ${routeSelect.join(', ')} FROM user_settings WHERE user_id = ?`)
      .get('u1')
    expect(fresh).toEqual({
      motion_preference: 'standard',
      language: null,
      persona_user_role: null,
      persona_ai_role: null,
      persona_enabled: 0,
      theme_hue: null,
      active_household_id: null,
    })

    // 3) The AI block is honest on a fresh household: zero rows, and the status
    //    read (loadHouseholdAiConfig's SELECT) returns nothing to serialize.
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM ai_providers').get()).toEqual({ cnt: 0 })
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM ai_capabilities').get()).toEqual({ cnt: 0 })
    expect(db.prepare('SELECT * FROM ai_providers WHERE household_id = ?').all('h1')).toEqual([])
  })

  it('keeps the household AI tables and the usage dimensions intact after the drop', () => {
    // The drop is scoped to `user_settings`: providers, assignments and the
    // capability/household/funding stamps on usage rows are what AI runs on now.
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    expect(columnNames(db, 'ai_providers')).toEqual([
      'id',
      'household_id',
      'label',
      'kind',
      'preset',
      'base_url',
      'default_model',
      'encrypted_key',
      'created_at',
      'updated_at',
    ])
    expect(columnNames(db, 'ai_capabilities')).toEqual([
      'household_id',
      'capability',
      'provider_id',
      'model',
      'thinking_level',
      'updated_at',
    ])
    expect(columnNames(db, 'ai_usage_events')).toEqual(
      expect.arrayContaining(['capability', 'household_id', 'funding'])
    )
  })
})

describe('migration 0044: price_runs.ai_prompt_identity (pipeline #83)', () => {
  it('adds the nullable identity column on top of the pre-0044 schema; old rows stay null', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0044')
    )

    db.prepare(
      `INSERT INTO price_runs (id, run_started_at, finished_at, exit_code, status)
       VALUES ('run-1', '2026-11-10T23:00:05Z', '2026-11-10T23:04:11Z', 0, 'success')`
    ).run()

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0044_price_runs_ai_prompt_identity.sql'), 'utf8'))

    // The pre-existing row survives with the identity NULL — no backfill (the
    // prompt that answered it is unknowable, so it must not be invented).
    const old = db.prepare('SELECT * FROM price_runs WHERE id = ?').get('run-1')
    expect(old).toMatchObject({ id: 'run-1', ai_prompt_identity: null })

    // New rows carry the report's verifier prompt identity as a JSON slice.
    const identity = JSON.stringify({
      version: 2,
      id: 'ocr.verifier.ai_prompt_template',
      sha256: '01274416be4f0f03241df30a4cec72290297750f34c1001d5c691e908fb5baae',
    })
    db.prepare(
      `INSERT INTO price_runs (id, run_started_at, finished_at, exit_code, status, ai_prompt_identity)
       VALUES ('run-2', '2026-11-11T23:00:05Z', '2026-11-11T23:04:11Z', 0, 'success', ?)`
    ).run(identity)
    const fresh = db.prepare('SELECT * FROM price_runs WHERE id = ?').get('run-2')
    expect(fresh).toMatchObject({ ai_prompt_identity: identity })
  })

  it('keeps the full chain green on a fresh database', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())
    const columns = db.prepare('PRAGMA table_info(price_runs)').all()
    expect(columns.map((c: Record<string, unknown>) => c.name)).toContain('ai_prompt_identity')
  })
})

describe('migration 0045: purchase_items.line_total (#518)', () => {
  // 0044 is merged and applied in production (price_runs.ai_prompt_identity,
  // #572), so the purchase line-total migration was renumbered to 0045 after
  // the rebase. It must apply ON TOP of the pre-0045 chain — the production
  // shape — and leave legacy rows untouched (Q4: no backfill).
  function preLineTotalDb(): Db {
    const db = new DatabaseSync(':memory:') as unknown as Db
    // D1 enforces foreign keys; node:sqlite defaults them OFF.
    db.exec('PRAGMA foreign_keys = ON')
    applyMigrations(
      db,
      migrationFiles().filter((file: string) => file < '0045')
    )
    return db
  }

  it('adds the nullable column on top of the 0044 chain; legacy rows keep NULL — no backfill', () => {
    const db = preLineTotalDb()
    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'u1@example.test')").run()
    db.prepare("INSERT INTO households (id, name, created_by) VALUES ('h1', 'Home', 'u1')").run()
    db.prepare(
      `INSERT INTO purchases (id, household_id, date, total)
       VALUES ('p-legacy', 'h1', '2026-11-01', NULL)`
    ).run()
    db.prepare(
      `INSERT INTO purchase_items (id, purchase_id, qty, unit, price)
       VALUES ('pi-legacy', 'p-legacy', 2, 'L', 30000)`
    ).run()

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0045_purchase_line_total.sql'), 'utf8'))

    // The pre-fix row survives with its ambiguous price and a NULL line_total:
    // the price basis is unknowable, so no guessed line amount is invented.
    const legacy = db.prepare("SELECT * FROM purchase_items WHERE id = 'pi-legacy'").get()
    expect(legacy).toMatchObject({ qty: 2, price: 30000, line_total: null })
  })

  it('sorts after the 0044 chain on a fresh database', () => {
    const files = migrationFiles()
    // The chain applies in filename order, so "sorts after 0044" is exactly what
    // production (which already holds 0044) will run next. Deliberately NOT
    // "is the last file" — that pin would fail the next migration PR, which has
    // no reason to know this test exists.
    expect(files.indexOf('0044_price_runs_ai_prompt_identity.sql')).toBeLessThan(
      files.indexOf('0045_purchase_line_total.sql')
    )

    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, files)
    const columns = db.prepare('PRAGMA table_info(purchase_items)').all()
    expect(columns.map((c: Record<string, unknown>) => c.name)).toContain('line_total')
  })
})
