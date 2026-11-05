// Household task domain logic (ahaqqu/RumaQ#429). Routes in apps/tasks.ts
// stay HTTP-shaped; every rule lives here so the title bound, the permission
// matrix, the recurrence roll-forward and the audit vocabulary have exactly
// one definition.
//
// Authorization model: tasks scope to the caller's ACTIVE household (the auth
// middleware resolves it — the same substrate as the vault). Every lookup
// filters by household_id in the SQL itself, so a foreign task id and a
// nonexistent id are indistinguishable: both answer 404 (no existence leak,
// the households-app pattern).
//
// Actors are CALLERS — every authenticated caller is a LINKED member of the
// active household (the middleware resolves householdId FROM
// household_members; profile-only members have user_id NULL and never
// authenticate, 0021). The two-mode asymmetry is the point of #429: kids get
// assigned and have their tasks completed ON THEIR BEHALF; they never create,
// assign, or approve. The caller's own member row (the surrogate id) is what
// 'me', created_by and approved_by key on.
//
// Permission matrix (the issue's "linked admins" mapped onto the two-mode
// model — see the PR notes):
//   create            any linked member (structural: profile-only never call)
//   edit / assign     the task's creator, or a household owner
//   complete          the assignee (when linked and it is the caller),
//                     the creator, or an owner — profile-only assignees
//                     cannot act, so a parent completes on their behalf
//   approve           the creator or an owner, only while needs_approval and
//                     the task is done (the design's "assigner/admin")
//   delete            the creator or an owner
//
// Read scope (the issue's open question — decided and pinned in tests): NO
// per-member read hiding in v1. Every household member sees the whole
// household board (open + done, assignee ids included); kids' visibility
// happens on the shared family device through a parent's session. The
// ?assignee=me / ?mine=1 filters power each member's "My tasks" view on top
// of that shared board.

import type { HouseholdRole } from './households.js'

export const TASK_TITLE_MAX = 120

/** v1 recurrences (ahaqqu/RumaQ#429); the CHECK in 0027 is the backstop. */
export type TaskRecurrence = 'daily' | 'weekly' | 'monthly'
export type TaskStatus = 'open' | 'done'

/** Audit actions (ahaqqu/RumaQ#429 vocabulary), mirroring the vault's. */
export type TaskAction = 'create' | 'update' | 'complete' | 'approve' | 'delete'

export type CallerMember = {
  // The account acting — assignee-self checks key on it.
  userId: string
  // The surrogate member id (0021) — created_by/approved_by and 'me' key on it.
  memberId: string
  role: HouseholdRole
}

export type HouseholdMemberRef = {
  id: string
  // NULL = profile-only member (Mode B, #388) — the needs_approval trigger.
  user_id: string | null
}

export type TaskRow = {
  id: string
  household_id: string
  title: string
  assignee_member_id: string | null
  // The assignee's user_id, resolved via JOIN so "is the caller the assignee"
  // needs no second query. Never leaves the lib (the summary drops it).
  assignee_user_id: string | null
  created_by_member_id: string | null
  due_date: string | null
  recurrence: TaskRecurrence | null
  status: TaskStatus
  needs_approval: boolean
  approved_by_member_id: string | null
  created_at: string
  updated_at: string
}

// The API projection — member REFERENCE ids only (the vault's pattern); the
// client resolves names through the roster endpoint it already has.
export type TaskSummary = {
  id: string
  household_id: string
  title: string
  assignee_member_id: string | null
  created_by_member_id: string | null
  due_date: string | null
  recurrence: TaskRecurrence | null
  status: TaskStatus
  needs_approval: boolean
  approved_by_member_id: string | null
  created_at: string
  updated_at: string
}

export class TaskValidationError extends Error {
  constructor(message = 'Invalid task') {
    super(message)
    this.name = 'TaskValidationError'
  }
}

// One message for unknown ids AND another household's ids — the household
// predicate in the SQL makes them indistinguishable (no existence leak).
export class TaskNotFoundError extends Error {
  constructor(message = 'Task not found') {
    super(message)
    this.name = 'TaskNotFoundError'
  }
}

export class TaskForbiddenError extends Error {
  constructor(message = 'Only the task creator or a household owner can do that') {
    super(message)
    this.name = 'TaskForbiddenError'
  }
}

// The task's STATE refuses the action (already done, nothing to approve) —
// the request was well-formed, so 409, not 400 (the 20-files-cap precedent).
export class TaskConflictError extends Error {
  constructor(message = 'Task is not in a state that allows that') {
    super(message)
    this.name = 'TaskConflictError'
  }
}

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

function parseDate(date: string): Date {
  // Dates are YYYY-MM-DD column values; parsed as UTC so the lexicographic
  // column order and the arithmetic can never disagree around timezones.
  return new Date(`${date}T00:00:00.000Z`)
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

// Month arithmetic with end-of-month clamping: Jan 31 + 1 month = Feb 28/29,
// not a rolled-over March 3 (a chore "every month on the 31st" still comes
// due every month).
function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + months
  const day = date.getUTCDate()
  // Day 0 of the NEXT month = its last day — the clamp.
  const clampedDay = Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate())
  return new Date(Date.UTC(year, month, clampedDay))
}

/**
 * The next due date after completing a recurring task (ahaqqu/RumaQ#429 v1):
 * the CURRENT due date anchors the schedule — daily +1 day, weekly +7 days,
 * monthly +1 calendar month (clamped) — advanced past the completion day so
 * a chore completed late does not come due in the past. No due date (an
 * undated recurring task) anchors on the completion day itself.
 *
 * The catch-up loop is bounded (366 steps — a full leap year of missed dailies)
 * so a pathological completedOn can never spin; past the bound the last
 * computed date stands (still deterministic, still > the previous due date).
 */
export function computeNextDue(
  recurrence: TaskRecurrence,
  dueDate: string | null,
  completedOn: string
): string {
  let next = parseDate(dueDate ?? completedOn)
  for (let steps = 0; steps < 366; steps++) {
    if (formatDate(next) > completedOn) return formatDate(next)
    next =
      recurrence === 'monthly' ? addMonths(next, 1) : addDays(next, recurrence === 'weekly' ? 7 : 1)
  }
  return formatDate(next)
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const TASK_SELECT = `SELECT t.id, t.household_id, t.title, t.assignee_member_id,
       am.user_id AS assignee_user_id, t.created_by_member_id, t.due_date,
       t.recurrence, t.status, t.needs_approval, t.approved_by_member_id,
       t.created_at, t.updated_at
  FROM household_tasks t
  LEFT JOIN household_members am ON am.id = t.assignee_member_id`

function toTaskRow(row: Omit<TaskRow, 'needs_approval'> & { needs_approval: number }): TaskRow {
  // needs_approval is DERIVED for reads: true exactly while the assignee is a
  // profile-only member (0027). The stored column is the write-side flag the
  // lib maintains on every assignee change — but member removal (SET NULL)
  // and link-later (#397 attaches an account to the kid's member row) can
  // leave it stale in either direction, and a flag that lies would send the
  // approval flow after a task that no longer needs it. The live join is the
  // truth; approveTask additionally re-checks it inside the guarded UPDATE.
  const derived = row.assignee_member_id !== null && row.assignee_user_id === null
  return { ...row, needs_approval: derived }
}

function toSummary(task: TaskRow): TaskSummary {
  return {
    id: task.id,
    household_id: task.household_id,
    title: task.title,
    assignee_member_id: task.assignee_member_id,
    created_by_member_id: task.created_by_member_id,
    due_date: task.due_date,
    recurrence: task.recurrence,
    status: task.status,
    needs_approval: task.needs_approval,
    approved_by_member_id: task.approved_by_member_id,
    created_at: task.created_at,
    updated_at: task.updated_at,
  }
}

/**
 * List the active household's tasks — the board. Filters compose into the
 * WHERE clause with bound parameters only. No per-member read hiding: the
 * household board is shared (see the header); the assignee filter powers the
 * per-member "My tasks" view on top of it. An unknown assignee id simply
 * filters to an empty list (a read filter, not a resource probe — the
 * documents GET memberId precedent).
 */
export async function listTasks(
  db: D1Database,
  householdId: string,
  filters: { assigneeMemberId?: string; status?: 'open' | 'done' } = {}
): Promise<TaskSummary[]> {
  const conditions = ['t.household_id = ?']
  const params: string[] = [householdId]
  if (filters.assigneeMemberId !== undefined) {
    conditions.push('t.assignee_member_id = ?')
    params.push(filters.assigneeMemberId)
  }
  if (filters.status !== undefined) {
    conditions.push('t.status = ?')
    params.push(filters.status)
  }
  const { results } = await db
    .prepare(
      `${TASK_SELECT}
        WHERE ${conditions.join(' AND ')}
        -- Open board order: dated tasks by due date, undated last, stable on
        -- creation time then id (the 0022 tiebreaker discipline).
        ORDER BY (t.due_date IS NULL), t.due_date, t.created_at, t.id`
    )
    .bind(...params)
    .all<Omit<TaskRow, 'needs_approval'> & { needs_approval: number }>()
  return results.map(toTaskRow).map(toSummary)
}

/**
 * The scoped single-task lookup — every route that serves or mutates a task
 * starts here. The household predicate rides in the SQL, so a foreign
 * household's id is just "not found", answered before any authz decision.
 */
export async function getTaskRow(
  db: D1Database,
  householdId: string,
  taskId: string
): Promise<TaskRow | null> {
  const row = await db
    .prepare(`${TASK_SELECT} WHERE t.id = ? AND t.household_id = ?`)
    .bind(taskId, householdId)
    .first<Omit<TaskRow, 'needs_approval'> & { needs_approval: number }>()
  return row ? toTaskRow(row) : null
}

/**
 * The caller's member row in the active household — the actor handle for
 * created_by/approved_by and the 'me' filter. Unreachable in practice (the
 * auth middleware resolves householdId FROM household_members), but the
 * fail-closed answer is a typed 403, never a write with a null actor.
 */
export async function getCallerMember(
  db: D1Database,
  householdId: string,
  userId: string
): Promise<CallerMember | null> {
  const row = await db
    .prepare('SELECT id, role FROM household_members WHERE household_id = ? AND user_id = ?')
    .bind(householdId, userId)
    .first<{ id: string; role: HouseholdRole }>()
  return row ? { userId, memberId: row.id, role: row.role } : null
}

export async function requireCallerMember(
  db: D1Database,
  householdId: string,
  userId: string
): Promise<CallerMember> {
  const caller = await getCallerMember(db, householdId, userId)
  if (!caller) {
    throw new TaskForbiddenError('Household membership not found')
  }
  return caller
}

/**
 * The member a task is assigned to (or created by) — both modes (0021)
 * through the surrogate id. Scoped to the household, so a valid id from
 * ANOTHER household cannot be referenced; the route turns null into a 400
 * (a body-reference problem, not an addressable-resource probe — the
 * documents resolveMemberId pattern).
 */
export async function getHouseholdMember(
  db: D1Database,
  householdId: string,
  memberId: string
): Promise<HouseholdMemberRef | null> {
  return db
    .prepare('SELECT id, user_id FROM household_members WHERE id = ? AND household_id = ?')
    .bind(memberId, householdId)
    .first<HouseholdMemberRef>()
}

// ---------------------------------------------------------------------------
// Permissions (lib-owned so routes never re-derive roles — the households
// requireOwner discipline)
// ---------------------------------------------------------------------------

function isOwner(caller: CallerMember): boolean {
  return caller.role === 'owner'
}

function isCreator(task: TaskRow, caller: CallerMember): boolean {
  return task.created_by_member_id !== null && task.created_by_member_id === caller.memberId
}

function isAssigneeSelf(task: TaskRow, caller: CallerMember): boolean {
  return task.assignee_user_id !== null && task.assignee_user_id === caller.userId
}

/**
 * needs_approval is DERIVED from the assignee's mode (the 0027 header): a
 * profile-only assignee (user_id NULL) needs the assigner's acknowledgment;
 * linked assignees and unassigned tasks do not.
 */
function deriveNeedsApproval(assignee: HouseholdMemberRef | null): boolean {
  return assignee !== null && assignee.user_id === null
}

function insertAuditStatement(
  db: D1Database,
  args: { taskId: string; householdId: string; actorUserId: string; action: TaskAction }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO household_task_audit (id, task_id, household_id, actor_user_id, action)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(crypto.randomUUID(), args.taskId, args.householdId, args.actorUserId, args.action)
}

// ---------------------------------------------------------------------------
// Mutations — every write carries its audit row in the SAME batch (the vault's
// in-transaction rule: an audit row that can be skipped by a crash is a rumor).
// Authorization re-derives the caller's member row INSIDE the lib from
// (householdId, userId) — the vault's discipline — so a route can never hand
// a caller row from one household to another household's task.
// ---------------------------------------------------------------------------

/**
 * Create: free-text title (trimmed/bounded by the route's schema), optional
 * assignee (both modes), due date, recurrence. needs_approval derives from
 * the assignee's mode. The task row and its 'create' audit record commit in
 * one batch.
 */
export async function createTask(
  db: D1Database,
  args: {
    householdId: string
    userId: string
    title: string
    assignee: HouseholdMemberRef | null
    dueDate: string | null
    recurrence: TaskRecurrence | null
  }
): Promise<TaskSummary> {
  const caller = await requireCallerMember(db, args.householdId, args.userId)
  const taskId = crypto.randomUUID()
  const needsApproval = deriveNeedsApproval(args.assignee)
  await db.batch([
    db
      .prepare(
        `INSERT INTO household_tasks
           (id, household_id, title, assignee_member_id, created_by_member_id,
            due_date, recurrence, status, needs_approval)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`
      )
      .bind(
        taskId,
        args.householdId,
        args.title,
        args.assignee?.id ?? null,
        caller.memberId,
        args.dueDate,
        args.recurrence,
        needsApproval ? 1 : 0
      ),
    insertAuditStatement(db, {
      taskId,
      householdId: args.householdId,
      actorUserId: args.userId,
      action: 'create',
    }),
  ])
  const stored = await getTaskRow(db, args.householdId, taskId)
  if (!stored) {
    throw new Error('task insert did not persist')
  }
  return toSummary(stored)
}

export type TaskEditPatch = {
  title?: string
  due_date?: string | null
  recurrence?: TaskRecurrence | null
  // Present (null included) ONLY when the route detected an actual assignee
  // CHANGE — a re-submitted identical assignee is a no-op, not a new cycle.
  // Every change re-derives needs_approval from the assignee's mode (0027:
  // derived, not stored state that can drift) and clears any prior approval:
  // a chore reassigned to a different kid is a fresh cycle, not a
  // pre-acknowledged one.
  assignee?: HouseholdMemberRef | null
}

/**
 * Edit fields (title/due date/recurrence) and assign/reassign. Creator or
 * owner only — a member manages the tasks they created; owners manage the
 * household's.
 */
export async function updateTask(
  db: D1Database,
  args: {
    householdId: string
    userId: string
    task: TaskRow
    patch: TaskEditPatch
  }
): Promise<TaskSummary> {
  const { task } = args
  const caller = await requireCallerMember(db, args.householdId, args.userId)
  if (!isCreator(task, caller) && !isOwner(caller)) {
    throw new TaskForbiddenError()
  }

  const updates: string[] = []
  const params: unknown[] = []
  if (args.patch.title !== undefined) {
    updates.push('title = ?')
    params.push(args.patch.title)
  }
  if (args.patch.due_date !== undefined) {
    updates.push('due_date = ?')
    params.push(args.patch.due_date)
  }
  if (args.patch.recurrence !== undefined) {
    updates.push('recurrence = ?')
    params.push(args.patch.recurrence)
  }
  if (args.patch.assignee !== undefined) {
    updates.push('assignee_member_id = ?')
    params.push(args.patch.assignee?.id ?? null)
    updates.push('needs_approval = ?')
    params.push(deriveNeedsApproval(args.patch.assignee) ? 1 : 0)
    updates.push('approved_by_member_id = NULL')
  }
  // An empty patch is a no-op read — the current row comes back, not a write
  // (the households updateMemberProfile precedent).
  if (updates.length === 0) {
    return toSummary(task)
  }

  updates.push("updated_at = datetime('now')")
  params.push(task.id, args.householdId)
  await db.batch([
    db
      .prepare(`UPDATE household_tasks SET ${updates.join(', ')} WHERE id = ? AND household_id = ?`)
      .bind(...params),
    insertAuditStatement(db, {
      taskId: task.id,
      householdId: args.householdId,
      actorUserId: args.userId,
      action: 'update',
    }),
  ])

  const stored = await getTaskRow(db, args.householdId, task.id)
  if (!stored) {
    throw new Error('task update did not persist')
  }
  return toSummary(stored)
}

/**
 * Complete (ahaqqu/RumaQ#429): assignee-self, creator, or owner. Requires an
 * open task (409 otherwise — a double complete would double-roll a recurring
 * schedule). A ONE-SHOT task flips to 'done'; a RECURRING task rolls its due
 * date to the next occurrence (anchored on the current due date, advanced
 * past the completion day), re-opens, and clears any approval — the completed
 * instance lives on as the 'complete' audit row.
 */
export async function completeTask(
  db: D1Database,
  args: {
    householdId: string
    userId: string
    task: TaskRow
    completedOn: string
  }
): Promise<TaskSummary> {
  const { task } = args
  const caller = await requireCallerMember(db, args.householdId, args.userId)
  const allowed =
    isAssigneeSelf(task, caller) || isCreator(task, caller) || isOwner(caller)
  if (!allowed) {
    throw new TaskForbiddenError(
      'Only the assignee, the creator, or a household owner can complete a task'
    )
  }
  if (task.status !== 'open') {
    throw new TaskConflictError('Task is already done')
  }

  const updates: string[] = []
  const params: unknown[] = []
  if (task.recurrence !== null) {
    updates.push('due_date = ?')
    params.push(computeNextDue(task.recurrence, task.due_date, args.completedOn))
    // The next cycle starts unacknowledged.
    updates.push('approved_by_member_id = NULL')
  } else {
    updates.push("status = 'done'")
  }
  updates.push("updated_at = datetime('now')")
  params.push(task.id, args.householdId)

  await db.batch([
    db
      .prepare(`UPDATE household_tasks SET ${updates.join(', ')} WHERE id = ? AND household_id = ?`)
      .bind(...params),
    insertAuditStatement(db, {
      taskId: task.id,
      householdId: args.householdId,
      actorUserId: args.userId,
      action: 'complete',
    }),
  ])

  const stored = await getTaskRow(db, args.householdId, task.id)
  if (!stored) {
    throw new Error('task completion did not persist')
  }
  return toSummary(stored)
}

/**
 * Approve the completed task (the assigner's acknowledgment — pairs with the
 * future allowance ledger). Creator or owner, only while needs_approval holds
 * and the task is done; the derived flag (toTaskRow) and the done status are
 * checked, not just the column. Re-approval (e.g. by the other parent) is an
 * allowed, audit-recorded overwrite.
 *
 * The UPDATE is GUARDED (the vault's addFileStatement pattern): it re-checks
 * status, the stored flag, AND the live assignee mode INSIDE the batch, so a
 * flag that went stale between the read and the write — the assignee's member
 * row was removed, or link-later (#397) attached an account to the kid —
 * matches no row instead of approving against the derived truth. changes === 0
 * surfaces as the typed 409.
 */
export async function approveTask(
  db: D1Database,
  args: {
    householdId: string
    userId: string
    task: TaskRow
  }
): Promise<TaskSummary> {
  const { task } = args
  const caller = await requireCallerMember(db, args.householdId, args.userId)
  if (!isCreator(task, caller) && !isOwner(caller)) {
    throw new TaskForbiddenError()
  }
  if (!task.needs_approval || task.status !== 'done') {
    throw new TaskConflictError('Task is not awaiting approval')
  }

  const results = await db.batch([
    db
      .prepare(
        `UPDATE household_tasks SET approved_by_member_id = ?, updated_at = datetime('now')
          WHERE id = ? AND household_id = ?
            AND status = 'done' AND needs_approval = 1
            AND EXISTS (
              SELECT 1 FROM household_members am
               WHERE am.id = household_tasks.assignee_member_id AND am.user_id IS NULL
            )`
      )
      .bind(caller.memberId, task.id, args.householdId),
    insertAuditStatement(db, {
      taskId: task.id,
      householdId: args.householdId,
      actorUserId: args.userId,
      action: 'approve',
    }),
  ])
  // The guard refused: the flag went stale between the read and this write.
  const changes = (results[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes
  if ((changes ?? 1) === 0) {
    throw new TaskConflictError('Task is not awaiting approval')
  }

  const stored = await getTaskRow(db, args.householdId, task.id)
  if (!stored) {
    throw new Error('task approval did not persist')
  }
  return toSummary(stored)
}

/**
 * Delete: creator or owner. The 'delete' audit row is written BEFORE the
 * delete INSIDE the same batch and survives it (no FK on
 * household_task_audit.task_id — the deletion record must outlive the row it
 * names, the 0022 discipline).
 */
export async function deleteTask(
  db: D1Database,
  args: {
    householdId: string
    userId: string
    task: TaskRow
  }
): Promise<void> {
  const { task } = args
  const caller = await requireCallerMember(db, args.householdId, args.userId)
  if (!isCreator(task, caller) && !isOwner(caller)) {
    throw new TaskForbiddenError()
  }

  await db.batch([
    insertAuditStatement(db, {
      taskId: task.id,
      householdId: args.householdId,
      actorUserId: args.userId,
      action: 'delete',
    }),
    db
      .prepare('DELETE FROM household_tasks WHERE id = ? AND household_id = ?')
      .bind(task.id, args.householdId),
  ])
}
