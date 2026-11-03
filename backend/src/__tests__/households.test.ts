import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { householdsApp } from '../apps/households.js'
import { gateway } from '../gateway.js'
import { signJwt } from '../auth.js'
import { resetRateLimit } from '../lib/rate-limit.js'
import { encryptAiKey } from '../lib/crypto.js'
import type { MockEnv } from './support/env.js'

// The household endpoints run 2-5 queries per request (membership gate, rule
// checks, write, read-back), so the api-routes ordered-mockResolvedValueOnce
// idiom would couple every test to call order. Instead this file routes the
// fake D1 on SQL fragments (firstRoutes/allRoutes) and records every executed
// statement (log) so tests assert on WHAT was written, not when.

type Row = Record<string, unknown>

type FakeDb = {
  prepare: (sql: string) => {
    bind: (...params: unknown[]) => {
      first: <T>() => Promise<T | null>
      all: <T>() => Promise<{ results: T[] }>
      run: () => Promise<Record<string, unknown> | undefined>
    }
  }
  batch: (stmts: unknown[]) => Promise<unknown[]>
  log: Array<{ sql: string; params: unknown[] }>
}

function createFakeDb(
  firstRoutes: [RegExp, (params: unknown[]) => Row | null][],
  allRoutes: [RegExp, (params: unknown[]) => Row[]][] = [],
  runRoutes: [RegExp, (params: unknown[]) => Record<string, unknown> | undefined][] = []
): FakeDb {
  const log: Array<{ sql: string; params: unknown[] }> = []
  return {
    log,
    prepare: (sql: string) => {
      // Collapse whitespace so route regexes stay single-line regardless of
      // the SQL's formatting.
      const flat = sql.replace(/\s+/g, ' ')
      return {
        bind: (...params: unknown[]) => ({
          first: async <T>() => {
            const hit = firstRoutes.find(([re]) => re.test(flat))
            if (!hit) throw new Error(`fake DB: no first() route for: ${sql}`)
            return ((await hit[1](params)) as T) ?? null
          },
          all: async <T>() => {
            const hit = allRoutes.find(([re]) => re.test(flat))
            if (!hit) throw new Error(`fake DB: no all() route for: ${sql}`)
            return { results: (await hit[1](params)) as T[] }
          },
          run: async () => {
            log.push({ sql: flat, params })
            // Real D1 reports meta.changes; the join path reads it to
            // distinguish the ON CONFLICT DO NOTHING path (0) from an insert.
            const hit = runRoutes.find(([re]) => re.test(flat))
            return hit ? await hit[1](params) : undefined
          },
        }),
      }
    },
    batch: async (stmts: unknown[]) => {
      for (const stmt of stmts as Array<{ run: () => Promise<void> }>) {
        await stmt.run()
      }
      return []
    },
  }
}

function createEnv(db: FakeDb, overrides: Partial<MockEnv> = {}): MockEnv {
  return {
    DB: db as unknown as MockEnv['DB'],
    RECEIPTS: {},
    BROCHURES: {} as MockEnv['BROCHURES'],
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    WORKER_JWT_SECRET: 'test-secret',
    WORKER_ENCRYPTION_KEY: 'test-enc-key',
    PAGES_ORIGIN: 'http://localhost:5173',
    EMAIL_AUTH_ENABLED: 'false',
    ASSETS: undefined as unknown as Fetcher,
    props: { userId: 'u1', householdId: 'h1' },
    TEST_MODE: 'true',
    ...overrides,
  }
}

const OWNER_MEMBERSHIP = { id: 'h1', name: 'Keluarga Putri', role: 'owner' }
const MEMBER_MEMBERSHIP = { id: 'h1', name: 'Keluarga Putri', role: 'member' }

const OWNER_COUNT_ONE: [RegExp, (params: unknown[]) => Row | null] = [
  /SELECT COUNT\(\*\) AS cnt FROM household_members\s+WHERE household_id = \? AND role = 'owner'/,
  () => ({ cnt: 1 }),
]

const OWNER_COUNT_TWO: [RegExp, (params: unknown[]) => Row | null] = [
  /SELECT COUNT\(\*\) AS cnt FROM household_members\s+WHERE household_id = \? AND role = 'owner'/,
  () => ({ cnt: 2 }),
]

describe('households routes', () => {
  let db: FakeDb
  let env: MockEnv

  const setup = (
    firstRoutes: [RegExp, (params: unknown[]) => Row | null][],
    allRoutes?: [RegExp, (params: unknown[]) => Row[]][],
    runRoutes?: [RegExp, (params: unknown[]) => Record<string, unknown> | undefined][]
  ) => {
    db = createFakeDb(firstRoutes, allRoutes, runRoutes)
    env = createEnv(db)
    return env
  }

  beforeEach(() => {
    resetRateLimit()
  })

  it('401s without a session', async () => {
    const res = await householdsApp.request(
      '/api/households',
      {},
      createEnv(createFakeDb([]), { props: undefined })
    )
    expect(res.status).toBe(401)
  })

  it('lists the user households with role, size, and active flag', async () => {
    setup(
      [],
      [
        [
          /FROM household_members m\s+JOIN households h/,
          () => [
            {
              id: 'h1',
              name: 'Keluarga Putri',
              created_at: '2026-11-01 00:00:00',
              role: 'owner',
              member_count: 4,
              is_active: 1,
            },
            {
              id: 'h2',
              name: 'Rumah Bunda',
              created_at: '2026-11-02 00:00:00',
              role: 'member',
              member_count: 2,
              is_active: 0,
            },
          ],
        ],
      ]
    )
    const res = await householdsApp.request('/api/households', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { households: Array<Record<string, unknown>> }
    expect(body.households).toHaveLength(2)
    expect(body.households[0]).toMatchObject({
      id: 'h1',
      role: 'owner',
      member_count: 4,
      is_active: true,
    })
    expect(body.households[1]).toMatchObject({ id: 'h2', role: 'member', is_active: false })
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
  })

  it('creates a household with the creator as owner and does not switch active', async () => {
    setup(
      [],
      [
        [
          // The read-back re-lists households; the id is the UUID the INSERT
          // just wrote, so the echo builds the row from the log.
          /FROM household_members m\s+JOIN households h/,
          () => {
            const inserted = db.log.find((e) => e.sql.startsWith('INSERT INTO households'))
            return [
              {
                id: inserted?.params[0],
                name: inserted?.params[1],
                created_at: '2026-11-03 00:00:00',
                role: 'owner',
                member_count: 1,
                is_active: 0,
              },
            ]
          },
        ],
      ]
    )
    const res = await householdsApp.request(
      '/api/households',
      {
        method: 'POST',
        body: JSON.stringify({ name: 'Kedua' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { household: Record<string, unknown> }
    expect(body.household).toMatchObject({ name: 'Kedua', role: 'owner', member_count: 1 })

    const inserted = db.log.map((e) => e.sql)
    expect(inserted.some((sql) => sql.startsWith('INSERT INTO households'))).toBe(true)
    // The creator's membership lands in the same batch, as 'owner' (with its
    // own surrogate member id — 0021).
    const membershipInsert = db.log.find((e) => e.sql.startsWith('INSERT INTO household_members'))
    expect(membershipInsert?.params).toEqual([expect.any(String), body.household.id, 'u1', 'owner'])
    // No user_settings write: creating never silently switches households.
    expect(inserted.some((sql) => sql.startsWith('UPDATE user_settings'))).toBe(false)
    // Seeds (locations + stores) ride the same batch as the login flow's.
    expect(db.log.filter((e) => e.sql.startsWith('INSERT INTO locations'))).toHaveLength(4)
    expect(db.log.filter((e) => e.sql.startsWith('INSERT INTO stores'))).toHaveLength(3)
  })

  it('rejects a create with an over-long name', async () => {
    setup([])
    const res = await householdsApp.request(
      '/api/households',
      {
        method: 'POST',
        body: JSON.stringify({ name: 'x'.repeat(81) }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(400)
  })

  it('renames a household when owner', async () => {
    setup(
      [[/FROM households h\s+JOIN household_members/, () => OWNER_MEMBERSHIP]],
      [
        [
          /FROM household_members m\s+JOIN households h/,
          () => [
            {
              id: 'h1',
              name: 'Rumah Baru',
              created_at: '2026-11-01 00:00:00',
              role: 'owner',
              member_count: 2,
              is_active: 1,
            },
          ],
        ],
      ]
    )
    const res = await householdsApp.request(
      '/api/households/h1',
      {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Rumah Baru' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
    const rename = db.log.find((e) => e.sql.startsWith('UPDATE households SET name'))
    expect(rename?.params[0]).toBe('Rumah Baru')
  })

  it('403s a member rename and 404s a non-member rename without leaking existence', async () => {
    setup([[/FROM households h\s+JOIN household_members/, () => MEMBER_MEMBERSHIP]])
    const forbidden = await householdsApp.request(
      '/api/households/h1',
      {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Nope' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(forbidden.status).toBe(403)

    setup([[/FROM households h\s+JOIN household_members/, () => null]])
    const missing = await householdsApp.request(
      '/api/households/whatever',
      {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Nope' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toEqual({ error: 'Household not found' })
  })

  it('activates a household the user belongs to and 404s one they do not', async () => {
    setup([[/FROM households h\s+JOIN household_members/, () => MEMBER_MEMBERSHIP]])
    const res = await householdsApp.request('/api/households/h1/activate', { method: 'POST' }, env)
    expect(res.status).toBe(200)
    const update = db.log.find((e) =>
      e.sql.startsWith('UPDATE user_settings SET active_household_id = ?')
    )
    expect(update?.params[0]).toBe('h1')

    setup([[/FROM households h\s+JOIN household_members/, () => null]])
    const missing = await householdsApp.request(
      '/api/households/nope/activate',
      { method: 'POST' },
      env
    )
    expect(missing.status).toBe(404)
  })

  it('lists members with profile fields for a member of the household', async () => {
    setup(
      // The membership gate runs BEFORE the roster is fetched (review B2).
      [[/FROM households h\s+JOIN household_members/, () => MEMBER_MEMBERSHIP]],
      [
        [
          /LEFT JOIN users u ON u\.id = m\.user_id\s+WHERE m\.household_id = \?\s+-- Owners/,
          () => [
            {
              id: 'm1',
              user_id: 'u1',
              role: 'owner',
              display_name: null,
              birth_date: null,
              joined_at: '2026-11-01 00:00:00',
              name: 'Alice',
              email: 'a@b.com',
              picture: null,
            },
            {
              id: 'm2',
              user_id: 'u2',
              role: 'member',
              display_name: 'Putri',
              birth_date: '2024-05-01',
              joined_at: '2026-11-02 00:00:00',
              name: 'putri@example.com',
              email: 'putri@example.com',
              picture: null,
            },
          ],
        ],
      ]
    )
    const res = await householdsApp.request('/api/households/h1/members', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { members: Array<Record<string, unknown>> }
    expect(body.members).toHaveLength(2)
    // Additive-nullish profile fields ride the member shape (BayiQ-ready).
    expect(body.members[1]).toMatchObject({
      id: 'm2',
      user_id: 'u2',
      display_name: 'Putri',
      birth_date: '2024-05-01',
      has_account: true,
    })
  })

  it('lists profile-only members alongside linked ones with the mode discriminator', async () => {
    setup(
      [[/FROM households h\s+JOIN household_members/, () => OWNER_MEMBERSHIP]],
      [
        [
          /LEFT JOIN users u ON u\.id = m\.user_id\s+WHERE m\.household_id = \?\s+-- Owners/,
          () => [
            {
              id: 'm1',
              user_id: 'u1',
              role: 'owner',
              display_name: null,
              birth_date: null,
              joined_at: '2026-11-01 00:00:00',
              name: 'Alice',
              email: 'a@b.com',
              picture: null,
            },
            {
              // Profile-only (Mode B, #388): no user row joins on.
              id: 'm9',
              user_id: null,
              role: 'member',
              display_name: 'Adik',
              birth_date: '2025-03-02',
              joined_at: '2026-11-03 00:00:00',
              name: null,
              email: null,
              picture: null,
            },
          ],
        ],
      ]
    )
    const res = await householdsApp.request('/api/households/h1/members', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { members: Array<Record<string, unknown>> }
    expect(body.members[1]).toMatchObject({
      id: 'm9',
      user_id: null,
      has_account: false,
      display_name: 'Adik',
      email: null,
    })
  })

  it('creates a profile-only member as owner with the role forced to member', async () => {
    setup([
      [/FROM households h\s+JOIN household_members/, () => OWNER_MEMBERSHIP],
      [
        /SELECT m\.id, m\.user_id[\s\S]*WHERE m\.id = \? AND m\.household_id = \?/,
        () => ({
          id: 'm-new',
          user_id: null,
          role: 'member',
          display_name: 'Adik',
          birth_date: '2025-03-02',
          joined_at: '2026-11-04 00:00:00',
          name: null,
          email: null,
          picture: null,
        }),
      ],
    ])
    const res = await householdsApp.request(
      '/api/households/h1/members',
      {
        method: 'POST',
        body: JSON.stringify({ display_name: '  Adik  ', birth_date: '2025-03-02' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { member: Record<string, unknown> }
    expect(body.member).toMatchObject({
      id: 'm-new',
      user_id: null,
      role: 'member',
      has_account: false,
      display_name: 'Adik',
      birth_date: '2025-03-02',
    })
    // The write itself encodes Mode B: user_id NULL and role 'member' are
    // SQL literals in the INSERT — a profile-only member can never own,
    // whatever the client sends.
    const insert = db.log.find((e) => e.sql.startsWith('INSERT INTO household_members'))
    expect(insert?.params).toEqual([expect.any(String), 'h1', 'Adik', '2025-03-02'])
    expect(insert?.sql).toContain("VALUES (?, ?, NULL, 'member', ?, ?)")
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
  })

  it('403s a non-owner creating a profile-only member and 400s invalid input', async () => {
    setup([[/FROM households h\s+JOIN household_members/, () => MEMBER_MEMBERSHIP]])
    const forbidden = await householdsApp.request(
      '/api/households/h1/members',
      {
        method: 'POST',
        body: JSON.stringify({ display_name: 'Adik' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(forbidden.status).toBe(403)
    expect(db.log.some((e) => e.sql.startsWith('INSERT INTO household_members'))).toBe(false)

    setup([[/FROM households h\s+JOIN household_members/, () => OWNER_MEMBERSHIP]])
    for (const body of [
      { display_name: '' },
      // Whitespace-only must fail the POST bounds (trim runs before
      // minLength), not land as an unnamed roster row.
      { display_name: '   ' },
      { display_name: 'x'.repeat(81) },
      { display_name: 'Adik', birth_date: '03/02/2025' },
      {},
    ]) {
      const bad = await householdsApp.request(
        '/api/households/h1/members',
        {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        },
        env
      )
      expect(bad.status).toBe(400)
    }
    expect(db.log.some((e) => e.sql.startsWith('INSERT INTO household_members'))).toBe(false)
  })

  it('404s the member list for a non-member without leaking the household', async () => {
    setup(
      // The membership gate rejects before the roster query ever runs.
      [[/FROM households h\s+JOIN household_members/, () => null]]
    )
    const res = await householdsApp.request('/api/households/h1/members', {}, env)
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'Household not found' })
  })

  it('lets a member edit their own profile and normalizes clears to NULL', async () => {
    setup([
      [/FROM households h\s+JOIN household_members/, () => MEMBER_MEMBERSHIP],
      [
        /SELECT id, user_id, role FROM household_members/,
        () => ({ id: 'm1', user_id: 'u1', role: 'member' }),
      ],
      [
        /SELECT m\.id, m\.user_id[\s\S]*WHERE m\.id = \? AND m\.household_id = \?/,
        () => ({
          id: 'm1',
          user_id: 'u1',
          role: 'member',
          display_name: 'Mama',
          birth_date: '1995-01-01',
          joined_at: '',
          name: 'Alice',
          email: 'a@b.com',
          picture: null,
        }),
      ],
    ])
    const res = await householdsApp.request(
      '/api/households/h1/members/m1',
      {
        method: 'PATCH',
        body: JSON.stringify({ display_name: '  Mama  ', birth_date: '1995-01-01' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
    const update = db.log.find((e) => e.sql.startsWith('UPDATE household_members SET'))
    expect(update?.params.slice(0, 2)).toEqual(['Mama', '1995-01-01'])

    const clear = await householdsApp.request(
      '/api/households/h1/members/m1',
      {
        method: 'PATCH',
        body: JSON.stringify({ display_name: '', birth_date: '' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(clear.status).toBe(200)
    const cleared = db.log.filter((e) => e.sql.startsWith('UPDATE household_members SET'))
    expect(cleared[1]?.params.slice(0, 2)).toEqual([null, null])
  })

  it('blocks a member editing someone else but allows an owner', async () => {
    setup([
      [/FROM households h\s+JOIN household_members/, () => MEMBER_MEMBERSHIP],
      // The target lookup runs before the authorization answer (no leak, no
      // write) — the route then 403s the non-owner.
      [
        /SELECT id, user_id, role FROM household_members/,
        () => ({ id: 'm2', user_id: 'u2', role: 'member' }),
      ],
    ])
    const res = await householdsApp.request(
      '/api/households/h1/members/m2',
      {
        method: 'PATCH',
        body: JSON.stringify({ display_name: 'Nope' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(403)
    expect(db.log.some((e) => e.sql.startsWith('UPDATE household_members SET'))).toBe(false)

    setup([
      [/FROM households h\s+JOIN household_members/, () => OWNER_MEMBERSHIP],
      [
        /SELECT id, user_id, role FROM household_members/,
        () => ({ id: 'm2', user_id: 'u2', role: 'member' }),
      ],
      [
        /SELECT m\.id, m\.user_id[\s\S]*WHERE m\.id = \? AND m\.household_id = \?/,
        () => ({
          id: 'm2',
          user_id: 'u2',
          role: 'member',
          display_name: 'X',
          birth_date: null,
          joined_at: '',
          name: null,
          email: null,
          picture: null,
        }),
      ],
    ])
    const ok = await householdsApp.request(
      '/api/households/h1/members/m2',
      {
        method: 'PATCH',
        body: JSON.stringify({ display_name: 'Putri' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(ok.status).toBe(200)
  })

  it('makes a profile-only member owner-only to patch, even for plain members', async () => {
    // A profile-only member has no "self" — a plain member gets the same 403
    // an owner-row edit would give (ahaqqu/RumaQ#388).
    setup([
      [/FROM households h\s+JOIN household_members/, () => MEMBER_MEMBERSHIP],
      [
        /SELECT id, user_id, role FROM household_members/,
        () => ({ id: 'm9', user_id: null, role: 'member' }),
      ],
    ])
    const res = await householdsApp.request(
      '/api/households/h1/members/m9',
      {
        method: 'PATCH',
        body: JSON.stringify({ display_name: 'Nope' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(403)
    expect(db.log.some((e) => e.sql.startsWith('UPDATE household_members SET'))).toBe(false)

    setup([
      [/FROM households h\s+JOIN household_members/, () => OWNER_MEMBERSHIP],
      [
        /SELECT id, user_id, role FROM household_members/,
        () => ({ id: 'm9', user_id: null, role: 'member' }),
      ],
      [
        /SELECT m\.id, m\.user_id[\s\S]*WHERE m\.id = \? AND m\.household_id = \?/,
        () => ({
          id: 'm9',
          user_id: null,
          role: 'member',
          display_name: 'Adik',
          birth_date: null,
          joined_at: '',
          name: null,
          email: null,
          picture: null,
        }),
      ],
    ])
    const ok = await householdsApp.request(
      '/api/households/h1/members/m9',
      {
        method: 'PATCH',
        body: JSON.stringify({ display_name: 'Adik Kecil' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(ok.status).toBe(200)
  })

  it('400s a malformed birth_date and 404s an unknown target member', async () => {
    setup([[/FROM households h\s+JOIN household_members/, () => MEMBER_MEMBERSHIP]])
    const badDate = await householdsApp.request(
      '/api/households/h1/members/m1',
      {
        method: 'PATCH',
        body: JSON.stringify({ birth_date: '01/02/1995' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(badDate.status).toBe(400)

    setup([
      [/FROM households h\s+JOIN household_members/, () => MEMBER_MEMBERSHIP],
      // The target lookup misses: the target member is not part of this
      // household, so the lib must refuse before any write.
      [/SELECT id, user_id, role FROM household_members/, () => null],
    ])
    const res = await householdsApp.request(
      '/api/households/h1/members/m1',
      {
        method: 'PATCH',
        body: JSON.stringify({ display_name: 'Mama' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    // No UPDATE may run against a member that is not in the household.
    expect(db.log.some((e) => e.sql.startsWith('UPDATE household_members SET'))).toBe(false)
    expect(res.status).toBe(404)
  })

  it('removes a member when owner and repoints their settings', async () => {
    setup([
      [/FROM households h\s+JOIN household_members/, () => OWNER_MEMBERSHIP],
      [
        /SELECT id, user_id, role FROM household_members/,
        () => ({ id: 'm2', user_id: 'u2', role: 'member' }),
      ],
      OWNER_COUNT_ONE,
      // The removed member still belongs to h2 — the repoint targets it.
      [
        /SELECT household_id FROM household_members\s+WHERE user_id = \? AND household_id != \?/,
        () => ({ household_id: 'h2' }),
      ],
    ])
    const res = await householdsApp.request(
      '/api/households/h1/members/m2',
      { method: 'DELETE' },
      env
    )
    expect(res.status).toBe(204)
    expect(db.log.some((e) => e.sql.startsWith('DELETE FROM household_members'))).toBe(true)
    // Repoint: bound params, not a subquery — the remaining household was
    // resolved before the batch so the whole departure commits atomically.
    const repoint = db.log.find(
      (e) =>
        e.sql.startsWith('UPDATE user_settings SET active_household_id = ?') &&
        e.sql.includes('active_household_id = ?') &&
        e.params.length === 3
    )
    expect(repoint?.params).toEqual(['h2', 'u2', 'h1'])
  })

  it('removes a profile-only member with a bare delete and no session work', async () => {
    // Mode B removal (#388): no user account, so no user_settings pointer and
    // no departure-repoint/respawn semantics — one atomic DELETE, nothing else.
    setup([
      [/FROM households h\s+JOIN household_members/, () => OWNER_MEMBERSHIP],
      [
        /SELECT id, user_id, role FROM household_members/,
        () => ({ id: 'm9', user_id: null, role: 'member' }),
      ],
    ])
    const res = await householdsApp.request(
      '/api/households/h1/members/m9',
      { method: 'DELETE' },
      env
    )
    expect(res.status).toBe(204)
    const statements = db.log.map((e) => e.sql)
    expect(
      statements.filter((sql) => sql.startsWith('DELETE FROM household_members'))
    ).toHaveLength(1)
    expect(statements.some((sql) => sql.startsWith('UPDATE user_settings'))).toBe(false)
    expect(statements.some((sql) => sql.startsWith('INSERT INTO households'))).toBe(false)
    expect(statements.some((sql) => sql.startsWith('INSERT INTO household_members'))).toBe(false)
  })

  it('409s removing the last owner and 403s a member removing anyone', async () => {
    setup([
      [/FROM households h\s+JOIN household_members/, () => OWNER_MEMBERSHIP],
      [
        /SELECT id, user_id, role FROM household_members/,
        () => ({ id: 'm1', user_id: 'u1', role: 'owner' }),
      ],
      OWNER_COUNT_ONE,
    ])
    const res = await householdsApp.request(
      '/api/households/h1/members/m1',
      { method: 'DELETE' },
      env
    )
    expect(res.status).toBe(409)
    expect(db.log.some((e) => e.sql.startsWith('DELETE FROM household_members'))).toBe(false)

    setup([[/FROM households h\s+JOIN household_members/, () => MEMBER_MEMBERSHIP]])
    const forbidden = await householdsApp.request(
      '/api/households/h1/members/m3',
      { method: 'DELETE' },
      env
    )
    expect(forbidden.status).toBe(403)
  })

  it('lets a member leave, blocks the last owner, respawns a household when none remain', async () => {
    setup([
      [/FROM households h\s+JOIN household_members/, () => MEMBER_MEMBERSHIP],
      OWNER_COUNT_TWO,
      // No membership outside h1 -> the respawn branch of the departure batch.
      [
        /SELECT household_id FROM household_members\s+WHERE user_id = \? AND household_id != \?/,
        () => null,
      ],
    ])
    const res = await householdsApp.request('/api/households/h1/leave', { method: 'POST' }, env)
    expect(res.status).toBe(200)
    expect(db.log.some((e) => e.sql.startsWith('DELETE FROM household_members'))).toBe(true)
    // No household left -> fresh baseline household, owner membership, seeds.
    expect(db.log.some((e) => e.sql.startsWith('INSERT INTO households'))).toBe(true)
    const membership = db.log.find((e) => e.sql.startsWith('INSERT INTO household_members'))
    expect(membership?.params).toEqual([expect.any(String), expect.any(String), 'u1', 'owner'])
    const settings = db.log.filter((e) =>
      e.sql.startsWith('UPDATE user_settings SET active_household_id = ?')
    )
    expect(settings.length).toBeGreaterThan(0)

    setup([[/FROM households h\s+JOIN household_members/, () => OWNER_MEMBERSHIP], OWNER_COUNT_ONE])
    const blocked = await householdsApp.request('/api/households/h1/leave', { method: 'POST' }, env)
    expect(blocked.status).toBe(409)
    expect(db.log.some((e) => e.sql.startsWith('DELETE FROM household_members'))).toBe(false)
  })

  it('returns the live invite to owners and 403s members', async () => {
    // The code is stored encrypted at rest (review A8); the owner GET
    // decrypts with WORKER_ENCRYPTION_KEY. The fake row carries a real
    // ciphertext so the round trip is exercised, not assumed.
    const codeEncrypted = await encryptAiKey('ABC2345678', 'test-enc-key')
    setup([
      [/FROM households h\s+JOIN household_members/, () => OWNER_MEMBERSHIP],
      [
        /SELECT id, code_encrypted, created_at, expires_at FROM household_invites/,
        () => ({
          id: 'inv1',
          code_encrypted: codeEncrypted,
          created_at: '2026-11-01 00:00:00',
          expires_at: '2026-11-08 00:00:00',
        }),
      ],
    ])
    const res = await householdsApp.request('/api/households/h1/invite', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { invite: Record<string, unknown> | null }
    expect(body.invite).toMatchObject({ id: 'inv1', code: 'ABC2345678' })

    setup([[/FROM households h\s+JOIN household_members/, () => MEMBER_MEMBERSHIP]])
    const forbidden = await householdsApp.request('/api/households/h1/invite', {}, env)
    expect(forbidden.status).toBe(403)
  })

  it('returns invite:null when no live code exists', async () => {
    setup([
      [/FROM households h\s+JOIN household_members/, () => OWNER_MEMBERSHIP],
      [/SELECT id, code_encrypted, created_at, expires_at FROM household_invites/, () => null],
    ])
    const res = await householdsApp.request('/api/households/h1/invite', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { invite: unknown }
    expect(body.invite).toBeNull()
  })

  it('rotates the invite code, revoking the previous one in the same batch', async () => {
    const codeEncrypted = await encryptAiKey('DEF2345678', 'test-enc-key')
    setup([
      [/FROM households h\s+JOIN household_members/, () => OWNER_MEMBERSHIP],
      [
        /SELECT id, code_encrypted, created_at, expires_at FROM household_invites/,
        () => ({
          id: 'inv2',
          code_encrypted: codeEncrypted,
          created_at: '2026-11-03 00:00:00',
          expires_at: '2026-11-10 00:00:00',
        }),
      ],
    ])
    const res = await householdsApp.request('/api/households/h1/invite', { method: 'POST' }, env)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { invite: { code: string } }
    expect(body.invite.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/)
    const revoke = db.log.find((e) => e.sql.startsWith('UPDATE household_invites SET revoked_at'))
    expect(revoke?.params[0]).toBe('h1')
    // At rest: the plaintext code is never written — hash + ciphertext only.
    const insert = db.log.find((e) => e.sql.startsWith('INSERT INTO household_invites'))
    expect(insert?.params).toHaveLength(5)
    expect(String(insert?.params[2])).toMatch(/^[0-9a-f]{64}$/)
    expect(insert?.sql).toContain('code_hash, code_encrypted')
    // Expiry arithmetic stays in SQL so the stored format matches the
    // datetime('now') comparison in the validity checks.
    expect(insert?.sql).toContain('+7 days')
  })

  it('joins by code as a member, normalizing presentation', async () => {
    setup([
      [
        /SELECT id, household_id FROM household_invites/,
        () => ({ id: 'inv1', household_id: 'h2' }),
      ],
      [/SELECT id, name FROM households WHERE id = \?/, () => ({ id: 'h2', name: 'Rumah Bunda' })],
    ])
    const res = await householdsApp.request(
      '/api/households/join',
      {
        method: 'POST',
        body: JSON.stringify({ code: ' abc-234 5678 ' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { household: { id: string }; already_member: boolean }
    expect(body).toEqual({ household: { id: 'h2', name: 'Rumah Bunda' }, already_member: false })
    // Idempotency is storage-level (review A7): the insert always runs; the
    // partial unique index (0021) decides membership, not a pre-check that
    // can race. The joined member gets a surrogate id and role member.
    const insert = db.log.find((e) => e.sql.startsWith('INSERT INTO household_members'))
    expect(insert?.params).toEqual([expect.any(String), 'h2', 'u1', 'member'])
    expect(insert?.sql).toContain(
      'ON CONFLICT (household_id, user_id) WHERE user_id IS NOT NULL DO NOTHING'
    )
  })

  it('is idempotent for an existing member and answers already_member', async () => {
    setup(
      [
        [
          /SELECT id, household_id FROM household_invites/,
          () => ({ id: 'inv1', household_id: 'h2' }),
        ],
        [
          /SELECT id, name FROM households WHERE id = \?/,
          () => ({ id: 'h2', name: 'Rumah Bunda' }),
        ],
      ],
      [],
      // meta.changes === 0 = the conflict path fired (already a member).
      [[/INSERT INTO household_members/, () => ({ meta: { changes: 0 } })]]
    )
    const res = await householdsApp.request(
      '/api/households/join',
      {
        method: 'POST',
        body: JSON.stringify({ code: 'ABC2345678' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { already_member: boolean }
    expect(body.already_member).toBe(true)
    expect(db.log.some((e) => e.sql.startsWith('INSERT INTO household_members'))).toBe(true)
  })

  it('gives unknown, revoked, expired, and malformed codes the same answer', async () => {
    setup([[/SELECT id, household_id FROM household_invites/, () => null]])
    for (const code of ['ZZZ9999999', 'short']) {
      const res = await householdsApp.request(
        '/api/households/join',
        {
          method: 'POST',
          body: JSON.stringify({ code }),
          headers: { 'Content-Type': 'application/json' },
        },
        env
      )
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual({ error: 'Invalid or expired invite code' })
    }
  })

  it('rate-limits code guessing per user', async () => {
    resetRateLimit()
    setup([[/SELECT id, household_id FROM household_invites/, () => null]])
    let limitedRes: Response | null = null
    for (let i = 0; i < 11; i++) {
      const res = await householdsApp.request(
        '/api/households/join',
        {
          method: 'POST',
          body: JSON.stringify({ code: 'ZZZ9999999' }),
          headers: { 'Content-Type': 'application/json' },
        },
        env
      )
      if (i < 10) expect(res.status).toBe(400)
      if (res.status === 429) limitedRes = res
    }
    expect(limitedRes).not.toBeNull()
    expect(limitedRes?.headers.get('Retry-After')).toBeTruthy()
  })
})

describe('gateway dispatch', () => {
  it('routes /api/households to the households app', async () => {
    const db = createFakeDb(
      [],
      [
        [
          /FROM household_members m\s+JOIN households h/,
          () => [
            {
              id: 'h1',
              name: 'Keluarga Putri',
              created_at: '2026-11-01 00:00:00',
              role: 'owner',
              member_count: 1,
              is_active: 1,
            },
          ],
        ],
      ]
    )
    const ctx = { exports: undefined } as unknown as ExecutionContext
    const res = await gateway.fetch(
      new Request('http://localhost/api/households'),
      createEnv(db) as unknown as Parameters<typeof gateway.fetch>[1],
      ctx
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { households: unknown[] }
    expect(body.households).toHaveLength(1)
  })
})

// The hardened active-household resolution (ahaqqu/RumaQ#331): the session
// cookie path must re-check that active_household_id is still a membership —
// a removed member with a stale pointer must not keep access.
describe('propsAuthMiddleware cookie path', () => {
  const jwt = (sub: string) => signJwt({ sub, exp: Date.now() + 60_000 }, 'test-secret')

  it('401s when the user has no household membership at all', async () => {
    const db = createFakeDb([[/COALESCE/, () => ({ household_id: null })]])
    const token = await jwt('u1')
    const res = await householdsApp.request(
      '/api/households',
      { headers: { Cookie: `rumaq_session=${token}` } },
      createEnv(db, { props: undefined })
    )
    expect(res.status).toBe(401)
  })

  it('resolves the household through the COALESCE membership query and serves the route', async () => {
    const db = createFakeDb(
      [[/COALESCE/, () => ({ household_id: 'h-active' })]],
      [[/FROM household_members m\s+JOIN households h/, () => []]]
    )
    const token = await jwt('u1')
    const res = await householdsApp.request(
      '/api/households',
      { headers: { Cookie: `rumaq_session=${token}` } },
      createEnv(db, { props: undefined })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { households: unknown[] }
    expect(Array.isArray(body.households)).toBe(true)
  })
})
