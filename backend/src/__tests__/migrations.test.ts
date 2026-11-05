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
    const audit = db
      .prepare('SELECT action FROM household_task_audit WHERE task_id = ?')
      .all('t1')
    expect(audit.map((r: Record<string, unknown>) => r.action)).toEqual(['create'])
  })

  it('keeps the board listing on an indexed seek for the status-filtered, due-date-ordered query', () => {
    const db = new DatabaseSync(':memory:') as unknown as Db
    applyMigrations(db, migrationFiles())

    // The open column's query: WHERE household_id = ? AND status = 'open'
    // ORDER BY due_date — the 0027 index columns match exactly.
    const boardPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM household_tasks
          WHERE household_id = ? AND status = 'open' ORDER BY due_date`
      )
      .all('h1')
    const board = boardPlan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(board).toContain('idx_household_tasks_household')
    expect(board).not.toMatch(/SCAN|TEMP B-TREE/i)

    // The household-prefix seek (status=all board) uses the same index.
    const allPlan = db
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM household_tasks WHERE household_id = ?')
      .all('h1')
    const all = allPlan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(all).toContain('idx_household_tasks_household')
    expect(all).not.toMatch(/TEMP B-TREE/i)

    // The audit lookups (per task, per household) seek too — the 0022 pair.
    const auditPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT action FROM household_task_audit
          WHERE task_id = ? ORDER BY created_at`
      )
      .all('t1')
    const audit = auditPlan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(audit).toContain('idx_household_task_audit_task')
    expect(audit).not.toMatch(/SCAN|TEMP B-TREE/i)
  })
})
