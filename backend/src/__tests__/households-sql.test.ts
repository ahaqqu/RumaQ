import { describe, it, expect, beforeEach } from 'vite-plus/test'
// Real-SQL coverage for the household membership semantics (thermos review
// C1). The route tests in households.test.ts route a fake D1 on SQL fragments
// — good for HTTP-shape assertions, blind to actual storage behavior. This
// file runs the SAME statements the app runs against a real SQLite engine
// (node:sqlite — D1 is SQLite) through the full migration chain, so the
// security-relevant semantics cannot drift from the schema:
//
//   - the auth middleware's COALESCE active-household resolution (stale
//     pointer must never keep granting access; oldest-membership fallback),
//   - the departure batch (remove/leave): repoint or respawn committed
//     atomically, a removed member's session keeps working (A2),
//   - the invite round trip: hash+encrypted at rest (A8), presentation
//     normalization, storage-level join idempotency (A7).
//
// The backend tsconfig pins `types` to @cloudflare/workers-types, so Node
// builtin imports carry no declarations — same contained suppressions as
// migrations.test.ts.
// @ts-expect-error — no node types in this tsconfig
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error — no node types in this tsconfig
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error — no node types in this tsconfig
import { join, dirname } from 'node:path'
// @ts-expect-error — no node types in this tsconfig
import { fileURLToPath } from 'node:url'

import { ACTIVE_HOUSEHOLD_SQL, signJwt } from '../auth.js'
import {
  leaveHousehold,
  removeMember,
  createInvite,
  joinByCode,
  getMembership,
  getActiveInvite,
  createProfileMember,
  updateMemberProfile,
  listMembers,
  HouseholdNotFoundError,
  HouseholdForbiddenError,
  LastOwnerError,
  InvalidInviteError,
} from '../lib/households.js'
import { householdsApp } from '../apps/households.js'
import { resetRateLimit } from '../lib/rate-limit.js'
import type { MockEnv } from './support/env.js'

type Db = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number }
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

// A D1-shaped adapter over node:sqlite. Only the surface the household code
// uses: prepare().bind().first/all/run and batch(). run() reports
// { meta: { changes } } like real D1 (the join path reads it), and batch() is
// wrapped in a transaction so the departure batch's atomicity claim is
// exercised, not assumed.
function createD1Adapter(sqlite: Db): D1Database {
  const runBound = (sql: string, params: unknown[]) => {
    const info = sqlite.prepare(sql).run(...params)
    return { meta: { changes: info.changes } }
  }
  return {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: async <T>() => (sqlite.prepare(sql).get(...params) as T | undefined) ?? null,
        all: async <T>() => ({ results: sqlite.prepare(sql).all(...params) as T[] }),
        run: async () => runBound(sql, params),
      }),
    }),
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const stmt of stmts) {
          results.push(await stmt.run())
        }
        sqlite.exec('COMMIT')
        return results
      } catch (err) {
        sqlite.exec('ROLLBACK')
        throw err
      }
    },
  } as unknown as D1Database
}

function createDb(): { sqlite: Db; d1: D1Database } {
  const sqlite = new DatabaseSync(':memory:') as unknown as Db
  for (const file of migrationFiles()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  return { sqlite, d1: createD1Adapter(sqlite) }
}

function createUser(sqlite: Db, id: string, email: string): void {
  sqlite.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(id, email)
}

function createHouseholdRow(sqlite: Db, id: string, name: string, createdBy: string): void {
  sqlite
    .prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)')
    .run(id, name, createdBy)
}

function addMember(
  sqlite: Db,
  householdId: string,
  userId: string,
  role: 'owner' | 'member',
  joinedAt: string
): string {
  // The surrogate id (0021) is generated here so every existing test body
  // stays unchanged; new two-mode tests read the return value to address
  // member rows.
  const id = crypto.randomUUID()
  sqlite
    .prepare(
      'INSERT INTO household_members (id, household_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(id, householdId, userId, role, joinedAt)
  return id
}

// Plants a profile-only member (Mode B, #388): user_id NULL, role member.
function addProfileMember(
  sqlite: Db,
  householdId: string,
  displayName: string,
  birthDate: string | null,
  joinedAt: string
): string {
  const id = crypto.randomUUID()
  sqlite
    .prepare(
      "INSERT INTO household_members (id, household_id, user_id, role, display_name, birth_date, joined_at) VALUES (?, ?, NULL, 'member', ?, ?, ?)"
    )
    .run(id, householdId, displayName, birthDate, joinedAt)
  return id
}

function setActivePointer(sqlite: Db, userId: string, householdId: string | null): void {
  sqlite
    .prepare('INSERT INTO user_settings (user_id, active_household_id) VALUES (?, ?)')
    .run(userId, householdId)
}

function resolveActiveHousehold(sqlite: Db, userId: string): string | null {
  const row = sqlite.prepare(ACTIVE_HOUSEHOLD_SQL).get(userId, userId) as {
    household_id: string | null
  } | null
  return row?.household_id ?? null
}

// Member-addressed operations (patch/remove) key on the surrogate id (0021);
// the seeded rows here get their ids through the table, not the helper.
function memberIdOf(sqlite: Db, householdId: string, userId: string): string {
  const row = sqlite
    .prepare('SELECT id FROM household_members WHERE household_id = ? AND user_id = ?')
    .get(householdId, userId) as { id: string } | undefined
  if (!row) throw new Error(`no member row for ${userId} in ${householdId}`)
  return row.id
}

// The middleware SQL is the app's single scoping authority — every household
// route resolves through it. These tests pin its contract against real data.
describe('active-household resolution (COALESCE) over real SQL (#331, review C1)', () => {
  it('prefers user_settings.active_household_id while the membership is live', () => {
    const { sqlite } = createDb()
    createUser(sqlite, 'u1', 'a@b.com')
    createHouseholdRow(sqlite, 'h-old', 'Rumah Lama', 'u1')
    createHouseholdRow(sqlite, 'h-new', 'Rumah Baru', 'u1')
    addMember(sqlite, 'h-old', 'u1', 'owner', '2026-01-01 00:00:00')
    addMember(sqlite, 'h-new', 'u1', 'member', '2026-06-01 00:00:00')
    setActivePointer(sqlite, 'u1', 'h-new')

    expect(resolveActiveHousehold(sqlite, 'u1')).toBe('h-new')
  })

  it('falls back to the oldest remaining membership when the pointer is stale', () => {
    const { sqlite } = createDb()
    createUser(sqlite, 'u1', 'a@b.com')
    createUser(sqlite, 'other', 'other@b.com')
    createHouseholdRow(sqlite, 'h-old', 'Rumah Lama', 'u1')
    createHouseholdRow(sqlite, 'h-new', 'Rumah Baru', 'other')
    addMember(sqlite, 'h-old', 'u1', 'owner', '2026-01-01 00:00:00')
    addMember(sqlite, 'h-new', 'u1', 'member', '2026-06-01 00:00:00')
    setActivePointer(sqlite, 'u1', 'h-new')
    // The removal that strands the pointer: the h-new membership row goes
    // away WITHOUT touching user_settings (the exact drift the middleware
    // re-check exists to contain).
    sqlite
      .prepare('DELETE FROM household_members WHERE household_id = ? AND user_id = ?')
      .run('h-new', 'u1')

    expect(resolveActiveHousehold(sqlite, 'u1')).toBe('h-old')
  })

  it('resolves the oldest membership deterministically with no settings row', () => {
    const { sqlite } = createDb()
    createUser(sqlite, 'u1', 'a@b.com')
    createHouseholdRow(sqlite, 'h-b', 'B', 'u1')
    createHouseholdRow(sqlite, 'h-a', 'A', 'u1')
    addMember(sqlite, 'h-b', 'u1', 'member', '2026-06-01 00:00:00')
    addMember(sqlite, 'h-a', 'u1', 'member', '2026-01-01 00:00:00')

    expect(resolveActiveHousehold(sqlite, 'u1')).toBe('h-a')
  })

  it('answers null for a membership-less session (middleware 401s it)', () => {
    const { sqlite } = createDb()
    createUser(sqlite, 'u1', 'a@b.com')
    createHouseholdRow(sqlite, 'h1', 'Rumah', 'u1')
    setActivePointer(sqlite, 'u1', 'h1') // stale pointer, no membership rows

    expect(resolveActiveHousehold(sqlite, 'u1')).toBeNull()
  })
})

// Two-mode members (ahaqqu/RumaQ#388): the 0021 rebuild gives every member a
// surrogate id, makes user_id nullable (NULL = profile-only, no account) and
// re-establishes the old PK-pair uniqueness as a PARTIAL unique index. These
// tests pin the storage contract the auth path and the member surfaces lean on.
describe('two-mode member schema over real SQL (#388)', () => {
  it('keeps one row per linked account per household but allows many profile-only members', () => {
    const { sqlite } = createDb()
    createUser(sqlite, 'u1', 'a@b.com')
    createHouseholdRow(sqlite, 'h1', 'Keluarga Putri', 'u1')
    addMember(sqlite, 'h1', 'u1', 'owner', '2026-01-01 00:00:00')
    addProfileMember(sqlite, 'h1', 'Adik', '2025-03-02', '2026-11-01 00:00:00')
    addProfileMember(sqlite, 'h1', 'Nenek', null, '2026-11-01 00:00:00')

    // Several account-less people in one household: fine — NULLs are the
    // whole point of the partial index.
    const profileRows = sqlite
      .prepare(
        'SELECT COUNT(*) AS cnt FROM household_members WHERE household_id = ? AND user_id IS NULL'
      )
      .get('h1') as { cnt: number }
    expect(profileRows.cnt).toBe(2)

    // The old PK pair's guarantee survives for LINKED members: a second row
    // for the same (household, user) must be refused by the partial unique
    // index, not by application discipline.
    expect(() =>
      sqlite
        .prepare(
          'INSERT INTO household_members (id, household_id, user_id, role) VALUES (?, ?, ?, ?)'
        )
        .run(crypto.randomUUID(), 'h1', 'u1', 'member')
    ).toThrow()

    // A different household may still hold the same user.
    createHouseholdRow(sqlite, 'h2', 'Rumah Kedua', 'u1')
    addMember(sqlite, 'h2', 'u1', 'owner', '2026-02-01 00:00:00')
  })

  it('keeps the 0020 auth index intact and the surrogate PK after the rebuild', () => {
    const { sqlite } = createDb()
    // The rebuilt table: id is the PK, user_id is nullable.
    const columns = sqlite.prepare('PRAGMA table_info(household_members)').all() as Array<
      Record<string, unknown>
    >
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]))
    expect(byName['id']).toMatchObject({ pk: 1 })
    expect(byName['user_id']).toMatchObject({ notnull: 0 })
    expect(byName['display_name']).toMatchObject({ notnull: 0 })
    expect(byName['birth_date']).toMatchObject({ notnull: 0 })

    // 0020's index is recreated column-for-column — the auth fallback's plan
    // rides it (see the EXPLAIN check in migrations.test.ts).
    const indexes = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'household_members' ORDER BY name"
      )
      .all() as Array<{ name: string }>
    expect(indexes.map((i) => i.name)).toEqual(
      expect.arrayContaining([
        'idx_household_members_user',
        'idx_household_members_household_user',
        'idx_household_members_household',
      ])
    )
  })

  it('never resolves a profile-only member (or a NULL row) through the auth COALESCE', () => {
    const { sqlite } = createDb()
    createUser(sqlite, 'u1', 'a@b.com')
    createUser(sqlite, 'u2', 'c@d.com')
    createHouseholdRow(sqlite, 'h1', 'Keluarga Putri', 'u1')
    createHouseholdRow(sqlite, 'h2', 'Rumah Kedua', 'u2')
    addMember(sqlite, 'h1', 'u1', 'owner', '2026-01-01 00:00:00')
    addMember(sqlite, 'h2', 'u2', 'owner', '2026-01-01 00:00:00')
    addProfileMember(sqlite, 'h1', 'Adik', null, '2026-11-01 00:00:00')

    // The linked members resolve exactly as before — NULL-user rows cannot
    // match `user_id = ?`, so they are invisible to the middleware.
    expect(resolveActiveHousehold(sqlite, 'u1')).toBe('h1')
    expect(resolveActiveHousehold(sqlite, 'u2')).toBe('h2')

    // A user_id that only exists as a profile-only "identity" (display_name)
    // has no membership rows at all: the middleware 401s it. There is no
    // credential to mint for Mode B — that is the point of the mode.
    expect(resolveActiveHousehold(sqlite, 'nobody')).toBeNull()
  })
})

// The profile-only lifecycle through the lib, over real SQL: forced role,
// roster discriminator, owner-only patching, and the bare-delete removal.
describe('profile-only member lifecycle over real SQL (#388)', () => {
  let sqlite: Db
  let d1: D1Database

  beforeEach(() => {
    ;({ sqlite, d1 } = createDb())
    createUser(sqlite, 'owner', 'owner@b.com')
    createUser(sqlite, 'member', 'member@b.com')
    createHouseholdRow(sqlite, 'h1', 'Keluarga Putri', 'owner')
    addMember(sqlite, 'h1', 'owner', 'owner', '2026-01-01 00:00:00')
    addMember(sqlite, 'h1', 'member', 'member', '2026-02-01 00:00:00')
  })

  it('creates a forced-member profile row that the roster marks has_account:false', async () => {
    const row = await createProfileMember(d1, 'h1', 'owner', {
      display_name: 'Adik',
      birth_date: '2025-03-02',
    })
    expect(row).toMatchObject({
      role: 'member',
      user_id: null,
      has_account: false,
      display_name: 'Adik',
      birth_date: '2025-03-02',
    })

    const roster = await listMembers(d1, 'h1')
    expect(roster).toHaveLength(3)
    const profile = roster.find((m) => m.id === row.id)
    expect(profile).toMatchObject({ has_account: false, name: null, email: null })
    expect(roster.find((m) => m.user_id === 'owner')).toMatchObject({ has_account: true })

    // member_count (listHouseholds' subquery) is a plain COUNT(*) — Mode B
    // members count toward the household size.
    const count = sqlite
      .prepare('SELECT COUNT(*) AS cnt FROM household_members WHERE household_id = ?')
      .get('h1') as { cnt: number }
    expect(count.cnt).toBe(3)
  })

  it('is owner-only to create and patch, and patching cannot mint an owner', async () => {
    await expect(
      createProfileMember(d1, 'h1', 'member', { display_name: 'Adik', birth_date: null })
    ).rejects.toBeInstanceOf(HouseholdForbiddenError)
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS cnt FROM household_members').get() as { cnt: number }).cnt
    ).toBe(2)

    const row = await createProfileMember(d1, 'h1', 'owner', {
      display_name: 'Adik',
      birth_date: null,
    })

    // A plain member gets the 403 on a profile-only row — there is no "self".
    await expect(
      updateMemberProfile(d1, 'h1', 'member', row.id, { display_name: 'Nope' })
    ).rejects.toBeInstanceOf(HouseholdForbiddenError)

    // The owner patches it, and the role stays 'member' — the UPDATE only
    // touches profile fields, so no patch shape can mint an owner.
    const patched = await updateMemberProfile(d1, 'h1', 'owner', row.id, {
      display_name: 'Adik Kecil',
      birth_date: '2025-03-02',
    })
    expect(patched).toMatchObject({ display_name: 'Adik Kecil', role: 'member' })
    const stored = sqlite
      .prepare('SELECT role FROM household_members WHERE id = ?')
      .get(row.id) as { role: string }
    expect(stored.role).toBe('member')
  })

  it('removes a profile-only member as one bare delete — no settings work, no respawn', async () => {
    setActivePointer(sqlite, 'owner', 'h1')
    const row = await createProfileMember(d1, 'h1', 'owner', {
      display_name: 'Adik',
      birth_date: null,
    })

    await removeMember(d1, 'h1', 'owner', row.id)

    const remaining = sqlite
      .prepare('SELECT COUNT(*) AS cnt FROM household_members WHERE id = ?')
      .get(row.id) as { cnt: number }
    expect(remaining.cnt).toBe(0)
    // The owner's session is untouched — no user_settings write ever ran
    // (Mode B has no pointer to repoint) and no baseline household was
    // respawned (nobody lost their last membership).
    const settings = sqlite
      .prepare('SELECT active_household_id FROM user_settings WHERE user_id = ?')
      .get('owner') as { active_household_id: string }
    expect(settings.active_household_id).toBe('h1')
    const householdCount = sqlite.prepare('SELECT COUNT(*) AS cnt FROM households').get() as {
      cnt: number
    }
    expect(householdCount.cnt).toBe(1)
  })

  it('removes a linked member with the full departure semantics, addressed by member id', async () => {
    // Same surface, Mode A branch: the member-id address still repoints the
    // removed user's stale pointer (the A2 guarantee, now id-addressed).
    setActivePointer(sqlite, 'member', 'h1')
    createHouseholdRow(sqlite, 'h2', 'Rumah Kedua', 'member')
    addMember(sqlite, 'h2', 'member', 'owner', '2026-03-01 00:00:00')

    await removeMember(d1, 'h1', 'owner', memberIdOf(sqlite, 'h1', 'member'))
    expect(resolveActiveHousehold(sqlite, 'member')).toBe('h2')
  })

  it('409s removing the last owner via the member-id surface and 404s unknown ids', async () => {
    await expect(
      removeMember(d1, 'h1', 'owner', memberIdOf(sqlite, 'h1', 'owner'))
    ).rejects.toBeInstanceOf(LastOwnerError)
    // The 409 fired before any write: both members still present.
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS cnt FROM household_members').get() as { cnt: number }).cnt
    ).toBe(2)

    await expect(removeMember(d1, 'h1', 'owner', 'no-such-member')).rejects.toBeInstanceOf(
      HouseholdNotFoundError
    )
  })
})

// The departure batch (review A2/A4): remove and leave commit the DELETE and
// the session-continuity work in ONE transaction — and a user left with no
// household gets the same baseline respawn the leave path always had.
describe('departure batch over real SQL (#331, review A2/A4)', () => {
  let sqlite: Db
  let d1: D1Database

  beforeEach(() => {
    ;({ sqlite, d1 } = createDb())
    createUser(sqlite, 'owner', 'owner@b.com')
    createUser(sqlite, 'member', 'member@b.com')
    createHouseholdRow(sqlite, 'h1', 'Keluarga Putri', 'owner')
    addMember(sqlite, 'h1', 'owner', 'owner', '2026-01-01 00:00:00')
  })

  it('repoints a removed member who still has another household', async () => {
    addMember(sqlite, 'h1', 'member', 'member', '2026-02-01 00:00:00')
    createHouseholdRow(sqlite, 'h2', 'Rumah Kedua', 'member')
    addMember(sqlite, 'h2', 'member', 'owner', '2026-03-01 00:00:00')
    setActivePointer(sqlite, 'member', 'h1')

    await removeMember(d1, 'h1', 'owner', memberIdOf(sqlite, 'h1', 'member'))

    const remaining = sqlite
      .prepare('SELECT COUNT(*) AS cnt FROM household_members WHERE user_id = ?')
      .get('member') as { cnt: number }
    expect(remaining.cnt).toBe(1)
    expect(resolveActiveHousehold(sqlite, 'member')).toBe('h2')
    // The guarded repoint only moves a pointer still aimed at the left
    // household — an already-switched pointer is never clobbered.
    const pointer = sqlite
      .prepare('SELECT active_household_id FROM user_settings WHERE user_id = ?')
      .get('member') as { active_household_id: string }
    expect(pointer.active_household_id).toBe('h2')
  })

  it('respawns a baseline household for a removed member with none remaining', async () => {
    setActivePointer(sqlite, 'member', 'h1')
    addMember(sqlite, 'h1', 'member', 'member', '2026-02-01 00:00:00')

    await removeMember(d1, 'h1', 'owner', memberIdOf(sqlite, 'h1', 'member'))

    // Symmetry with leave (review A2): the evicted member is not 401-locked
    // out — the auth resolution immediately serves the respawned household.
    const resolved = resolveActiveHousehold(sqlite, 'member')
    expect(resolved).not.toBeNull()
    expect(resolved).not.toBe('h1')
    const membership = getMembership(d1, resolved as string, 'member')
    await expect(membership).resolves.toMatchObject({ role: 'owner' })
    // The respawn plants the same baseline the login flows do.
    const locations = sqlite
      .prepare('SELECT COUNT(*) AS cnt FROM locations WHERE household_id = ?')
      .get(resolved) as { cnt: number }
    const stores = sqlite
      .prepare('SELECT COUNT(*) AS cnt FROM stores WHERE household_id = ?')
      .get(resolved) as { cnt: number }
    expect(locations.cnt).toBe(4)
    expect(stores.cnt).toBe(3)
  })

  it('lets a member leave and blocks the last owner without touching rows', async () => {
    addMember(sqlite, 'h1', 'member', 'member', '2026-02-01 00:00:00')
    createHouseholdRow(sqlite, 'h2', 'Rumah Kedua', 'owner')
    addMember(sqlite, 'h2', 'owner', 'owner', '2026-02-01 00:00:00')

    // A plain member can always leave.
    await leaveHousehold(d1, 'h1', 'member')
    expect(
      (
        sqlite
          .prepare('SELECT COUNT(*) AS cnt FROM household_members WHERE household_id = ?')
          .get('h1') as { cnt: number }
      ).cnt
    ).toBe(1)

    // The owner is the sole owner of h2 — leaving must 409 and change nothing.
    await expect(leaveHousehold(d1, 'h2', 'owner')).rejects.toBeInstanceOf(LastOwnerError)
    expect(
      (
        sqlite
          .prepare('SELECT COUNT(*) AS cnt FROM household_members WHERE household_id = ?')
          .get('h2') as { cnt: number }
      ).cnt
    ).toBe(1)
  })
})

// Invite lifecycle over real SQL: the hash+encryption storage contract and
// the storage-level join idempotency, including the presentation round trip.
describe('invite round trip over real SQL (#331, review A7/A8)', () => {
  it('stores no plaintext, redeems with messy presentation, and is idempotent', async () => {
    const { sqlite, d1 } = createDb()
    createUser(sqlite, 'owner', 'owner@b.com')
    createUser(sqlite, 'joiner', 'joiner@b.com')
    createHouseholdRow(sqlite, 'h1', 'Keluarga Putri', 'owner')
    addMember(sqlite, 'h1', 'owner', 'owner', '2026-01-01 00:00:00')

    const invite = await createInvite(d1, 'h1', 'owner', 'test-enc-key')
    expect(invite.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/)

    // At rest: hash + ciphertext only — the plaintext code is nowhere in the
    // table (review A8).
    const row = sqlite.prepare('SELECT * FROM household_invites').get() as Record<string, unknown>
    expect(JSON.stringify(row)).not.toContain(invite.code)
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/)

    // The owner screen still reveals the code (decrypt round trip).
    await expect(getRevealedCode(d1, 'h1')).resolves.toBe(invite.code)

    // Lowercase + spacing + dashes normalize to the stored hash.
    const messy = invite.code
      .toLowerCase()
      .split('')
      .map((ch, i) => (i === 3 ? `-${ch}` : ch))
      .join('')
    const first = await joinByCode(d1, 'joiner', messy)
    expect(first).toMatchObject({ already_member: false, household: { id: 'h1' } })
    await expect(getMembership(d1, 'h1', 'joiner')).resolves.toMatchObject({ role: 'member' })

    // A redeem that races past every check still lands as one row and
    // reports already_member — the UNIQUE PK is the arbiter (review A7).
    const second = await joinByCode(d1, 'joiner', invite.code)
    expect(second.already_member).toBe(true)
    const memberships = sqlite
      .prepare(
        'SELECT COUNT(*) AS cnt FROM household_members WHERE household_id = ? AND user_id = ?'
      )
      .get('h1', 'joiner') as { cnt: number }
    expect(memberships.cnt).toBe(1)

    // Unknown codes answer the same no-leak error.
    await expect(joinByCode(d1, 'joiner', 'ZZZ9999999')).rejects.toBeInstanceOf(InvalidInviteError)
  })

  it('rejects an expired code like an unknown one', async () => {
    const { sqlite, d1 } = createDb()
    createUser(sqlite, 'owner', 'owner@b.com')
    createHouseholdRow(sqlite, 'h1', 'Keluarga Putri', 'owner')
    addMember(sqlite, 'h1', 'owner', 'owner', '2026-01-01 00:00:00')
    sqlite
      .prepare(
        `INSERT INTO household_invites (id, household_id, code_hash, code_encrypted, created_by, expires_at)
         VALUES ('inv', 'h1', '${'b'.repeat(64)}', 'enc', 'owner', '2020-01-01 00:00:00')`
      )
      .run()

    await expect(joinByCode(d1, 'owner', 'ABC2345678')).rejects.toBeInstanceOf(InvalidInviteError)
  })
})

// Reads the invite the way the owner GET does — through the decrypting lib.
async function getRevealedCode(d1: D1Database, householdId: string): Promise<string | null> {
  const invite = await getActiveInvite(d1, householdId, 'test-enc-key')
  return invite?.code ?? null
}

// Core endpoint smoke through the real app stack: cookie auth middleware ->
// COALESCE resolution -> households routes, all against the real SQLite.
describe('households app over real SQL (cookie path)', () => {
  let sqlite: Db
  let d1: D1Database
  let env: MockEnv
  const jwt = async (sub: string) => signJwt({ sub, exp: Date.now() + 60_000 }, 'test-secret')

  beforeEach(() => {
    resetRateLimit()
    ;({ sqlite, d1 } = createDb())
    env = {
      DB: d1,
      RECEIPTS: {},
      BROCHURES: {} as MockEnv['BROCHURES'],
      DOCUMENTS: {} as MockEnv['DOCUMENTS'],
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      WORKER_JWT_SECRET: 'test-secret',
      WORKER_ENCRYPTION_KEY: 'test-enc-key',
      PAGES_ORIGIN: 'http://localhost:5173',
      EMAIL_AUTH_ENABLED: 'false',
      ASSETS: undefined as unknown as Fetcher,
      props: undefined,
      TEST_MODE: 'true',
    } as unknown as MockEnv
  })

  const seed = () => {
    createUser(sqlite, 'u1', 'a@b.com')
    createHouseholdRow(sqlite, 'h1', 'Keluarga Putri', 'u1')
    createHouseholdRow(sqlite, 'h2', 'Rumah Kedua', 'u1')
    addMember(sqlite, 'h1', 'u1', 'owner', '2026-01-01 00:00:00')
    addMember(sqlite, 'h2', 'u1', 'owner', '2026-02-01 00:00:00')
    setActivePointer(sqlite, 'u1', 'h2')
  }

  it('resolves the session through the COALESCE re-check and lists households', async () => {
    seed()
    const res = await householdsApp.request(
      '/api/households',
      { headers: { Cookie: `rumaq_session=${await jwt('u1')}` } },
      env
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { households: Array<Record<string, unknown>> }
    expect(body.households).toHaveLength(2)
    expect(body.households.find((h) => h.id === 'h2')).toMatchObject({
      is_active: true,
      member_count: 1,
      role: 'owner',
    })
  })

  it('401s a session whose pointer and memberships are both gone, then serves the respawned one', async () => {
    seed()
    // Simulate the pre-A2 drift: pointer + membership rows vanish. The
    // middleware must refuse the session — this is the 401 the departure
    // batch makes unreachable for sessions this app issues going forward.
    sqlite.prepare('DELETE FROM household_members WHERE user_id = ?').run('u1')
    const lockedOut = await householdsApp.request(
      '/api/households',
      { headers: { Cookie: `rumaq_session=${await jwt('u1')}` } },
      env
    )
    expect(lockedOut.status).toBe(401)

    // After a leave/remove departure batch (or re-login), the session works.
    addMember(sqlite, 'h1', 'u1', 'owner', '2026-11-01 00:00:00')
    const recovered = await householdsApp.request(
      '/api/households',
      { headers: { Cookie: `rumaq_session=${await jwt('u1')}` } },
      env
    )
    expect(recovered.status).toBe(200)
  })

  it('serves the member roster and the join flow end to end', async () => {
    seed()
    const cookie = { headers: { Cookie: `rumaq_session=${await jwt('u1')}` } }

    const roster = await householdsApp.request('/api/households/h1/members', cookie, env)
    expect(roster.status).toBe(200)
    const { members } = (await roster.json()) as { members: Array<Record<string, unknown>> }
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({ user_id: 'u1', role: 'owner', email: 'a@b.com' })

    const invite = await createInvite(d1, 'h1', 'u1', 'test-enc-key')
    createUser(sqlite, 'u2', 'joiner@b.com')
    const join = await joinByCode(d1, 'u2', invite.code)
    expect(join).toMatchObject({ already_member: false, household: { id: 'h1' } })

    const rosterAfter = await householdsApp.request('/api/households/h1/members', cookie, env)
    const { members: after } = (await rosterAfter.json()) as {
      members: Array<Record<string, unknown>>
    }
    expect(after).toHaveLength(2)
  })

  it('creates a profile-only member over the app stack and lists both modes', async () => {
    seed()
    const cookie = { headers: { Cookie: `rumaq_session=${await jwt('u1')}` } }
    const create = await householdsApp.request(
      '/api/households/h1/members',
      {
        method: 'POST',
        body: JSON.stringify({ display_name: 'Adik', birth_date: '2025-03-02' }),
        headers: { 'Content-Type': 'application/json', Cookie: cookie.headers.Cookie },
      },
      env
    )
    expect(create.status).toBe(201)
    const { member } = (await create.json()) as { member: Record<string, unknown> }
    expect(member).toMatchObject({
      user_id: null,
      has_account: false,
      role: 'member',
      display_name: 'Adik',
      birth_date: '2025-03-02',
    })

    // The roster serves both modes through the same endpoint; the Mode B row
    // carries no account fields.
    const roster = await householdsApp.request('/api/households/h1/members', cookie, env)
    const { members } = (await roster.json()) as { members: Array<Record<string, unknown>> }
    expect(members.find((m) => m.id === member.id)).toMatchObject({
      has_account: false,
      email: null,
    })
    expect(members.find((m) => m.user_id === 'u1')).toMatchObject({ has_account: true })
  })
})
