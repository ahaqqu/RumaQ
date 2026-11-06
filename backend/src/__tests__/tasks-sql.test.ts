import { describe, it, expect } from 'vite-plus/test'
// Real-SQL coverage for household tasks (ahaqqu/RumaQ#429), following the
// documents-sql.test.ts pattern: the route tests route a fake D1 on SQL
// fragments — good for HTTP shapes, blind to actual storage behavior. This
// file runs the SAME statements the lib runs against a real SQLite engine
// (node:sqlite — D1 is SQLite) through the full migration chain, so the
// security-relevant semantics cannot drift from the schema:
//
//   - the household scope predicate: a foreign household's task is invisible
//     to every lookup (list, get) and unreachable through another household's
//     authorization,
//   - the member relation accepts BOTH modes (linked + profile-only, 0021)
//     and drives the DERIVED needs_approval flag,
//   - the completion flows: assignee-self, on-behalf for the kid, the
//     recurring roll-forward re-opening the task, the approval guard,
//   - the audit trail: one row per mutation, written in the same batch, and
//     OUTLIVING the deleted task row (no FK on task_id).
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

import {
  approveTask,
  completeTask,
  createTask,
  deleteTask,
  getCallerMember,
  getHouseholdMember,
  getTaskRow,
  listTasks,
  updateTask,
  TaskConflictError,
  TaskForbiddenError,
  TaskNotFoundError,
  TaskValidationError,
} from '../lib/tasks.js'

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

// A D1-shaped adapter over node:sqlite — only the surface the tasks lib uses:
// prepare().bind().first/all/run and batch(), wrapped in a transaction so the
// audit + write batches' atomicity claim is exercised, not assumed.
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

// The standard roster: ibu owns h1 (linked, u1), ayah is a linked member
// (u2), om is an unrelated linked member (u3), Adik is the profile-only kid.
// h2 is another household (owned by u3) for the cross-household probes.
function seed(sqlite: Db): void {
  sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'ibu@b.com')").run()
  sqlite.prepare("INSERT INTO users (id, email) VALUES ('u2', 'ayah@b.com')").run()
  sqlite.prepare("INSERT INTO users (id, email) VALUES ('u3', 'om@b.com')").run()
  sqlite
    .prepare(`INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`)
    .run()
  sqlite
    .prepare(`INSERT INTO households (id, name, created_by) VALUES ('h2', 'Rumah Lain', 'u3')`)
    .run()
  const member = sqlite.prepare(
    `INSERT INTO household_members (id, household_id, user_id, role, display_name)
     VALUES (?, ?, ?, ?, ?)`
  )
  member.run('m-ibu', 'h1', 'u1', 'owner', 'Ibu')
  member.run('m-ayah', 'h1', 'u2', 'member', 'Ayah')
  member.run('m-om', 'h1', 'u3', 'member', 'Om')
  // Mode B: the kid with no account — the #429 core use case.
  member.run('m-anak', 'h1', null, 'member', 'Adik')
  member.run('m-om-h2', 'h2', 'u3', 'owner', 'Om')
}

function auditActions(
  sqlite: Db,
  taskId: string
): Array<{ action: string; actor_user_id: string }> {
  // Insert order (rowid) — created_at shares datetime('now')'s second
  // granularity, so ordering on it + a random UUID id would be nondeterministic.
  return sqlite
    .prepare(
      `SELECT action, actor_user_id FROM household_task_audit
        WHERE task_id = ? ORDER BY rowid`
    )
    .all(taskId) as Array<{ action: string; actor_user_id: string }>
}

function auditCount(sqlite: Db): number {
  return (
    sqlite.prepare('SELECT COUNT(*) AS cnt FROM household_task_audit').get() as { cnt: number }
  ).cnt
}

// The lib mutations take the full TaskRow (with the internal join column) —
// exactly what the route feeds them after the scoped lookup. The summaries
// createTask returns are the API projection; every mutation call in these
// tests re-fetches the row the way the route does.
async function freshRow(d1: D1Database, id: string) {
  const row = await getTaskRow(d1, 'h1', id)
  expect(row).not.toBeNull()
  return row!
}

describe('household tasks semantics (real SQL)', () => {
  it('creates tasks for BOTH member modes with the derived needs_approval, and the household predicate hides foreign rows', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)

    expect(await getCallerMember(d1, 'h1', 'u1')).toMatchObject({
      userId: 'u1',
      memberId: 'm-ibu',
      role: 'owner',
    })

    const kidTask = await createTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'Sapu halaman',
      assignee: (await getHouseholdMember(d1, 'h1', 'm-anak'))!,
      dueDate: '2026-11-10',
      recurrence: null,
    })
    const ayahTask = await createTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'Bayar listrik',
      assignee: (await getHouseholdMember(d1, 'h1', 'm-ayah'))!,
      dueDate: null,
      recurrence: null,
    })
    const unassigned = await createTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'Cek stok dapur',
      assignee: null,
      dueDate: null,
      recurrence: null,
    })

    // The derived flag: profile-only assignee → approval needed; linked or
    // unassigned → not. Derived, never client-suggested.
    expect(kidTask.needs_approval).toBe(true)
    expect(ayahTask.needs_approval).toBe(false)
    expect(unassigned.needs_approval).toBe(false)
    // Provenance is the creator's member row; the projection carries member
    // REFERENCE ids, never the internal join column.
    expect(kidTask.created_by_member_id).toBe('m-ibu')
    expect(JSON.stringify(kidTask)).not.toContain('assignee_user_id')

    // The board: h1 sees exactly its three tasks; h2 sees none. The DEFAULT
    // timestamps are REAL — datetime('now') fills them, a bound '' would not.
    const board = await listTasks(d1, 'h1')
    expect(board.map((t) => t.id).sort()).toEqual([kidTask.id, ayahTask.id, unassigned.id].sort())
    expect(await listTasks(d1, 'h2')).toEqual([])
    const stored = sqlite
      .prepare('SELECT created_at FROM household_tasks WHERE id = ?')
      .get(kidTask.id) as { created_at: string }
    expect(stored.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

    // Unknown task id and a member id from ANOTHER household: the same
    // shaped "absent" (no existence leak).
    expect(await getTaskRow(d1, 'h1', 'nope')).toBeNull()
    expect(await getTaskRow(d1, 'h2', kidTask.id)).toBeNull()
    expect(await getHouseholdMember(d1, 'h1', 'm-om-h2')).toBeNull()

    // One 'create' audit row per task, in the same transaction as the insert.
    expect(auditActions(sqlite, kidTask.id).map((r) => r.action)).toEqual(['create'])
  })

  it('completes: assignee-self for linked members, on-behalf by creator/owner for the kid; unrelated members refused', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    const ayahTask = await createTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'Bayar listrik',
      assignee: (await getHouseholdMember(d1, 'h1', 'm-ayah'))!,
      dueDate: null,
      recurrence: null,
    })
    const kidTask = await createTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'Sapu halaman',
      assignee: (await getHouseholdMember(d1, 'h1', 'm-anak'))!,
      dueDate: null,
      recurrence: null,
    })

    // Ayah completes his own errand (assignee-self).
    const selfDone = await completeTask(d1, {
      householdId: 'h1',
      userId: 'u2',
      task: await freshRow(d1, ayahTask.id),
      completedOn: '2026-11-06',
    })
    expect(selfDone.status).toBe('done')

    // Ibu completes the kid's chore on her behalf (the kid has no account).
    const kidDone = await completeTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      task: await freshRow(d1, kidTask.id),
      completedOn: '2026-11-06',
    })
    expect(kidDone.status).toBe('done')

    // om has no relation to either task: refused, nothing written.
    for (const id of [ayahTask.id, kidTask.id]) {
      await expect(
        completeTask(d1, {
          householdId: 'h1',
          userId: 'u3',
          task: await freshRow(d1, id),
          completedOn: '2026-11-06',
        })
      ).rejects.toBeInstanceOf(TaskForbiddenError)
    }
    // Two creates + two completes — the refused call wrote nothing.
    expect(auditCount(sqlite)).toBe(4)
    expect(auditActions(sqlite, ayahTask.id).map((r) => r.action)).toEqual(['create', 'complete'])
  })

  it('rolls recurring tasks forward on completion and keeps them open', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)

    const daily = await createTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'Kasih makan kucing',
      assignee: (await getHouseholdMember(d1, 'h1', 'm-anak'))!,
      dueDate: '2026-11-02',
      recurrence: 'daily',
    })
    const done = await completeTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      task: await freshRow(d1, daily.id),
      completedOn: '2026-11-06',
    })
    // Late completion: the missed days do not stack — next due is tomorrow.
    expect(done.status).toBe('open')
    expect(done.due_date).toBe('2026-11-07')
    // The completed instance is the audit record, not the task row.
    expect(auditActions(sqlite, daily.id).map((r) => r.action)).toEqual(['create', 'complete'])
  })

  it('approval flow end-to-end: the kid completes (on behalf), the assigner acknowledges, unrelated members cannot', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    const om = (await getCallerMember(d1, 'h1', 'u3'))!

    const kidTask = await createTask(d1, {
      householdId: 'h1',
      userId: 'u2',
      title: 'Rapikan tempat tidur',
      assignee: (await getHouseholdMember(d1, 'h1', 'm-anak'))!,
      dueDate: null,
      recurrence: null,
    })

    // Not done yet — approval refuses even for the creator (409: the state
    // refuses the action, not the person).
    await expect(
      approveTask(d1, { householdId: 'h1', userId: 'u2', task: await freshRow(d1, kidTask.id) })
    ).rejects.toBeInstanceOf(TaskConflictError)

    const done = await completeTask(d1, {
      householdId: 'h1',
      userId: 'u1', // ibu completes on the kid's behalf
      task: await freshRow(d1, kidTask.id),
      completedOn: '2026-11-06',
    })

    // The creator (ayah, household role 'member') acknowledges — the
    // "assigner" of the issue's approval step.
    const approved = await approveTask(d1, {
      householdId: 'h1',
      userId: 'u2',
      task: await freshRow(d1, done.id),
    })
    expect(approved.approved_by_member_id).toBe('m-ayah')

    // An unrelated member cannot approve.
    await expect(
      approveTask(d1, {
        householdId: 'h1',
        userId: om.userId,
        task: await freshRow(d1, done.id),
      })
    ).rejects.toBeInstanceOf(TaskForbiddenError)

    expect(auditActions(sqlite, kidTask.id).map((r) => r.action)).toEqual([
      'create',
      'complete',
      'approve',
    ])
  })

  it('edits and reassigns with needs_approval re-derived and prior approval cleared', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)

    const task = await createTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'Sapu halaman',
      assignee: (await getHouseholdMember(d1, 'h1', 'm-anak'))!,
      dueDate: null,
      recurrence: null,
    })
    const done = await completeTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      task: await freshRow(d1, task.id),
      completedOn: '2026-11-06',
    })
    const approved = await approveTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      task: await freshRow(d1, done.id),
    })
    expect(approved.approved_by_member_id).toBe('m-ibu')

    // Reassigning the DONE one-shot to a new assignee is REFUSED (thermos
    // A4): the reassignment would re-derive needs_approval for a kid who
    // never did the task and make it immediately approvable — the approval
    // record (and the future allowance credit) would attach to a non-event.
    // Assign a fresh task instead.
    await expect(
      updateTask(d1, {
        householdId: 'h1',
        userId: 'u1',
        task: await freshRow(d1, done.id),
        patch: { title: 'Sapu teras', assignee: (await getHouseholdMember(d1, 'h1', 'm-ayah'))! },
      })
    ).rejects.toBeInstanceOf(TaskValidationError)
    // Nothing moved: the done task keeps its assignee and its approval.
    const untouched = await freshRow(d1, done.id)
    expect(untouched).toMatchObject({
      status: 'done',
      assignee_member_id: 'm-anak',
      approved_by_member_id: 'm-ibu',
    })

    // Edits still work on the done task (the refusal is reassignment only).
    const renamed = await updateTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      task: untouched,
      patch: { title: 'Sapu teras' },
    })
    expect(renamed.title).toBe('Sapu teras')

    // The creator can edit; an unrelated member cannot.
    await expect(
      updateTask(d1, {
        householdId: 'h1',
        userId: 'u3',
        task: await freshRow(d1, done.id),
        patch: { title: 'Tidak boleh' },
      })
    ).rejects.toBeInstanceOf(TaskForbiddenError)

    // Reassignment works on an OPEN task: needs_approval re-derives and the
    // prior approval (if any) clears.
    const openTask = await createTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'Sapu teras',
      assignee: (await getHouseholdMember(d1, 'h1', 'm-anak'))!,
      dueDate: null,
      recurrence: null,
    })
    const reassigned = await updateTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      task: await freshRow(d1, openTask.id),
      patch: { assignee: (await getHouseholdMember(d1, 'h1', 'm-ayah'))! },
    })
    expect(reassigned).toMatchObject({
      assignee_member_id: 'm-ayah',
      needs_approval: false,
      approved_by_member_id: null,
    })

    // An empty patch is a no-op read at the lib level — no write, no audit
    // row. (A re-submitted IDENTICAL assignee is the ROUTE's no-op — the
    // route owns change detection, pinned in tasks.test.ts. The lib's null
    // assignee means a deliberate unassign; an UNKNOWN member id is the
    // route's 400, also pinned there.)
    const before = auditCount(sqlite)
    const noop = await updateTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      task: await freshRow(d1, openTask.id),
      patch: {},
    })
    expect(noop.title).toBe('Sapu teras')
    expect(auditCount(sqlite)).toBe(before)

    const unassigned = await updateTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      task: await freshRow(d1, openTask.id),
      patch: { assignee: null },
    })
    expect(unassigned).toMatchObject({ assignee_member_id: null, needs_approval: false })
  })

  it('deletes creator-or-owner, and the audit trail OUTLIVES the task row', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)

    const task = await createTask(d1, {
      householdId: 'h1',
      userId: 'u2',
      title: 'Tarik sampah',
      assignee: null,
      dueDate: null,
      recurrence: null,
    })
    await completeTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      task: await freshRow(d1, task.id),
      completedOn: '2026-11-06',
    })

    // om is neither creator nor owner — refused, nothing deleted.
    await expect(
      deleteTask(d1, {
        householdId: 'h1',
        userId: 'u3',
        task: await freshRow(d1, task.id),
      })
    ).rejects.toBeInstanceOf(TaskForbiddenError)
    expect(await getTaskRow(d1, 'h1', task.id)).not.toBeNull()

    // The creator deletes. The 'delete' audit row is written BEFORE the
    // delete in the same batch and must survive the row it names.
    await deleteTask(d1, {
      householdId: 'h1',
      userId: 'u2',
      task: await freshRow(d1, task.id),
    })
    expect(await getTaskRow(d1, 'h1', task.id)).toBeNull()
    expect(auditActions(sqlite, task.id).map((r) => r.action)).toEqual([
      'create',
      'complete',
      'delete',
    ])
    // The household FK keeps the trail scoped; task_id has NO FK — the
    // deletion record outlived the row above.
    const auditRows = sqlite
      .prepare('SELECT COUNT(*) AS cnt FROM household_task_audit WHERE task_id = ?')
      .get(task.id) as { cnt: number }
    expect(auditRows.cnt).toBe(3)
  })

  it('keeps authorization inside the household: owner of ANOTHER household grants nothing', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)

    const task = await createTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'Sapu halaman',
      assignee: null,
      dueDate: null,
      recurrence: null,
    })

    // om OWNS h2 — but his membership row in h1 is a plain member, and that
    // is the row the lib re-derives. No owner magic crosses households, and
    // the scoped lookup answers null for h2 (the 404 the route maps).
    expect((await getCallerMember(d1, 'h2', 'u3'))!.role).toBe('owner')
    await expect(
      completeTask(d1, {
        householdId: 'h1',
        userId: 'u3',
        task: await freshRow(d1, task.id),
        completedOn: '2026-11-06',
      })
    ).rejects.toBeInstanceOf(TaskForbiddenError)
    await expect(
      deleteTask(d1, {
        householdId: 'h1',
        userId: 'u3',
        task: await freshRow(d1, task.id),
      })
    ).rejects.toBeInstanceOf(TaskForbiddenError)
    await expect(
      updateTask(d1, {
        householdId: 'h1',
        userId: 'u3',
        task: await freshRow(d1, task.id),
        patch: { title: 'Tidak boleh' },
      })
    ).rejects.toBeInstanceOf(TaskForbiddenError)
    expect(await getTaskRow(d1, 'h2', task.id)).toBeNull()
    expect(
      (
        sqlite.prepare('SELECT status FROM household_tasks WHERE id = ?').get(task.id) as {
          status: string
        }
      ).status
    ).toBe('open')
  })

  it('fails closed for a caller with no member row (no write, no actor)', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u4', 'x@b.com')").run()
    expect(await getCallerMember(d1, 'h1', 'u4')).toBeNull()

    const task = await createTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'Sapu halaman',
      assignee: null,
      dueDate: null,
      recurrence: null,
    })
    // The membership-less user cannot complete, approve, edit, or delete.
    await expect(
      completeTask(d1, {
        householdId: 'h1',
        userId: 'u4',
        task: await freshRow(d1, task.id),
        completedOn: '2026-11-06',
      })
    ).rejects.toBeInstanceOf(TaskForbiddenError)
    await expect(
      updateTask(d1, {
        householdId: 'h1',
        userId: 'u4',
        task: await freshRow(d1, task.id),
        patch: { title: 'X' },
      })
    ).rejects.toBeInstanceOf(TaskForbiddenError)
    await expect(
      deleteTask(d1, {
        householdId: 'h1',
        userId: 'u4',
        task: await freshRow(d1, task.id),
      })
    ).rejects.toBeInstanceOf(TaskForbiddenError)
    // Only the create rode through — one audit row, actor u1.
    expect(auditCount(sqlite)).toBe(1)
  })

  it('clears the assignee and provenance links when members are removed, without losing the tasks', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    const ayahTask = await createTask(d1, {
      householdId: 'h1',
      userId: 'u2',
      title: 'Bayar listrik',
      assignee: (await getHouseholdMember(d1, 'h1', 'm-ayah'))!,
      dueDate: null,
      recurrence: null,
    })
    const kidTask = await createTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'Sapu halaman',
      assignee: (await getHouseholdMember(d1, 'h1', 'm-anak'))!,
      dueDate: null,
      recurrence: null,
    })

    // Ayah leaves the household (the 0021 member row goes; 0027 SET NULLs the
    // references): his task stays, unassigned, provenance NULL — the
    // authorization falls to the owners.
    sqlite.prepare('DELETE FROM household_members WHERE id = ?').run('m-ayah')
    const orphaned = await getTaskRow(d1, 'h1', ayahTask.id)
    expect(orphaned).toMatchObject({
      assignee_member_id: null,
      created_by_member_id: null,
      needs_approval: false,
    })

    // Removing the KID keeps the chore and clears the derived flag with the link.
    sqlite.prepare('DELETE FROM household_members WHERE id = ?').run('m-anak')
    const stillThere = await getTaskRow(d1, 'h1', kidTask.id)
    expect(stillThere).toMatchObject({
      assignee_member_id: null,
      needs_approval: false,
      title: 'Sapu halaman',
    })
    // The owner can still complete the orphaned chore — provenance NULL means
    // creator checks pass as "no creator", the owner manages the household.
    const done = await completeTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      task: stillThere!,
      completedOn: '2026-11-06',
    })
    expect(done.status).toBe('done')
  })

  it('refuses a second complete of the same recurring instance (optimistic due-date anchor) while the next occurrence completes normally', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)

    const daily = await createTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'Kasih makan kucing',
      assignee: (await getHouseholdMember(d1, 'h1', 'm-anak'))!,
      dueDate: '2026-11-02',
      recurrence: 'daily',
    })
    // The pre-read row both taps capture — the second tap is the same
    // request replayed with the same anchor (sequential double-tap; two
    // family members racing read the identical state).
    const capturedRow = await freshRow(d1, daily.id)
    const first = await completeTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      task: capturedRow,
      completedOn: '2026-11-06',
    })
    expect(first).toMatchObject({ status: 'open', due_date: '2026-11-07' })

    // The double-tap completes with the SAME captured anchor: the guarded
    // UPDATE's `due_date IS ?` matches zero rows — the schedule must not
    // roll twice, and no second audit row may land (double credit in the
    // future allowance ledger).
    await expect(
      completeTask(d1, {
        householdId: 'h1',
        userId: 'u1',
        task: capturedRow,
        completedOn: '2026-11-06',
      })
    ).rejects.toBeInstanceOf(TaskConflictError)
    expect(auditActions(sqlite, daily.id).map((r) => r.action)).toEqual(['create', 'complete'])
    const row = await freshRow(d1, daily.id)
    expect(row.due_date).toBe('2026-11-07')

    // Completing the NEXT rolled occurrence works normally (its anchor is
    // the new due date) — the refusal is per-instance, not per-task.
    const second = await completeTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      task: row,
      completedOn: '2026-11-07',
    })
    expect(second.due_date).toBe('2026-11-08')
    expect(auditActions(sqlite, daily.id).map((r) => r.action)).toEqual([
      'create',
      'complete',
      'complete',
    ])
  })

  it('answers 404 without a phantom audit row when a delete races update/complete/delete (thermos A1)', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)

    const task = await createTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'Sapu halaman',
      assignee: (await getHouseholdMember(d1, 'h1', 'm-anak'))!,
      dueDate: null,
      recurrence: null,
    })
    // The row another device deletes between the caller's pre-check and the
    // caller's batch — every mutation re-fetched this stale row.
    const stale = await freshRow(d1, task.id)
    sqlite.prepare('DELETE FROM household_tasks WHERE id = ?').run(task.id)
    const auditsBefore = auditCount(sqlite)

    for (const mutation of [
      () =>
        updateTask(d1, {
          householdId: 'h1',
          userId: 'u1',
          task: stale,
          patch: { title: 'Hantu' },
        }),
      () =>
        completeTask(d1, {
          householdId: 'h1',
          userId: 'u1',
          task: stale,
          completedOn: '2026-11-06',
        }),
      () => deleteTask(d1, { householdId: 'h1', userId: 'u1', task: stale }),
    ]) {
      await expect(mutation()).rejects.toBeInstanceOf(TaskNotFoundError)
    }
    // Neither a phantom write NOR a spurious audit record. The trail is only
    // the 'create': the row was deleted by the RACE (raw SQL, no lib call),
    // and every stale-row mutation's gated audit saw no row to attach to.
    expect(auditCount(sqlite)).toBe(auditsBefore)
    expect(auditActions(sqlite, task.id).map((r) => r.action)).toEqual(['create'])
  })

  it('refuses approval when the kid got linked between the read and the write (guarded-approve race, thermos B2)', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)

    const kidTask = await createTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'Rapikan tempat tidur',
      assignee: (await getHouseholdMember(d1, 'h1', 'm-anak'))!,
      dueDate: null,
      recurrence: null,
    })
    const done = await completeTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      task: await freshRow(d1, kidTask.id),
      completedOn: '2026-11-06',
    })
    // The row the approver reads — derived needs_approval still true (the
    // link has not happened yet).
    const stale = await freshRow(d1, done.id)
    expect(stale.needs_approval).toBe(true)

    // Link-later (ahaqqu/RumaQ#397) attaches an account to the kid's member
    // row BETWEEN the read and the approve batch — u5 is a fresh account, so
    // the partial unique index is not in the way.
    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u5', 'kid@b.com')").run()
    sqlite.prepare("UPDATE household_members SET user_id = 'u5' WHERE id = 'm-anak'").run()

    // The guarded UPDATE's EXISTS re-checks the LIVE assignee mode inside the
    // batch: the kid is linked now, so nothing is awaiting approval — zero
    // rows, typed 409, and NO phantom 'approve' audit row.
    await expect(
      approveTask(d1, { householdId: 'h1', userId: 'u1', task: stale })
    ).rejects.toBeInstanceOf(TaskConflictError)
    expect(auditActions(sqlite, kidTask.id).map((r) => r.action)).toEqual(['create', 'complete'])
    const row = await freshRow(d1, kidTask.id)
    expect(row.approved_by_member_id).toBeNull()
    expect(row.needs_approval).toBe(false) // derived from the live join
  })

  it('enforces the schema CHECKs and defaults (0027 backstops)', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    const task = await createTask(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'Sapu halaman',
      assignee: null,
      dueDate: null,
      recurrence: null,
    })
    const row = sqlite.prepare('SELECT * FROM household_tasks WHERE id = ?').get(task.id) as
      | Record<string, unknown>
      | undefined
    expect(row).toBeDefined()
    expect(row?.status).toBe('open') // DEFAULT 'open'
    expect(row?.needs_approval).toBe(0) // DEFAULT 0

    // The closed sets refuse anything else — the app never writes these, the
    // schema is the backstop (the 0001 role CHECK discipline).
    expect(() =>
      sqlite.prepare("UPDATE household_tasks SET recurrence = 'yearly' WHERE id = ?").run(task.id)
    ).toThrow()
    expect(() =>
      sqlite.prepare("UPDATE household_tasks SET status = 'archived' WHERE id = ?").run(task.id)
    ).toThrow()
    expect(() =>
      sqlite.prepare('UPDATE household_tasks SET needs_approval = 2 WHERE id = ?').run(task.id)
    ).toThrow()
    expect(() =>
      sqlite
        .prepare('UPDATE household_tasks SET title = ? WHERE id = ?')
        .run('x'.repeat(121), task.id)
    ).toThrow()

    // The FKs hold: a dangling member reference is refused at write time. (A
    // member id from ANOTHER household satisfies the plain FK — same-household
    // scoping is the lib's job, pinned via getHouseholdMember above.)
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO household_tasks
             (id, household_id, title, assignee_member_id, created_by_member_id, needs_approval)
           VALUES ('x1', 'h1', 'Tidak boleh', 'm-nope', 'm-ibu', 0)`
        )
        .run()
    ).toThrow()

    // The audit CHECK vocabulary is the closed #429 set.
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO household_task_audit (id, task_id, household_id, actor_user_id, action)
           VALUES ('a1', 'nope', 'h1', 'u1', 'reopen')`
        )
        .run()
    ).toThrow()
  })
})
