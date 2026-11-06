// Household calendar domain logic (ahaqqu/RumaQ#430). Routes in
// apps/calendar.ts stay HTTP-shaped; every rule lives here so the title/time
// bounds, the visibility semantics, the derive-on-read deadline projection and
// the audit vocabulary have exactly one definition.
//
// The calendar is a VIEW UNION of two entry kinds, served by ONE endpoint:
//
//   kind: 'event'    — stored rows in household_calendar_events (0031):
//                      free-text title, date, optional time, per-member
//                      visibility, creator.
//   kind: 'deadline' — DERIVED ON READ from the documents table (#426's
//                      documents.expires_on): KTP/STNK/SIM/paspor renewals
//                      surface on the calendar automatically.
//
// Derive-on-read (the #430 design decision) beats materialized seed rows:
// there is no second copy of an expiry to drift — a documents PATCH (#434)
// that edits expires_on reflects on the calendar on the very next read, a
// deleted document's deadline disappears, and no cron backfill can go stale.
// The cost (one indexed query per read over expiry-bearing rows) is bounded:
// vault sizes are household-scale, the same bound the #426 due-set sweep
// already accepts. remind_days_before is respected as the DUE-SOON signal on
// the derived entry (due_soon: days until expiry within the document's own
// window, expired included) — it does not narrow the calendar window: the
// requested date range is the filter, so far-future renewals stay plannable
// on their month grid, not only in the last 30 days.
//
// Authorization model (mirrors lib/tasks.ts substrate):
//   read    — household predicate everywhere; on top of it, visibility:
//             'all' events are household-wide; 'members' events are visible
//             to exactly the listed members PLUS the creator (implicit —
//             the restriction is about others, and the creator is always in
//             the manager set, so excluding themselves would strand their
//             own event) PLUS the household owner (the tasks-domain trade:
//             the owner administers the household's data — without it, a
//             removed creator's restricted event or a self-excluding
//             audience edit would leave the event unmanageable by anyone).
//             Profile-only members never authenticate; their visibility is
//             exercised through a parent's session.
//   create  — any linked member (structural: profile-only never call).
//   edit /
//   delete  — the event's creator, or a household owner.
// A caller who cannot SEE an event cannot touch it either (except the owner,
// who always can): the scoped lookup runs before any mutation decision, so a
// foreign household's id AND a restricted event are indistinguishable for a
// non-owner — both answer 404 (no existence leak, the households-app
// pattern).

import { DEFAULT_REMIND_DAYS_BEFORE, daysUntil, householdIsoDate } from './document-expiry.js'
import { selectIn } from './d1.js'
import type { HouseholdRole } from './households.js'

export const EVENT_TITLE_MAX = 120

/** Visibility values (0031 CHECK is the backstop). */
export type EventVisibility = 'all' | 'members'

/** Audit actions (ahaqqu/RumaQ#430 vocabulary), mirroring the vault/tasks. */
export type CalendarAction = 'create' | 'update' | 'delete'

export type CallerMember = {
  userId: string
  // The surrogate member id (0021) — created_by and the visibility predicate
  // key on it.
  memberId: string
  role: HouseholdRole
}

export type CalendarEventRow = {
  id: string
  household_id: string
  title: string
  event_date: string
  event_time: string | null
  visibility: EventVisibility
  created_by_member_id: string | null
  created_at: string
  updated_at: string
}

/** A stored event's per-member audience ('members' visibility), joined in
 * a second query — never stored on the event row itself. */
export type EventSummary = {
  kind: 'event'
  id: string
  household_id: string
  title: string
  // API name is `date` (the union's shared field — the month grouping keys on
  // it across kinds); the column is event_date.
  date: string
  time: string | null
  visibility: EventVisibility
  // null = whole household ('all'). An empty array means a 'members' event
  // whose every listed member row cascaded away — visible to the creator only.
  member_ids: string[] | null
  created_by_member_id: string | null
  created_at: string
  updated_at: string
}

/** One expiry-bearing document row, as the deadline projection consumes it. */
export type DeadlineDocument = {
  id: string
  name: string
  member_id: string | null
  expires_on: string
  remind_days_before: number | null
}

/** A derived (never stored) calendar entry for a document deadline. The id is
 * the document id namespaced with `doc:` — a stored event's dashed UUID can
 * never collide with it, so frontend keys are stable across reads. */
export type DeadlineEntry = {
  kind: 'deadline'
  id: string
  document_id: string
  // The document's free-text name (#422) — user data, rendered as-is.
  title: string
  date: string
  // The document's member (whose KTP/paspor it is) — nullable for
  // household-level documents (kartu keluarga).
  member_id: string | null
  // Computed, never stored twice (#434 discipline): whole UTC days until
  // expiry, negative = expired.
  days_until_expiry: number
  // The document's own reminder window (#426) applied: days <= window
  // (NULL window reads as the 30-day default). Expired documents are always
  // due — they are the most overdue deadline on the grid.
  due_soon: boolean
}

/** The union the calendar endpoint serves — ONE shape for the month grid. */
export type CalendarEntry = EventSummary | DeadlineEntry

export class CalendarValidationError extends Error {
  constructor(message = 'Invalid calendar event') {
    super(message)
    this.name = 'CalendarValidationError'
  }
}

// One message for unknown ids, another household's ids, AND events the caller
// may not see (restricted visibility) — the scoped lookup makes them
// indistinguishable (no existence leak).
export class CalendarNotFoundError extends Error {
  constructor(message = 'Event not found') {
    super(message)
    this.name = 'CalendarNotFoundError'
  }
}

export class CalendarForbiddenError extends Error {
  constructor(message = 'Only the event creator or a household owner can do that') {
    super(message)
    this.name = 'CalendarForbiddenError'
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * A REAL calendar date in YYYY-MM-DD form — the regex alone accepts
 * 2026-02-31. Reuses the documents domain's validator (#426): one calendar
 * rule for every household-facing date (thermos A3 discipline — the tasks
 * domain already imports it for the same reason).
 */
export { isValidExpiryDate as isValidEventDate } from './document-expiry.js'

/**
 * Optional wall-clock time, 'HH:MM' 24h — the storage shape (0031). Lexicographic
 * order = chronological order.
 */
export function isValidEventTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

// ---------------------------------------------------------------------------
// Deadline derivation (the differentiator — pure, fixed-clock testable)
// ---------------------------------------------------------------------------

/**
 * Project expiry-bearing document rows into calendar entries. Pure: `today`
 * is an injectable parameter (householdIsoDate-pinned, the #426 WIB
 * discipline) so the fixed-clock tests are exact. Rows are already
 * household-scoped and window-filtered by the caller's SQL — this function
 * owns ONLY the projection: the doc: id, the computed distance, and the
 * due-soon signal from the document's own reminder window.
 */
export function deriveDeadlineEntries(
  documents: DeadlineDocument[],
  today: string
): DeadlineEntry[] {
  return documents.flatMap((doc) => {
    const days = daysUntil(doc.expires_on, today)
    if (days === null) return [] // Invalid stored date — degrade, never invent.
    const window = doc.remind_days_before ?? DEFAULT_REMIND_DAYS_BEFORE
    return [
      {
        kind: 'deadline' as const,
        id: `doc:${doc.id}`,
        document_id: doc.id,
        title: doc.name,
        date: doc.expires_on,
        member_id: doc.member_id,
        days_until_expiry: days,
        due_soon: days <= window,
      },
    ]
  })
}

/** Deterministic day-chronological merge order shared by every entry kind:
 * date, then all-day entries before timed ones, then time, then title, then
 * id (the 0022 tiebreaker discipline). */
export function compareEntries(a: CalendarEntry, b: CalendarEntry): number {
  if (a.date !== b.date) return a.date.localeCompare(b.date)
  const aTime = 'time' in a ? a.time : null
  const bTime = 'time' in b ? b.time : null
  if (aTime !== bTime) {
    if (aTime === null) return -1
    if (bTime === null) return 1
    return aTime.localeCompare(bTime)
  }
  if (a.title !== b.title) return a.title.localeCompare(b.title)
  return a.id.localeCompare(b.id)
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

// Exported for the migrations test's EXPLAIN pin, so the plan proof always
// EXPLAINs the exact shipped statement — verbatim by construction, never a
// copied literal that can drift (the #445 thermos B1 lesson).
export const EVENT_SELECT = `SELECT e.id, e.household_id, e.title, e.event_date,
       e.event_time, e.visibility, e.created_by_member_id, e.created_at,
       e.updated_at
  FROM household_calendar_events e`

// The visibility predicate — ONE definition for the list AND the scoped
// mutation lookup, so a read view and a write path can never disagree about
// who sees a 'members' event. `me` is the caller's surrogate member id; the
// household OWNER always reads (the third EXISTS — scoped to the event's
// household, so an owner of ANOTHER household gains nothing). Owner bypass is
// what keeps the design coherent: the 0031 creator column is ON DELETE SET
// NULL (authorization falls back to the owners), an audience can be replaced
// to exclude its own editor, and a depleted audience must stay manageable by
// somebody — all three collapse to "nobody can touch this event" without it.
// Member-scoped visibility therefore hides from NON-owner members; the tasks
// domain's no-read-hiding philosophy is the same trade.
export const VISIBLE_PREDICATE = `(e.visibility = 'all' OR e.created_by_member_id = ? OR EXISTS (
      SELECT 1 FROM household_calendar_event_members vm
       WHERE vm.event_id = e.id AND vm.member_id = ?) OR EXISTS (
      SELECT 1 FROM household_members om
       WHERE om.id = ? AND om.household_id = e.household_id AND om.role = 'owner'))`

function toEventRow(row: {
  id: string
  household_id: string
  title: string
  event_date: string
  event_time: string | null
  visibility: string
  created_by_member_id: string | null
  created_at: string
  updated_at: string
}): CalendarEventRow {
  // visibility comes back from SQLite as TEXT; the CHECK constrains the set —
  // narrow once, at the boundary.
  return { ...row, visibility: row.visibility as EventVisibility }
}

function toSummary(event: CalendarEventRow, memberIds: string[] | null): EventSummary {
  return {
    kind: 'event',
    id: event.id,
    household_id: event.household_id,
    title: event.title,
    date: event.event_date,
    time: event.event_time,
    visibility: event.visibility,
    member_ids: memberIds,
    created_by_member_id: event.created_by_member_id,
    created_at: event.created_at,
    updated_at: event.updated_at,
  }
}

/** The audience rows for the given events — one bound IN query (household
 * scale: the placeholder list stays small), so a summary's member_ids can
 * never disagree with the table. */
async function getEventMembers(db: D1Database, eventIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (eventIds.length === 0) return map
  const placeholders = eventIds.map(() => '?').join(', ')
  const { results } = await db
    .prepare(
      `SELECT event_id, member_id FROM household_calendar_event_members
        WHERE event_id IN (${placeholders})
        ORDER BY member_id`
    )
    .bind(...eventIds)
    .all<{ event_id: string; member_id: string }>()
  for (const row of results) {
    const list = map.get(row.event_id)
    if (list) list.push(row.member_id)
    else map.set(row.event_id, [row.member_id])
  }
  return map
}

/**
 * The caller's member row in the active household — the actor handle for
 * created_by and the visibility predicate. Unreachable in practice (the auth
 * middleware resolves householdId FROM household_members), but the
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
    throw new CalendarForbiddenError('Household membership not found')
  }
  return caller
}

/**
 * The subset of `memberIds` that are members of THIS household — one chunked
 * IN pass (the selectIn helper, the getEventMembers pattern) instead of one
 * round trip per id. Scoped to the household, so a valid id from ANOTHER
 * household resolves as missing; the route diffs the set against its input
 * and 400s on the first absent id (a body-reference problem, not an
 * addressable-resource probe — the documents resolveMemberId pattern). Both
 * modes (0021) reference here.
 */
export async function findHouseholdMembers(
  db: D1Database,
  householdId: string,
  memberIds: string[]
): Promise<Set<string>> {
  if (memberIds.length === 0) return new Set()
  const rows = await selectIn<{ id: string }>(
    db,
    'SELECT id FROM household_members WHERE household_id = ? AND id IN',
    memberIds,
    [householdId]
  )
  return new Set(rows.map((row) => row.id))
}

/**
 * The calendar view (ahaqqu/RumaQ#430): the UNION of stored events and
 * derived document deadlines inside an optional [from, to] ISO window (each
 * bound optional — absent means unbounded on that side). Every query carries
 * the household predicate; events additionally carry the visibility predicate
 * (the header's read model). Deadlines derive on read from the documents
 * table (idx_documents_household_expiry, 0026, serves the window seek) —
 * no stored copy to drift, an expires_on edit shows on the next read.
 */
export async function listCalendarEntries(
  db: D1Database,
  householdId: string,
  viewerMemberId: string,
  window: { from?: string; to?: string } = {},
  now: Date = new Date()
): Promise<CalendarEntry[]> {
  const conditions = ['e.household_id = ?', VISIBLE_PREDICATE]
  const params: string[] = [householdId, viewerMemberId, viewerMemberId, viewerMemberId]
  if (window.from !== undefined) {
    conditions.push('e.event_date >= ?')
    params.push(window.from)
  }
  if (window.to !== undefined) {
    conditions.push('e.event_date <= ?')
    params.push(window.to)
  }
  const { results } = await db
    .prepare(
      `${EVENT_SELECT}
        WHERE ${conditions.join(' AND ')}
        ORDER BY e.event_date, e.event_time, e.created_at, e.id`
    )
    .bind(...params)
    .all<Record<string, unknown>>()
  const events = results.map((row) => toEventRow(row as Parameters<typeof toEventRow>[0]))
  const membersByEvent = await getEventMembers(
    db,
    events.filter((e) => e.visibility === 'members').map((e) => e.id)
  )
  const eventEntries = events.map((e) =>
    toSummary(e, e.visibility === 'members' ? (membersByEvent.get(e.id) ?? []) : null)
  )

  const deadlineConditions = ['household_id = ?', 'expires_on IS NOT NULL']
  const deadlineParams: string[] = [householdId]
  if (window.from !== undefined) {
    deadlineConditions.push('expires_on >= ?')
    deadlineParams.push(window.from)
  }
  if (window.to !== undefined) {
    deadlineConditions.push('expires_on <= ?')
    deadlineParams.push(window.to)
  }
  const { results: docs } = await db
    .prepare(
      `SELECT id, name, member_id, expires_on, remind_days_before
         FROM documents
        WHERE ${deadlineConditions.join(' AND ')}
        ORDER BY expires_on, id`
    )
    .bind(...deadlineParams)
    .all<DeadlineDocument>()

  // The household calendar day, pinned at UTC+7 (WIB) — the #426 discipline
  // for household-facing dates (thermos A3): a plain-UTC "today" left every
  // due-soon boundary ~7 hours late each WIB night.
  const today = householdIsoDate(now)
  const deadlineEntries = deriveDeadlineEntries(docs, today)

  return [...eventEntries, ...deadlineEntries].sort(compareEntries)
}

/**
 * The scoped, VISIBILITY-RESPECTED single-event lookup for mutations: the
 * household predicate and the visibility predicate ride in the SQL, so a
 * foreign household's id AND a 'members' event the caller is not a reader of
 * are both "not found", answered before any authz decision (no existence
 * leak). The audience rows come back alongside when the event is
 * 'members'-scoped — the PATCH validation needs the current list.
 */
export async function getEventForActor(
  db: D1Database,
  householdId: string,
  viewerMemberId: string,
  eventId: string
): Promise<{ event: CalendarEventRow; memberIds: string[] | null } | null> {
  const row = await db
    .prepare(`${EVENT_SELECT} WHERE e.id = ? AND e.household_id = ? AND ${VISIBLE_PREDICATE}`)
    .bind(eventId, householdId, viewerMemberId, viewerMemberId, viewerMemberId)
    .first<Record<string, unknown>>()
  if (!row) return null
  const event = toEventRow(row as Parameters<typeof toEventRow>[0])
  const memberIds =
    event.visibility === 'members'
      ? ((await getEventMembers(db, [event.id])).get(event.id) ?? [])
      : null
  return { event, memberIds }
}

// ---------------------------------------------------------------------------
// Permissions (lib-owned so routes never re-derive roles — the households
// requireOwner discipline)
// ---------------------------------------------------------------------------

function isOwner(caller: CallerMember): boolean {
  return caller.role === 'owner'
}

function isCreator(event: CalendarEventRow, caller: CallerMember): boolean {
  return event.created_by_member_id !== null && event.created_by_member_id === caller.memberId
}

function insertAuditStatement(
  db: D1Database,
  args: { eventId: string; householdId: string; actorUserId: string; action: CalendarAction }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO household_calendar_event_audit (id, event_id, household_id, actor_user_id, action)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(crypto.randomUUID(), args.eventId, args.householdId, args.actorUserId, args.action)
}

/**
 * The audit row for a GUARDED mutation (ahaqqu/RumaQ#445 thermos A1 — the
 * updateTask/updateDocumentExpiry pattern): an INSERT..SELECT gated on the
 * row the mutation just touched, so a race between the caller's pre-check and
 * this batch commits NEITHER the write NOR a spurious audit record.
 */
function guardedAuditStatement(
  db: D1Database,
  args: {
    eventId: string
    householdId: string
    actorUserId: string
    action: CalendarAction
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO household_calendar_event_audit (id, event_id, household_id, actor_user_id, action)
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM household_calendar_events WHERE id = ? AND household_id = ?
       )`
    )
    .bind(
      crypto.randomUUID(),
      args.eventId,
      args.householdId,
      args.actorUserId,
      args.action,
      args.eventId,
      args.householdId
    )
}

/**
 * The gated per-member visibility row: an INSERT..SELECT that stays silent
 * when the event vanished between the pre-check and this batch, so a raced
 * delete can never leave an audience row pointing at a dead event (the FK
 * would abort the whole transaction) — the guarded-audit idea applied to the
 * audience rows.
 */
function gatedEventMemberStatement(
  db: D1Database,
  args: { eventId: string; householdId: string; memberId: string }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO household_calendar_event_members (event_id, member_id)
       SELECT ?, ?
       WHERE EXISTS (
         SELECT 1 FROM household_calendar_events WHERE id = ? AND household_id = ?
       )`
    )
    .bind(args.eventId, args.memberId, args.eventId, args.householdId)
}

// Reads meta.changes off a batch result. Undefined (the mocked D1 in the
// route tests) counts as success — the real meta.changes behavior is pinned
// in calendar-sql.test.ts (the tasks readChanges convention).
function readChanges(result: unknown): number {
  const changes = (result as { meta?: { changes?: number } } | undefined)?.meta?.changes
  return changes === undefined ? 1 : changes
}

// ---------------------------------------------------------------------------
// Mutations — every write is GUARDED (ahaqqu/RumaQ#445 thermos A1): the
// UPDATE/DELETE carries its preconditions in the WHERE, the audit row rides
// the gated INSERT..SELECT, and the caller reads meta.changes to answer the
// typed 404 instead of failing a read-back with a 500. Every write carries
// its audit row in the SAME batch (an audit row that can be skipped by a
// crash is a rumor). Authorization re-derives the caller's member row INSIDE
// the lib from (householdId, userId) — the vault's discipline.
// ---------------------------------------------------------------------------

/**
 * Create: free-text title (trimmed/bounded by the route's schema), real
 * calendar date, optional HH:MM time, visibility ('all' default) and — for
 * 'members' — a validated, deduped audience list. The event row, its audience
 * rows and the 'create' audit record commit in one batch.
 */
export async function createEvent(
  db: D1Database,
  args: {
    householdId: string
    userId: string
    title: string
    date: string
    time: string | null
    visibility: EventVisibility
    memberIds: string[] // resolved to household members by the route; deduped
  }
): Promise<EventSummary> {
  const caller = await requireCallerMember(db, args.householdId, args.userId)
  const eventId = crypto.randomUUID()
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO household_calendar_events
           (id, household_id, title, event_date, event_time, visibility, created_by_member_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        eventId,
        args.householdId,
        args.title,
        args.date,
        args.time,
        args.visibility,
        caller.memberId
      ),
  ]
  if (args.visibility === 'members') {
    // The route resolved and deduped the ids against this household; a fresh
    // UUID precedes them in the same batch, so the FK holds by construction.
    for (const memberId of args.memberIds) {
      statements.push(
        db
          .prepare(
            'INSERT INTO household_calendar_event_members (event_id, member_id) VALUES (?, ?)'
          )
          .bind(eventId, memberId)
      )
    }
  }
  statements.push(
    insertAuditStatement(db, {
      eventId,
      householdId: args.householdId,
      actorUserId: args.userId,
      action: 'create',
    })
  )
  await db.batch(statements)

  const stored = await getEventForActor(db, args.householdId, caller.memberId, eventId)
  if (!stored) {
    // Unreachable in practice (a fresh UUID in the same household, creator is
    // always a reader); the typed 404 is the honest answer if a concurrent
    // delete somehow won anyway.
    throw new CalendarNotFoundError()
  }
  return toSummary(stored.event, stored.memberIds)
}

export type EventEditPatch = {
  title?: string
  date?: string
  time?: string | null
  visibility?: EventVisibility
  // Present ONLY when the route accepted a member-list change (the route owns
  // the cross-field rules against the CURRENT row — member_ids alone is a
  // 400 unless the event is already 'members'-scoped).
  memberIds?: string[]
}

/**
 * Edit fields (title/date/time/visibility/audience). Creator or owner only —
 * a member manages the events they created; owners manage the household's.
 * The UPDATE is guarded on (id, household); the audit row rides the gated
 * INSERT..SELECT; audience rows are replaced in the SAME batch via gated
 * inserts, so visibility flips and audience edits commit atomically with the
 * event write. A raced delete answers 404 — never a phantom update, never an
 * orphaned audience row.
 */
export async function updateEvent(
  db: D1Database,
  args: {
    householdId: string
    userId: string
    event: CalendarEventRow
    memberIds: string[] | null
    patch: EventEditPatch
  }
): Promise<EventSummary> {
  const { event } = args
  const caller = await requireCallerMember(db, args.householdId, args.userId)
  if (!isCreator(event, caller) && !isOwner(caller)) {
    throw new CalendarForbiddenError()
  }

  const updates: string[] = []
  const params: unknown[] = []
  if (args.patch.title !== undefined) {
    updates.push('title = ?')
    params.push(args.patch.title)
  }
  if (args.patch.date !== undefined) {
    updates.push('event_date = ?')
    params.push(args.patch.date)
  }
  if (args.patch.time !== undefined) {
    updates.push('event_time = ?')
    params.push(args.patch.time)
  }
  if (args.patch.visibility !== undefined) {
    updates.push('visibility = ?')
    params.push(args.patch.visibility)
  }
  // An empty patch is a no-op read — the current row comes back, not a write
  // (the households updateMemberProfile precedent).
  if (updates.length === 0 && args.patch.memberIds === undefined) {
    const current = await getEventForActor(db, args.householdId, caller.memberId, event.id)
    if (!current) {
      throw new CalendarNotFoundError()
    }
    return toSummary(current.event, current.memberIds)
  }

  updates.push("updated_at = datetime('now')")
  params.push(event.id, args.householdId)

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE household_calendar_events SET ${updates.join(', ')}
          WHERE id = ? AND household_id = ?`
      )
      .bind(...params),
    guardedAuditStatement(db, {
      eventId: event.id,
      householdId: args.householdId,
      actorUserId: args.userId,
      action: 'update',
    }),
  ]

  const nextVisibility = args.patch.visibility ?? event.visibility
  if (args.patch.memberIds !== undefined) {
    // Explicit audience replacement rides the same batch: clear, then gated
    // inserts. (The route forbids member_ids under a resulting 'all', so the
    // inserts only run for a 'members' result — the check stays defensive.)
    statements.push(
      db.prepare('DELETE FROM household_calendar_event_members WHERE event_id = ?').bind(event.id)
    )
    if (nextVisibility === 'members') {
      for (const memberId of args.patch.memberIds) {
        statements.push(
          gatedEventMemberStatement(db, {
            eventId: event.id,
            householdId: args.householdId,
            memberId,
          })
        )
      }
    }
  } else if (args.patch.visibility === 'all' && event.visibility === 'members') {
    // A visibility flip to 'all' clears the audience. A flip to 'members'
    // WITHOUT an explicit list keeps the current rows — they are the audience
    // being re-affirmed (the route 400s when they are empty).
    statements.push(
      db.prepare('DELETE FROM household_calendar_event_members WHERE event_id = ?').bind(event.id)
    )
  }

  const results = await db.batch(statements)
  if (readChanges(results[0]) === 0) {
    // The guard refused: a concurrent delete took the row between the
    // pre-check and this batch (404, never a 500 read-back).
    throw new CalendarNotFoundError()
  }

  const stored = await getEventForActor(db, args.householdId, caller.memberId, event.id)
  if (!stored) {
    // The write committed, but the event became invisible to this actor
    // before the read-back — either a concurrent delete (404) or the actor
    // edited themselves OUT of the audience. The latter is refused at the
    // route (a 'members' event's audience must stay non-empty, and the
    // creator is implicitly a reader), so 404 is the honest answer here too.
    throw new CalendarNotFoundError()
  }
  return toSummary(stored.event, stored.memberIds)
}

/**
 * Delete: creator or owner. The 'delete' audit row is gated on the row still
 * existing (thermos A1) and written BEFORE the delete INSIDE the same batch,
 * surviving it (no FK on household_calendar_event_audit.event_id — the
 * deletion record must outlive the row it names, the 0022/0027 discipline).
 * The audience rows cascade with the event. A raced delete commits neither a
 * phantom audit record nor a no-op delete: changes === 0 answers 404.
 */
export async function deleteEvent(
  db: D1Database,
  args: {
    householdId: string
    userId: string
    event: CalendarEventRow
  }
): Promise<void> {
  const { event } = args
  const caller = await requireCallerMember(db, args.householdId, args.userId)
  if (!isCreator(event, caller) && !isOwner(caller)) {
    throw new CalendarForbiddenError()
  }

  const results = await db.batch([
    guardedAuditStatement(db, {
      eventId: event.id,
      householdId: args.householdId,
      actorUserId: args.userId,
      action: 'delete',
    }),
    db
      .prepare('DELETE FROM household_calendar_events WHERE id = ? AND household_id = ?')
      .bind(event.id, args.householdId),
  ])
  if (readChanges(results[1]) === 0) {
    throw new CalendarNotFoundError()
  }
}
