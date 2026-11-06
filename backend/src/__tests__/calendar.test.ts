import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { calendarApp } from '../apps/calendar.js'
import { resetRateLimit } from '../lib/rate-limit.js'
import type { MockEnv } from './support/env.js'

// The calendar endpoints run 3-6 queries per request (caller member row, event
// lookup, audience rows, writes, read-back), so ordered mockResolvedValueOnce
// chains would couple every test to call order. This file routes the fake D1
// on SQL fragments (firstRoutes/allRoutes — the tasks.test.ts idiom) and
// records every executed statement (log) so tests assert on WHAT was written,
// not when. The event lookup route FOLDS the log (a tiny storage engine): the
// base row — or the INSERT the flow wrote — is the starting state and every
// UPDATE applies its setters, so a read-back after a mutation reflects the
// write exactly as real D1 would answer it. The real-SQL semantics (household
// predicate, visibility rows, cascades, audit-outlives-event, the deadline
// derivation) are pinned separately in calendar-sql.test.ts.

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
  allRoutes: [RegExp, (params: unknown[]) => Row[]][] = []
): FakeDb {
  const log: Array<{ sql: string; params: unknown[] }> = []
  return {
    log,
    prepare: (sql: string) => {
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
            return undefined
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

function createEnv(db: FakeDb, userId = 'u1', overrides: Partial<MockEnv> = {}): MockEnv {
  return {
    DB: db as unknown as MockEnv['DB'],
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
    props: { userId, householdId: 'h1' },
    TEST_MODE: 'true',
    ...overrides,
  }
}

// The household roster used across the tests: ibu owns h1 (m-ibu), ayah is a
// linked member (m-ayah, account u2), and Adik is the profile-only kid
// (m-anak, no user — an event AUDIENCE, never a caller).
const CALLER_ROWS: Record<string, Row> = {
  u1: { id: 'm-ibu', role: 'owner' },
  u2: { id: 'm-ayah', role: 'member' },
  u3: { id: 'm-om', role: 'member' },
}

const CALLER_ROUTE: [RegExp, (params: unknown[]) => Row | null] = [
  /SELECT id, role FROM household_members WHERE household_id = \? AND user_id = \?/,
  (params) => CALLER_ROWS[String(params[1])] ?? null,
]

const MEMBER_ROUTE: [RegExp, (params: unknown[]) => Row | null] = [
  /SELECT id FROM household_members WHERE id = \? AND household_id = \?/,
  (params) => {
    // Adik (profile-only) and the linked members are addressable in h1.
    if (['m-anak', 'm-ayah', 'm-ibu'].includes(String(params[0]))) {
      return { id: String(params[0]) }
    }
    return null
  },
]

// visibility comes back from SQLite as TEXT — the fake carries the column as
// stored.
const ALL_EVENT = {
  id: 'e1',
  household_id: 'h1',
  title: 'Kontrol dokter',
  event_date: '2026-11-15',
  event_time: '09:30',
  visibility: 'all',
  created_by_member_id: 'm-ibu',
  created_at: '2026-11-05 00:00:00',
  updated_at: '2026-11-05 00:00:00',
}

const MEMBERS_EVENT = {
  ...ALL_EVENT,
  id: 'e2',
  title: 'KTP ayah expired',
  event_date: '2026-11-20',
  event_time: null,
  visibility: 'members',
  created_by_member_id: 'm-ayah',
}

const DOC_EXPIRY = {
  id: 'd1',
  name: 'STNK Bapak',
  member_id: 'm-ibu',
  expires_on: '2026-11-25',
  remind_days_before: 30,
}

describe('calendar routes', () => {
  let db!: FakeDb
  let listParams: unknown[] = []

  // The audience table in the fake storage engine — keyed by event id.
  const AUDIENCE: Record<string, string[]> = {
    e2: ['m-ibu', 'm-anak'],
  }

  // The audience rows for one event, folding the statement log: the base map
  // is the starting state, DELETEs clear it, INSERTs (plain or gated) add —
  // the tiny storage engine, same idea as the event fold.
  const audienceOf = (eventId: string): string[] => {
    const list = [...(AUDIENCE[String(eventId)] ?? [])]
    for (const entry of db.log) {
      if (entry.sql.startsWith('DELETE FROM household_calendar_event_members')) {
        if (String(entry.params[0]) === String(eventId)) list.length = 0
      } else if (entry.sql.startsWith('INSERT INTO household_calendar_event_members')) {
        const p = entry.params as string[]
        if (String(p[0]) === String(eventId) && !list.includes(String(p[1]))) {
          list.push(String(p[1]))
        }
      }
    }
    return list.sort()
  }

  // The household OWNER always reads (the third predicate arm — lib's
  // VISIBLE_PREDICATE): the owner administers the household's data, so a
  // restricted event can never become unmanageable. CALLER_ROWS holds the
  // roles; find the row whose id matches the viewer.
  const isOwnerViewer = (viewerMemberId: string): boolean =>
    Object.values(CALLER_ROWS).some((row) => row.id === viewerMemberId && row.role === 'owner')

  // The scoped event lookup, folding the statement log: an INSERT in the log
  // mints the row (params: id, household, title, date, time, visibility,
  // creator), and every UPDATE applies its setters in order — '?' setters
  // consume a bound param, literal setters don't. The base row only answers
  // ITS OWN id (a foreign id is not found — no leak).
  const eventRoute = (base: Row | null): [RegExp, (params: unknown[]) => Row | null] => [
    /FROM household_calendar_events e WHERE e\.id = \? AND e\.household_id = \? AND \(e\.visibility/,
    (params) => {
      const requested = String(params[0])
      let row: Record<string, unknown> | null = null
      if (base && String(base.id) === requested) row = { ...base }
      if (!row) {
        const insert = db.log.find(
          (e) =>
            e.sql.startsWith('INSERT INTO household_calendar_events') &&
            String(e.params[0]) === requested
        )
        if (insert) {
          const p = insert.params as Array<string | number | null>
          row = {
            id: p[0],
            household_id: p[1],
            title: p[2],
            event_date: p[3],
            event_time: p[4],
            visibility: p[5],
            created_by_member_id: p[6],
            created_at: '2026-11-06 00:00:00',
            updated_at: '2026-11-06 00:00:00',
          }
        }
      }
      if (!row) return null
      for (const entry of db.log) {
        if (!entry.sql.startsWith('UPDATE household_calendar_events SET')) continue
        const setPart = entry.sql.slice(
          'UPDATE household_calendar_events SET'.length,
          entry.sql.indexOf(' WHERE')
        )
        let idx = 0
        for (const setter of setPart.split(', ')) {
          const s = setter.trim()
          if (s.endsWith('= ?')) {
            const column = s.slice(0, -3).trim()
            row[column] = entry.params[idx++]
          } else if (s === "updated_at = datetime('now')") {
            row.updated_at = '2026-11-06 00:00:00'
          }
        }
      }
      // The visibility predicate: an event row answers only when the caller
      // (params[2] = viewer member id) may read it.
      const viewer = String(params[2])
      const readable =
        row.visibility === 'all' ||
        row.created_by_member_id === viewer ||
        audienceOf(requested).includes(viewer) ||
        isOwnerViewer(viewer)
      return readable ? row : null
    },
  ]

  const audienceRoute = (): [RegExp, (params: unknown[]) => Row[]] => [
    /FROM household_calendar_event_members WHERE event_id IN/,
    (params) => {
      const rows: Row[] = []
      for (const eventId of params as string[]) {
        for (const memberId of audienceOf(String(eventId))) {
          rows.push({ event_id: eventId, member_id: memberId })
        }
      }
      return rows
    },
  ]

  const listRoute = (rows: Row[]): [RegExp, (params: unknown[]) => Row[]] => [
    /FROM household_calendar_events e WHERE e\.household_id = \? AND/,
    (params) => {
      listParams = params
      return rows.filter((row) => {
        if (row.household_id !== params[0]) return false
        const viewer = String(params[1])
        const readable =
          row.visibility === 'all' ||
          row.created_by_member_id === viewer ||
          audienceOf(String(row.id)).includes(viewer) ||
          isOwnerViewer(viewer)
        if (!readable) return false
        // Window binds follow [household, viewer x3, from?, to?] (the owner
        // arm adds a third viewer bind) — both bounds or none in these tests.
        const from = params.length >= 6 ? params[params.length - 2] : undefined
        const to = params.length >= 6 ? params[params.length - 1] : undefined
        if (from !== undefined && String(row.event_date) < String(from)) return false
        if (to !== undefined && String(row.event_date) > String(to)) return false
        return true
      })
    },
  ]

  const docsRoute = (rows: Row[]): [RegExp, (params: unknown[]) => Row[]] => [
    /FROM documents WHERE household_id = \? AND expires_on IS NOT NULL/,
    (params) => {
      const from = params[1]
      const to = params[2]
      return rows.filter((row) => {
        if (from !== undefined && String(row.expires_on) < String(from)) return false
        if (to !== undefined && String(row.expires_on) > String(to)) return false
        return true
      })
    },
  ]

  const setup = (
    base: Row | null,
    allRoutes: [RegExp, (params: unknown[]) => Row[]][] = [],
    userId = 'u1'
  ) => {
    db = createFakeDb([CALLER_ROUTE, MEMBER_ROUTE, eventRoute(base)], allRoutes)
    return createEnv(db, userId)
  }

  const jsonRequest = (method: string, body: unknown) =>
    ({
      method,
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }) as RequestInit

  beforeEach(() => {
    resetRateLimit()
    listParams = []
    for (const key of Object.keys(AUDIENCE)) delete AUDIENCE[key]
    AUDIENCE.e2 = ['m-ibu', 'm-anak']
  })

  it('401s without a session on every method', async () => {
    const env = createEnv(createFakeDb([CALLER_ROUTE, MEMBER_ROUTE, eventRoute(ALL_EVENT)]), 'u1', {
      props: undefined,
    })
    for (const [method, path] of [
      ['GET', '/api/calendar'],
      ['POST', '/api/calendar/events'],
      ['PATCH', '/api/calendar/events/e1'],
      ['DELETE', '/api/calendar/events/e1'],
    ] as const) {
      const res = await calendarApp.request(path, { method } as RequestInit, env)
      expect(res.status).toBe(401)
    }
  })

  it('serves the union view: events the viewer may read + derived deadlines, day-ordered', async () => {
    const env = setup(null, [
      listRoute([ALL_EVENT, MEMBERS_EVENT]),
      audienceRoute(),
      docsRoute([DOC_EXPIRY]),
    ])
    const res = await calendarApp.request(
      '/api/calendar?from=2026-11-01&to=2026-11-30',
      { method: 'GET' } as RequestInit,
      env
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: Array<Record<string, unknown>> }
    // e2 is 'members' with the viewer (ibu) listed; ayah's creator row — ibu is
    // in the audience. The deadline derives with its due_soon window.
    expect(body.entries.map((e) => e.id)).toEqual(['e1', 'e2', 'doc:d1'])
    expect(body.entries[0]).toMatchObject({ kind: 'event', time: '09:30' })
    expect(body.entries[1]).toMatchObject({
      kind: 'event',
      member_ids: ['m-anak', 'm-ibu'],
    })
    expect(body.entries[2]).toMatchObject({
      kind: 'deadline',
      document_id: 'd1',
      title: 'STNK Bapak',
      date: '2026-11-25',
    })
    // The computed distance is a real number driven by the wall clock (the
    // route does not pin it) — exact boundary numbers are pinned in
    // calendar-lib.test.ts / calendar-sql.test.ts on injectable `now`.
    expect(typeof body.entries[2].days_until_expiry).toBe('number')
    expect(typeof body.entries[2].due_soon).toBe('boolean')
    // The household predicate and the viewer id (x3 — audience + creator +
    // owner arms) bind FIRST, then the window.
    expect(listParams).toEqual(['h1', 'm-ibu', 'm-ibu', 'm-ibu', '2026-11-01', '2026-11-30'])
  })

  it('hides a members-event the viewer is neither creator nor audience of', async () => {
    AUDIENCE.e2 = ['m-anak']
    const env = setup(
      null,
      [listRoute([ALL_EVENT, MEMBERS_EVENT]), audienceRoute(), docsRoute([])],
      'u3'
    ) // om — linked, but unrelated
    const res = await calendarApp.request('/api/calendar', { method: 'GET' } as RequestInit, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: Array<Record<string, unknown>> }
    expect(body.entries.map((e) => e.id)).toEqual(['e1'])
  })

  it('400s a reversed or malformed window before any query', async () => {
    const env = setup(null)
    for (const query of ['?to=2026-11-30&from=2026-12-01', '?from=2026-02-31', '?from=soon']) {
      const res = await calendarApp.request(
        `/api/calendar${query}`,
        { method: 'GET' } as RequestInit,
        env
      )
      expect(res.status).toBe(400)
    }
    expect(db.log).toHaveLength(0)
  })

  it('403s a caller whose member row is missing (fail-closed)', async () => {
    const env = setup(null, [], 'u-ghost')
    const res = await calendarApp.request('/api/calendar', { method: 'GET' } as RequestInit, env)
    expect(res.status).toBe(403)
  })

  it('creates an event: event row first, then audience rows, then the audit — one batch', async () => {
    const env = setup(null, [audienceRoute()])
    const res = await calendarApp.request(
      '/api/calendar/events',
      jsonRequest('POST', {
        title: 'Mudik checklist',
        date: '2026-12-18',
        time: null,
        visibility: 'members',
        member_ids: ['m-ayah', 'm-anak', 'm-ayah'],
      }),
      env
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { event: Record<string, unknown> }
    expect(body.event).toMatchObject({
      kind: 'event',
      title: 'Mudik checklist',
      date: '2026-12-18',
      time: null,
      visibility: 'members',
      member_ids: ['m-anak', 'm-ayah'], // deduped, sorted by the audience read
      created_by_member_id: 'm-ibu',
    })
    const inserts = db.log.filter((e) => e.sql.startsWith('INSERT INTO household_calendar'))
    expect(inserts.map((e) => (e.sql.match(/INSERT INTO (\w+)/) as RegExpMatchArray)[1])).toEqual([
      'household_calendar_events',
      'household_calendar_event_members',
      'household_calendar_event_members',
      'household_calendar_event_audit',
    ])
    // The audit row names the actor and the create action.
    const audit = inserts.at(-1)
    expect(audit?.params).toEqual([expect.any(String), expect.any(String), 'h1', 'u1', 'create'])
  })

  it('defaults visibility to all and clears the audience field', async () => {
    const env = setup(null)
    const res = await calendarApp.request(
      '/api/calendar/events',
      jsonRequest('POST', { title: 'Halan tahun baru', date: '2026-12-31' }),
      env
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { event: Record<string, unknown> }
    expect(body.event).toMatchObject({ visibility: 'all', member_ids: null, time: null })
    expect(db.log.filter((e) => e.sql.includes('household_calendar_event_members'))).toHaveLength(0)
  })

  it('400s the create cross-field rules and bad inputs before any write', async () => {
    const env = setup(null)
    const cases: Array<Record<string, unknown>> = [
      { date: '2026-12-01' }, // no title
      { title: '   ', date: '2026-12-01' }, // whitespace-only
      { title: 'x'.repeat(121), date: '2026-12-01' }, // over bound
      { title: 'No date' }, // missing date
      { title: 'Bad date', date: '2026-02-31' }, // impossible calendar date
      { title: 'Bad time', date: '2026-12-01', time: '24:00' },
      { title: 'Bad time', date: '2026-12-01', time: '9:30' }, // not zero-padded
      { title: 'Bogus vis', date: '2026-12-01', visibility: 'family' },
      { title: 'Members need list', date: '2026-12-01', visibility: 'members' },
      { title: 'Empty list', date: '2026-12-01', visibility: 'members', member_ids: [] },
      { title: 'List under all', date: '2026-12-01', member_ids: ['m-ayah'] },
      {
        title: 'Foreign member',
        date: '2026-12-01',
        visibility: 'members',
        member_ids: ['m-elsewhere'],
      },
      { extra: 'key', title: 'Strict', date: '2026-12-01' }, // unknown key
    ]
    for (const body of cases) {
      const res = await calendarApp.request('/api/calendar/events', jsonRequest('POST', body), env)
      expect(res.status).toBe(400)
    }
    // No writes anywhere — validation happens before the batch.
    expect(db.log).toHaveLength(0)
  })

  it('edits fields: guarded UPDATE + gated audit, no audience churn', async () => {
    const env = setup(MEMBERS_EVENT, [audienceRoute()])
    const res = await calendarApp.request(
      '/api/calendar/events/e2',
      jsonRequest('PATCH', { title: 'KTP ayah — perpanjang', time: '08:00' }),
      env
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { event: Record<string, unknown> }
    expect(body.event).toMatchObject({
      title: 'KTP ayah — perpanjang',
      time: '08:00',
      member_ids: ['m-anak', 'm-ibu'],
    })
    expect(
      db.log.filter((e) => e.sql.startsWith('UPDATE household_calendar_events SET'))
    ).toHaveLength(1)
    expect(
      db.log.filter((e) => e.sql.startsWith('INSERT INTO household_calendar_event_audit'))
    ).toHaveLength(1)
    // No audience statements — an edit that leaves the audience alone must not
    // delete/re-insert it.
    expect(
      db.log.filter((e) => e.sql.startsWith('DELETE FROM household_calendar_event_members'))
    ).toHaveLength(0)
  })

  it('replaces the audience atomically and validates the references', async () => {
    const env = setup(MEMBERS_EVENT, [audienceRoute()])
    const res = await calendarApp.request(
      '/api/calendar/events/e2',
      jsonRequest('PATCH', { member_ids: ['m-anak'] }),
      env
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { event: Record<string, unknown> }
    expect(body.event.member_ids).toEqual(['m-anak'])
    expect(
      db.log.filter((e) => e.sql.startsWith('DELETE FROM household_calendar_event_members'))
    ).toHaveLength(1)
    // The gated INSERT..SELECT shape (exists-guarded audience rows).
    const gated = db.log.filter(
      (e) =>
        e.sql.startsWith('INSERT INTO household_calendar_event_members') &&
        e.sql.includes('WHERE EXISTS')
    )
    expect(gated).toHaveLength(1)
  })

  it('flips visibility to all and clears the audience rows', async () => {
    const env = setup(MEMBERS_EVENT, [audienceRoute()])
    const res = await calendarApp.request(
      '/api/calendar/events/e2',
      jsonRequest('PATCH', { visibility: 'all' }),
      env
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { event: Record<string, unknown> }
    expect(body.event).toMatchObject({ visibility: 'all', member_ids: null })
    expect(
      db.log.filter((e) => e.sql.startsWith('DELETE FROM household_calendar_event_members'))
    ).toHaveLength(1)
    expect(
      db.log.filter((e) => e.sql.startsWith('INSERT INTO household_calendar_event_members'))
    ).toHaveLength(0)
  })

  it('400s ambiguous audience edits and a depleted re-affirmation', async () => {
    const env = setup(MEMBERS_EVENT, [audienceRoute()])
    // member_ids while the result resolves to 'all' — ambiguous, 400.
    const res1 = await calendarApp.request(
      '/api/calendar/events/e2',
      jsonRequest('PATCH', { visibility: 'all', member_ids: ['m-ayah'] }),
      env
    )
    expect(res1.status).toBe(400)
    // Unknown member reference.
    const res2 = await calendarApp.request(
      '/api/calendar/events/e2',
      jsonRequest('PATCH', { member_ids: ['m-elsewhere'] }),
      env
    )
    expect(res2.status).toBe(400)
    // Empty replacement.
    const res3 = await calendarApp.request(
      '/api/calendar/events/e2',
      jsonRequest('PATCH', { member_ids: [] }),
      env
    )
    expect(res3.status).toBe(400)
    // Depleted audience re-affirmed as-is: member removal cascaded every row
    // away, so re-affirming 'members' without a new list is a 400.
    AUDIENCE.e2 = []
    const res4 = await calendarApp.request(
      '/api/calendar/events/e2',
      jsonRequest('PATCH', { visibility: 'members' }),
      env
    )
    expect(res4.status).toBe(400)
    // Bad time / date shapes.
    const res5 = await calendarApp.request(
      '/api/calendar/events/e2',
      jsonRequest('PATCH', { time: '25:00' }),
      env
    )
    expect(res5.status).toBe(400)
    expect(
      db.log.filter((e) => e.sql.startsWith('UPDATE household_calendar_events SET'))
    ).toHaveLength(0)
  })

  it('answers 404 for a foreign/restricted event before reading the body', async () => {
    const env = setup(ALL_EVENT, [audienceRoute()], 'u3') // om cannot see e2; e1 is ALL so visible
    // om PATCHes e1 (visible, but not creator/owner) → 403, not 404.
    const res1 = await calendarApp.request(
      '/api/calendar/events/e1',
      jsonRequest('PATCH', { title: 'hijack' }),
      env
    )
    expect(res1.status).toBe(403)
    // om PATCHes e2 — ayah's members-event om is not in → 404 (no leak).
    const res2 = await calendarApp.request(
      '/api/calendar/events/e2',
      jsonRequest('PATCH', { title: 'hijack' }),
      env
    )
    expect(res2.status).toBe(404)
    // ...same for DELETE.
    const res3 = await calendarApp.request(
      '/api/calendar/events/e2',
      { method: 'DELETE' } as RequestInit,
      env
    )
    expect(res3.status).toBe(404)
  })

  it('403s a listed-but-non-manager audience member', async () => {
    // ayah (u2) is IN e1's audience? No — e1 is ALL, so ayah sees it; but ayah
    // is neither creator nor owner → the manager check refuses with 403.
    const env = setup(ALL_EVENT, [audienceRoute()], 'u2')
    const res = await calendarApp.request(
      '/api/calendar/events/e1',
      jsonRequest('PATCH', { title: 'my edit' }),
      env
    )
    expect(res.status).toBe(403)
    expect(
      db.log.filter((e) => e.sql.startsWith('UPDATE household_calendar_events SET'))
    ).toHaveLength(0)
  })

  it('no-op patch returns the current event without a write', async () => {
    const env = setup(ALL_EVENT)
    const res = await calendarApp.request('/api/calendar/events/e1', jsonRequest('PATCH', {}), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { event: Record<string, unknown> }
    expect(body.event).toMatchObject({ id: 'e1', title: 'Kontrol dokter' })
    expect(
      db.log.filter((e) => e.sql.startsWith('UPDATE household_calendar_events SET'))
    ).toHaveLength(0)
    expect(
      db.log.filter((e) => e.sql.startsWith('INSERT INTO household_calendar_event_audit'))
    ).toHaveLength(0)
  })

  it('clears the time back to all-day with an explicit null', async () => {
    const env = setup(ALL_EVENT)
    const res = await calendarApp.request(
      '/api/calendar/events/e1',
      jsonRequest('PATCH', { time: null }),
      env
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { event: Record<string, unknown> }
    expect(body.event.time).toBeNull()
  })

  it('deletes: the gated audit rides BEFORE the delete in the same batch', async () => {
    const env = setup(MEMBERS_EVENT, [audienceRoute()])
    const res = await calendarApp.request(
      '/api/calendar/events/e2',
      { method: 'DELETE' } as RequestInit,
      env
    )
    expect(res.status).toBe(204)
    // The gated audit runs FIRST (both statements evaluate the same pre-state
    // inside the batch), then the delete — the deletion record survives the
    // row it names (no FK on audit.event_id).
    expect(db.log[0].sql.startsWith('INSERT INTO household_calendar_event_audit')).toBe(true)
    expect(db.log[1].sql.startsWith('DELETE FROM household_calendar_events')).toBe(true)
    const audit = db.log[0]
    // Gated INSERT..SELECT: uuid, event, household, actor, action, then the
    // EXISTS re-check (event + household).
    expect(audit.params).toEqual([expect.any(String), 'e2', 'h1', 'u1', 'delete', 'e2', 'h1'])
  })

  it('lets an owner delete an event they did not create', async () => {
    // e2 was created by ayah (m-ayah); ibu (u1) is the owner → allowed.
    const env = setup(MEMBERS_EVENT, [audienceRoute()], 'u1')
    const res = await calendarApp.request(
      '/api/calendar/events/e2',
      { method: 'DELETE' } as RequestInit,
      env
    )
    expect(res.status).toBe(204)
  })

  it('refuses a creator-less (creator removed) event to a non-owner', async () => {
    const orphan = { ...ALL_EVENT, created_by_member_id: null }
    const env = setup(orphan, [], 'u2')
    const res = await calendarApp.request(
      '/api/calendar/events/e1',
      jsonRequest('PATCH', { title: 'x' }),
      env
    )
    expect(res.status).toBe(403)
    const res2 = await calendarApp.request(
      '/api/calendar/events/e1',
      { method: 'DELETE' } as RequestInit,
      env
    )
    expect(res2.status).toBe(403)
  })

  it('404s a malformed event id shape the same as a missing one', async () => {
    const env = setup(null)
    const res = await calendarApp.request(
      '/api/calendar/events/nope',
      { method: 'DELETE' } as RequestInit,
      env
    )
    expect(res.status).toBe(404)
    const res2 = await calendarApp.request(
      '/api/calendar/events/nope',
      jsonRequest('PATCH', { title: 'x' }),
      env
    )
    expect(res2.status).toBe(404)
  })
})
