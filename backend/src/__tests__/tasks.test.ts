import { describe, it, expect, beforeEach, vi } from 'vite-plus/test'
import { tasksApp } from '../apps/tasks.js'
import { resetRateLimit } from '../lib/rate-limit.js'
import type { MockEnv } from './support/env.js'

// The task endpoints run 2-4 queries per request (task lookup, caller member
// row, write, read-back), so ordered mockResolvedValueOnce chains would couple
// every test to call order. This file routes the fake D1 on SQL fragments
// (firstRoutes/allRoutes — the households.test.ts idiom) and records every
// executed statement (log) so tests assert on WHAT was written, not when.
// The task-row lookup route FOLDS the log (a tiny storage engine): the base
// row — or the INSERT the flow wrote — is the starting state and every UPDATE
// in the log applies its setters, so a read-back after a mutation reflects
// the write exactly as real D1 would answer it. The real-SQL semantics
// (household predicate, member modes, SET NULL cascades, audit-outlives-task)
// are pinned separately in tasks-sql.test.ts.

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
// linked member (m-ayah, account u2), om is another linked member with no
// relation to any task, and Adik is the profile-only kid (m-anak, no user).
const CALLER_ROWS: Record<string, Row> = {
  u1: { id: 'm-ibu', role: 'owner' },
  u2: { id: 'm-ayah', role: 'member' },
  u3: { id: 'm-om', role: 'member' },
}

const ASSIGNEE_USER: Record<string, string | null> = {
  'm-anak': null,
  'm-ayah': 'u2',
  'm-ibu': 'u1',
}

const CALLER_ROUTE: [RegExp, (params: unknown[]) => Row | null] = [
  /SELECT id, role FROM household_members WHERE household_id = \? AND user_id = \?/,
  (params) => CALLER_ROWS[String(params[1])] ?? null,
]

const MEMBER_ROUTE: [RegExp, (params: unknown[]) => Row | null] = [
  /SELECT id, user_id FROM household_members WHERE id = \? AND household_id = \?/,
  (params) => {
    // Adik (profile-only) and the linked members are addressable in h1.
    if (params[0] === 'm-anak') return { id: 'm-anak', user_id: null }
    if (params[0] === 'm-ayah') return { id: 'm-ayah', user_id: 'u2' }
    if (params[0] === 'm-ibu') return { id: 'm-ibu', user_id: 'u1' }
    return null
  },
]

// needs_approval comes back from SQLite as INTEGER 0/1 — the route converts.
const OPEN_TASK_KID = {
  id: 't1',
  household_id: 'h1',
  title: 'Sapu halaman',
  assignee_member_id: 'm-anak',
  assignee_user_id: null, // profile-only kid — nobody's self
  created_by_member_id: 'm-ibu',
  due_date: '2026-11-10',
  recurrence: null,
  status: 'open',
  needs_approval: 1,
  approved_by_member_id: null,
  created_at: '2026-11-05 00:00:00',
  updated_at: '2026-11-05 00:00:00',
}

const OPEN_TASK_AYAH = {
  ...OPEN_TASK_KID,
  id: 't2',
  title: 'Bayar listrik',
  assignee_member_id: 'm-ayah',
  assignee_user_id: 'u2', // linked — the assignee-self path
  needs_approval: 0,
}

const DONE_KID_TASK = {
  ...OPEN_TASK_KID,
  id: 't3',
  status: 'done',
}

const RECURRING_KID_TASK = {
  ...OPEN_TASK_KID,
  id: 't4',
  recurrence: 'daily',
}

describe('tasks routes', () => {
  let db!: FakeDb

  // The scoped task lookup, folding the statement log: an INSERT in the log
  // mints the row (params: id, household, title, assignee, creator, due,
  // recurrence, needs_approval), and every UPDATE applies its setters in
  // order — '?' setters consume a bound param, literal setters don't.
  const taskRoute = (base: Row | null): [RegExp, (params: unknown[]) => Row | null] => [
    /FROM household_tasks t LEFT JOIN household_members am ON am\.id = t\.assignee_member_id WHERE t\.id = \? AND t\.household_id = \?/,
    () => {
      let row: Record<string, unknown> | null = base ? { ...base } : null
      if (!row) {
        const insert = db.log.find((e) => e.sql.startsWith('INSERT INTO household_tasks'))
        if (!insert) return null
        const p = insert.params as Array<string | number | null>
        row = {
          id: p[0],
          household_id: p[1],
          title: p[2],
          assignee_member_id: p[3],
          assignee_user_id: ASSIGNEE_USER[String(p[3])] ?? null,
          created_by_member_id: p[4],
          due_date: p[5],
          recurrence: p[6],
          status: 'open',
          needs_approval: p[7],
          approved_by_member_id: null,
          created_at: '2026-11-05 00:00:00',
          updated_at: '2026-11-05 00:00:00',
        }
      }
      for (const entry of db.log) {
        if (!entry.sql.startsWith('UPDATE household_tasks SET')) continue
        const setPart = entry.sql.slice(
          'UPDATE household_tasks SET'.length,
          entry.sql.indexOf(' WHERE')
        )
        let idx = 0
        for (const setter of setPart.split(', ')) {
          const s = setter.trim()
          if (s.endsWith('= ?')) {
            const column = s.slice(0, -3).trim()
            row[column] = entry.params[idx++]
            if (column === 'assignee_member_id') {
              // The lib's join column follows the assignee — derived
              // needs_approval reads it (toTaskRow).
              row.assignee_user_id = ASSIGNEE_USER[String(row.assignee_member_id)] ?? null
            }
          } else if (s === 'approved_by_member_id = NULL') {
            row.approved_by_member_id = null
          } else if (s === "status = 'done'") {
            row.status = 'done'
          } else if (s === "updated_at = datetime('now')") {
            row.updated_at = '2026-11-06 00:00:00'
          }
        }
      }
      return row
    },
  ]

  const BOARD_ROUTE = (rows: Row[]): [RegExp, (params: unknown[]) => Row[]] => [
    /FROM household_tasks t LEFT JOIN household_members am ON am\.id = t\.assignee_member_id/,
    (params) => {
      listParams = params
      return rows
    },
  ]

  let listParams: unknown[] = []

  const setup = (base: Row | null) => {
    db = createFakeDb([CALLER_ROUTE, MEMBER_ROUTE, taskRoute(base)])
    return createEnv(db)
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
  })

  it('401s without a session on every method', async () => {
    const env = createEnv(
      createFakeDb([CALLER_ROUTE, MEMBER_ROUTE, taskRoute(OPEN_TASK_KID)]),
      'u1',
      {
        props: undefined,
      }
    )
    for (const [method, path] of [
      ['GET', '/api/tasks'],
      ['POST', '/api/tasks'],
      ['PATCH', '/api/tasks/t1'],
      ['DELETE', '/api/tasks/t1'],
    ] as const) {
      const res = await tasksApp.request(path, { method } as RequestInit, env)
      expect(res.status).toBe(401)
    }
  })

  it('lists the household board (no per-member read hiding) with cache headers', async () => {
    db = createFakeDb(
      [CALLER_ROUTE, taskRoute(null)],
      [BOARD_ROUTE([OPEN_TASK_KID, OPEN_TASK_AYAH, DONE_KID_TASK])]
    )
    // A plain member-role account sees the WHOLE household board — the #429
    // read-scope decision (kids' visibility rides the shared family device).
    const res = await tasksApp.request('/api/tasks', {}, createEnv(db, 'u2'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
    const body = (await res.json()) as { tasks: Array<Record<string, unknown>> }
    expect(body.tasks).toHaveLength(3)
    expect(body.tasks[0]).toMatchObject({
      id: 't1',
      status: 'open',
      needs_approval: true, // the INTEGER 0/1 column is projected as boolean
    })
    // The internal join column never leaves the lib.
    expect(JSON.stringify(body.tasks)).not.toContain('assignee_user_id')
    // The household predicate rides in every read.
    expect(listParams[0]).toBe('h1')
  })

  it('resolves assignee=me and mine=1 to the caller member row and passes other filters through', async () => {
    db = createFakeDb([CALLER_ROUTE, taskRoute(null)], [BOARD_ROUTE([OPEN_TASK_AYAH])])
    const env = createEnv(db, 'u2')

    await tasksApp.request('/api/tasks?assignee=me', {}, env)
    expect(listParams[0]).toBe('h1')
    expect(listParams[1]).toBe('m-ayah') // 'me' → the caller's surrogate id

    await tasksApp.request('/api/tasks?mine=1&status=open', {}, env)
    expect(listParams[0]).toBe('h1')
    expect(listParams[1]).toBe('m-ayah')
    expect(listParams[2]).toBe('open')

    // An arbitrary member id passes through as a read filter (an unknown id
    // simply filters to empty — not a probe).
    await tasksApp.request('/api/tasks?assignee=m-anak', {}, env)
    expect(listParams[1]).toBe('m-anak')

    // assignee=all (or absent) does not filter at all.
    await tasksApp.request('/api/tasks?assignee=all', {}, env)
    expect(listParams[1]).toBeUndefined()
  })

  it('rejects invalid list filters with 400', async () => {
    const env = setup(null)
    const res = await tasksApp.request('/api/tasks?status=bogus', {}, env)
    expect(res.status).toBe(400)
  })

  it('creates a task assigned to the profile-only kid with derived needs_approval and the create audit row in the same batch', async () => {
    const env = setup(null)
    const res = await tasksApp.request(
      '/api/tasks',
      jsonRequest('POST', {
        title: '  Sapu halaman  ',
        assignee_member_id: 'm-anak',
        due_date: '2026-11-10',
        recurrence: null,
      }),
      env
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { task: Record<string, unknown> }
    expect(body.task).toMatchObject({
      title: 'Sapu halaman', // trimmed
      assignee_member_id: 'm-anak',
      status: 'open',
      needs_approval: true,
    })

    const insert = db.log.find((e) => e.sql.startsWith('INSERT INTO household_tasks'))
    expect(insert?.params).toEqual([
      expect.any(String), // id
      'h1', // household predicate
      'Sapu halaman',
      'm-anak',
      'm-ibu', // created_by = the caller's member row
      '2026-11-10',
      null,
      1, // needs_approval derived: profile-only assignee
    ])
    // The audit row rides the SAME batch — the vault's in-transaction rule.
    const audit = db.log.find((e) => e.sql.startsWith('INSERT INTO household_task_audit'))
    expect(audit?.params).toEqual([expect.any(String), insert?.params[0], 'h1', 'u1', 'create'])
  })

  it('creates an unassigned task without the approval flag, by a plain linked member', async () => {
    setup(null)
    // Any linked member can create (#429) — household role 'member' included.
    const res = await tasksApp.request(
      '/api/tasks',
      jsonRequest('POST', { title: 'Beli sabun' }),
      createEnv(db, 'u2')
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { task: Record<string, unknown> }
    expect(body.task).toMatchObject({
      title: 'Beli sabun',
      assignee_member_id: null,
      needs_approval: false,
      created_by_member_id: 'm-ayah',
    })
    const insert = db.log.find((e) => e.sql.startsWith('INSERT INTO household_tasks'))
    expect(insert?.params[3]).toBeNull()
    expect(insert?.params[7]).toBe(0)
  })

  it('400s an unknown assignee before any write', async () => {
    const env = setup(null)
    const res = await tasksApp.request(
      '/api/tasks',
      jsonRequest('POST', { title: 'Sembarang', assignee_member_id: 'm-foreign' }),
      env
    )
    expect(res.status).toBe(400)
    expect(db.log.some((e) => e.sql.startsWith('INSERT INTO household_tasks'))).toBe(false)
  })

  it('400s invalid create payloads (blank title, overlong title, bad recurrence, bad date)', async () => {
    const env = setup(null)
    const cases: Array<Record<string, unknown>> = [
      { title: '   ' },
      { title: 'a'.repeat(121) },
      { title: 'Ok', recurrence: 'yearly' },
      { title: 'Ok', due_date: '2024-13-45' },
      // A real-calendar check rides isoDate (thermos A5): format-valid but
      // impossible dates must 400 before any write — the roll-forward would
      // otherwise silently normalize Feb 31 to Mar 3.
      { title: 'Ok', due_date: '2026-02-31' },
      { nope: true },
    ]
    for (const body of cases) {
      const res = await tasksApp.request('/api/tasks', jsonRequest('POST', body), env)
      expect(res.status).toBe(400)
    }
    expect(db.log.filter((e) => e.sql.startsWith('INSERT INTO household_tasks'))).toHaveLength(0)
  })

  it('completes a one-shot task by the linked assignee themselves', async () => {
    setup(OPEN_TASK_AYAH)
    const res = await tasksApp.request(
      '/api/tasks/t2',
      jsonRequest('PATCH', { status: 'done' }),
      createEnv(db, 'u2')
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: Record<string, unknown> }
    expect(body.task).toMatchObject({ id: 't2', status: 'done' })

    const update = db.log.find((e) => e.sql.startsWith('UPDATE household_tasks'))
    expect(update?.sql).toContain("status = 'done'")
    // Bind order: the setter params, then id + household predicate, then the
    // optimistic anchor (the task's pre-read due date).
    expect(update?.params).toEqual(['t2', 'h1', '2026-11-10'])
    const audit = db.log.find((e) => e.sql.startsWith('INSERT INTO household_task_audit'))
    expect(audit?.params[4]).toBe('complete')
  })

  it('lets an owner complete on behalf of the profile-only kid, but refuses an unrelated member', async () => {
    // Owner (ibu) completing her kid's chore — the on-behalf path.
    const ownerEnv = setup(OPEN_TASK_KID)
    const ownerRes = await tasksApp.request(
      '/api/tasks/t1',
      jsonRequest('PATCH', { status: 'done' }),
      ownerEnv
    )
    expect(ownerRes.status).toBe(200)
    expect(
      db.log.find((e) => e.sql.startsWith('INSERT INTO household_task_audit'))?.params[4]
    ).toBe('complete')

    // om (a member with no relation to the task) is refused — not assignee,
    // not creator, not owner.
    setup(OPEN_TASK_KID)
    const otherRes = await tasksApp.request(
      '/api/tasks/t1',
      jsonRequest('PATCH', { status: 'done' }),
      createEnv(db, 'u3')
    )
    expect(otherRes.status).toBe(403)
    expect(db.log.some((e) => e.sql.startsWith('UPDATE household_tasks'))).toBe(false)
    expect(db.log.some((e) => e.sql.startsWith('INSERT INTO household_task_audit'))).toBe(false)
  })

  it('rolls a recurring task to its next due date instead of flipping status', async () => {
    const env = setup(RECURRING_KID_TASK)
    const res = await tasksApp.request(
      '/api/tasks/t4',
      jsonRequest('PATCH', { status: 'done' }),
      env
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: Record<string, unknown> }
    expect(body.task.status).toBe('open') // the chore repeats — never rests done

    const update = db.log.find((e) => e.sql.startsWith('UPDATE household_tasks'))
    expect(update?.sql).toContain('due_date = ?')
    expect(update?.sql).not.toContain("status = 'done'")
    // The roll-forward clears any prior approval — the next cycle starts fresh.
    expect(update?.sql).toContain('approved_by_member_id = NULL')
    expect(update?.params[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(update?.params[1]).toBe('t4')
    expect(update?.params[2]).toBe('h1')
  })

  it('409s a second completion of a done task', async () => {
    const env = setup(DONE_KID_TASK)
    const res = await tasksApp.request(
      '/api/tasks/t3',
      jsonRequest('PATCH', { status: 'done' }),
      env
    )
    expect(res.status).toBe(409)
    expect(db.log.some((e) => e.sql.startsWith('UPDATE household_tasks'))).toBe(false)
  })

  it('anchors the completion day on the household calendar (UTC+7): a chore completed at 00:30 WIB rolls to the correct next day', async () => {
    // 2026-11-07T17:30:00Z is 2026-11-08 00:30 WIB — plain UTC would anchor
    // completedOn on Nov 7 and the daily chore due Nov 7 would come back
    // "due today" after having been done (thermos A3).
    vi.useFakeTimers({ now: new Date('2026-11-07T17:30:00Z') })
    try {
      const dueTodayDaily = {
        ...OPEN_TASK_KID,
        id: 't5',
        due_date: '2026-11-07',
        recurrence: 'daily',
      }
      const env = setup(dueTodayDaily)
      const res = await tasksApp.request(
        '/api/tasks/t5',
        jsonRequest('PATCH', { status: 'done' }),
        env
      )
      expect(res.status).toBe(200)
      const update = db.log.find((e) => e.sql.startsWith('UPDATE household_tasks'))
      // completedOn = 2026-11-08 (WIB) → next due 2026-11-09. The UTC bug
      // would have answered 2026-11-08 — due again the same morning.
      expect(update?.params[0]).toBe('2026-11-09')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses reassigning a done one-shot task with a typed 400 (thermos A4)', async () => {
    const env = setup(DONE_KID_TASK)
    const res = await tasksApp.request(
      '/api/tasks/t3',
      jsonRequest('PATCH', { assignee_member_id: 'm-ayah' }),
      env
    )
    expect(res.status).toBe(400)
    // Nothing moved: no write, no audit row.
    expect(db.log.some((e) => e.sql.startsWith('UPDATE household_tasks'))).toBe(false)
    expect(db.log.some((e) => e.sql.startsWith('INSERT INTO household_task_audit'))).toBe(false)
  })

  it('approves a done, approval-needing task by the creator and by an owner; both audit rows land', async () => {
    for (const userId of ['u1', 'u2']) {
      // u2 is ayah — give him creator provenance so the creator path is the
      // one under test for him (the issue's "assigner approves").
      const task = { ...DONE_KID_TASK, created_by_member_id: userId === 'u2' ? 'm-ayah' : 'm-ibu' }
      setup(task)
      const res = await tasksApp.request(
        '/api/tasks/t3',
        jsonRequest('PATCH', { approve: true }),
        createEnv(db, userId)
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { task: Record<string, unknown> }
      expect(body.task).toMatchObject({ approved_by_member_id: CALLER_ROWS[userId]!.id })
      const update = db.log.find((e) => e.sql.startsWith('UPDATE household_tasks'))
      expect(update?.params).toEqual([CALLER_ROWS[userId]!.id, 't3', 'h1'])
      expect(
        db.log.find((e) => e.sql.startsWith('INSERT INTO household_task_audit'))?.params[4]
      ).toBe('approve')
    }
  })

  it('refuses approval for a task that is open or does not need it (linked assignee)', async () => {
    const doneKidTask = {
      ...DONE_KID_TASK,
      id: 't1', // the PATCH path pins t1 in both cases
      status: 'open',
    }
    const doneLinkedTask = {
      ...DONE_KID_TASK,
      id: 't1',
      // needs_approval derives from the assignee mode: a linked assignee
      // (ayah) never needs the approval step.
      assignee_member_id: 'm-ayah',
      assignee_user_id: 'u2',
    }
    for (const task of [doneKidTask, doneLinkedTask]) {
      const env = setup(task)
      const res = await tasksApp.request(
        '/api/tasks/t1',
        jsonRequest('PATCH', { approve: true }),
        env
      )
      expect(res.status).toBe(409)
      expect(db.log.some((e) => e.sql.startsWith('UPDATE household_tasks'))).toBe(false)
    }
  })

  it('403s approval by a member with no relation to the task', async () => {
    setup(DONE_KID_TASK)
    const res = await tasksApp.request(
      '/api/tasks/t3',
      jsonRequest('PATCH', { approve: true }),
      createEnv(db, 'u3')
    )
    expect(res.status).toBe(403)
    expect(db.log.some((e) => e.sql.startsWith('UPDATE household_tasks'))).toBe(false)
  })

  it('keeps complete and approve standalone — mixing either with edits is a 400', async () => {
    const env = setup(OPEN_TASK_KID)
    const mixed1 = await tasksApp.request(
      '/api/tasks/t1',
      jsonRequest('PATCH', { approve: true, title: 'Baru' }),
      env
    )
    const mixed2 = await tasksApp.request(
      '/api/tasks/t1',
      jsonRequest('PATCH', { status: 'done', title: 'Baru' }),
      env
    )
    expect(mixed1.status).toBe(400)
    expect(mixed2.status).toBe(400)
    expect(db.log.some((e) => e.sql.startsWith('UPDATE household_tasks'))).toBe(false)
  })

  it('edits fields by the creator and by an owner; a non-creator member is refused', async () => {
    const creatorEnv = setup(OPEN_TASK_KID)
    const creatorRes = await tasksApp.request(
      '/api/tasks/t1',
      jsonRequest('PATCH', { title: 'Sapu halaman depan', due_date: '2026-11-12' }),
      creatorEnv
    )
    expect(creatorRes.status).toBe(200)
    const body = (await creatorRes.json()) as { task: Record<string, unknown> }
    expect(body.task).toMatchObject({ title: 'Sapu halaman depan', due_date: '2026-11-12' })
    const creatorUpdate = db.log.find((e) => e.sql.startsWith('UPDATE household_tasks'))
    expect(creatorUpdate?.sql).toContain('title = ?')
    expect(creatorUpdate?.sql).toContain('due_date = ?')
    expect(creatorUpdate?.params).toContain('Sapu halaman depan')
    expect(
      db.log.find((e) => e.sql.startsWith('INSERT INTO household_task_audit'))?.params[4]
    ).toBe('update')

    const ownerEnv = setup(OPEN_TASK_AYAH)
    const ownerRes = await tasksApp.request(
      '/api/tasks/t2',
      jsonRequest('PATCH', { recurrence: 'weekly' }),
      ownerEnv
    )
    expect(ownerRes.status).toBe(200)
    const ownerBody = (await ownerRes.json()) as { task: Record<string, unknown> }
    expect(ownerBody.task.recurrence).toBe('weekly')

    setup(OPEN_TASK_KID)
    const otherRes = await tasksApp.request(
      '/api/tasks/t1',
      jsonRequest('PATCH', { title: 'Tidak boleh' }),
      createEnv(db, 'u3')
    )
    expect(otherRes.status).toBe(403)
    expect(db.log.some((e) => e.sql.startsWith('UPDATE household_tasks'))).toBe(false)
  })

  it('reassigns with needs_approval re-derived and approval cleared — creator or owner only', async () => {
    const ownerEnv = setup(OPEN_TASK_KID)
    const res = await tasksApp.request(
      '/api/tasks/t1',
      jsonRequest('PATCH', { assignee_member_id: 'm-ayah' }),
      ownerEnv
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: Record<string, unknown> }
    expect(body.task).toMatchObject({ assignee_member_id: 'm-ayah', needs_approval: false })
    const update = db.log.find((e) => e.sql.startsWith('UPDATE household_tasks'))
    expect(update?.sql).toContain('assignee_member_id = ?')
    expect(update?.sql).toContain('needs_approval = ?')
    expect(update?.sql).toContain('approved_by_member_id = NULL')

    // om is neither creator nor owner — no reassignment.
    setup(OPEN_TASK_KID)
    const otherRes = await tasksApp.request(
      '/api/tasks/t1',
      jsonRequest('PATCH', { assignee_member_id: 'm-ayah' }),
      createEnv(db, 'u3')
    )
    expect(otherRes.status).toBe(403)
    expect(db.log.some((e) => e.sql.startsWith('UPDATE household_tasks'))).toBe(false)
  })

  it('unassigns with null and treats a re-submitted identical assignee as a no-op read', async () => {
    const unassignEnv = setup(OPEN_TASK_KID)
    const unassignRes = await tasksApp.request(
      '/api/tasks/t1',
      jsonRequest('PATCH', { assignee_member_id: null }),
      unassignEnv
    )
    expect(unassignRes.status).toBe(200)
    expect(db.log.some((e) => e.sql.startsWith('UPDATE household_tasks'))).toBe(true)

    // Same assignee again → no write, no audit row (an empty patch reads back).
    const noopEnv = setup(OPEN_TASK_KID)
    const noopRes = await tasksApp.request(
      '/api/tasks/t1',
      jsonRequest('PATCH', { assignee_member_id: 'm-anak' }),
      noopEnv
    )
    expect(noopRes.status).toBe(200)
    const body = (await noopRes.json()) as { task: Record<string, unknown> }
    expect(body.task.id).toBe('t1')
    expect(db.log.some((e) => e.sql.startsWith('UPDATE household_tasks'))).toBe(false)
    expect(db.log.some((e) => e.sql.startsWith('INSERT INTO household_task_audit'))).toBe(false)

    // Fully empty patch — the households no-op-read precedent.
    const emptyEnv = setup(OPEN_TASK_KID)
    const emptyRes = await tasksApp.request('/api/tasks/t1', jsonRequest('PATCH', {}), emptyEnv)
    expect(emptyRes.status).toBe(200)
    expect(db.log.some((e) => e.sql.startsWith('UPDATE household_tasks'))).toBe(false)
  })

  it('400s an unknown assignee on edit before any write', async () => {
    const env = setup(OPEN_TASK_KID)
    const res = await tasksApp.request(
      '/api/tasks/t1',
      jsonRequest('PATCH', { assignee_member_id: 'm-foreign' }),
      env
    )
    expect(res.status).toBe(400)
    expect(db.log.some((e) => e.sql.startsWith('UPDATE household_tasks'))).toBe(false)
  })

  it('404s edits on a task from another household exactly like a missing one', async () => {
    // The scoped lookup carries the household predicate, so a foreign id is
    // just "not found" (the fake returns null — the real-SQL predicate proof
    // lives in tasks-sql.test.ts).
    const env = setup(null)
    const patchRes = await tasksApp.request(
      '/api/tasks/t-foreign',
      jsonRequest('PATCH', { title: 'Baru' }),
      env
    )
    const deleteRes = await tasksApp.request('/api/tasks/t-foreign', { method: 'DELETE' }, env)
    expect(patchRes.status).toBe(404)
    expect(deleteRes.status).toBe(404)
    expect(db.log.some((e) => e.sql.startsWith('UPDATE household_tasks'))).toBe(false)
  })

  it('deletes by creator or owner, with the delete audit row written before the delete in the same batch', async () => {
    for (const userId of ['u1', 'u2']) {
      const task = { ...OPEN_TASK_AYAH, created_by_member_id: userId === 'u2' ? 'm-ayah' : 'm-ibu' }
      setup(task)
      const res = await tasksApp.request(
        '/api/tasks/t2',
        { method: 'DELETE' },
        createEnv(db, userId)
      )
      expect(res.status).toBe(204)
      const auditIdx = db.log.findIndex((e) => e.sql.startsWith('INSERT INTO household_task_audit'))
      const deleteIdx = db.log.findIndex((e) => e.sql.startsWith('DELETE FROM household_tasks'))
      expect(auditIdx).toBeGreaterThanOrEqual(0)
      expect(deleteIdx).toBeGreaterThan(auditIdx)
      expect(
        db.log.find((e) => e.sql.startsWith('INSERT INTO household_task_audit'))?.params[4]
      ).toBe('delete')
    }
  })

  it('refuses a delete by a member with no relation to the task', async () => {
    setup(OPEN_TASK_KID)
    const res = await tasksApp.request('/api/tasks/t1', { method: 'DELETE' }, createEnv(db, 'u3'))
    expect(res.status).toBe(403)
    expect(db.log.some((e) => e.sql.startsWith('DELETE FROM household_tasks'))).toBe(false)
    expect(db.log.some((e) => e.sql.startsWith('INSERT INTO household_task_audit'))).toBe(false)
  })
})
