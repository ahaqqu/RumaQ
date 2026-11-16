import type { ScrapeEvent } from '@rumaq/contract'

// Admin-triggered scrape commands (docs/plan/scrape-now.md §3): a D1-backed
// command queue between the admin UI and the VPS polling agent. One run at a
// time (a FRESH pending/running command blocks new ones); the agent claims,
// streams events, and posts a terminal finish. Timestamps are ISO strings so
// they sort lexically — the same convention as price_runs.
//
// The command is a LEASE (audit 2026-11-16 M1): the claim stamps
// heartbeat_at, every events POST renews it, and the reaper fires on SILENCE
// — a run that keeps reporting is never reaped, however long it runs. A
// silent run reaps to the named `reaped` state (never a `failed` — the run
// did not fail, it vanished; exit_code stays NULL because no exit happened),
// and a finish that lands after the reap answers 409: the report is dropped,
// and the agent must know that instead of reading a phantom ok.

/** The live command the queue is currently blocked by. */
export type ActiveScrapeCommand = {
  id: string
  status: 'pending' | 'running'
  createdAt: string
  pickedUpAt: string | null
}

export class ScrapeConflictError extends Error {
  /** The live command that blocked the call, when known (create path). */
  readonly activeCommand: ActiveScrapeCommand | null

  constructor(
    activeCommand: ActiveScrapeCommand | null = null,
    message = 'A scrape is already pending or running'
  ) {
    super(message)
    this.name = 'ScrapeConflictError'
    this.activeCommand = activeCommand
  }
}

export class ScrapeNotFoundError extends Error {
  constructor() {
    super('Scrape command not found')
    this.name = 'ScrapeNotFoundError'
  }
}

/**
 * The lease ceilings — the one place both reapers (create and claim) read.
 *
 * RUNNING rows reap on SILENCE, not on age: the guard reads
 * `coalesce(heartbeat_at, picked_up_at, created_at)`, which the claim stamps
 * and every events POST renews. 45 min of silence means the agent stopped
 * reporting — the run died, the box went down, or the process hangs without
 * emitting events — and no finish report is coming. The comparison is strict
 * (`silence > ceiling`): a row exactly at its ceiling is still live. NOTHING
 * here depends on the pipeline's `RUN_DEADLINE_MS` (the audit C3 coupling —
 * a live run of ANY age keeps renewing its heartbeat, so RumaQ can never
 * reap a run the pipeline still considers alive; the pipeline's own
 * child-kill remains the authority on how long a run may compute).
 *
 * The third COALESCE fallback (created_at) covers a hand-written 'running'
 * row with no pickup and no heartbeat: the claim always sets both, but a bad
 * row must not wedge the one-at-a-time queue forever.
 *
 * A healthy agent polls every 15 s and posts events throughout the run; an
 * hour without a claim means the agent (or the box) is down and a PENDING
 * row will never be picked up — the pending reap keeps its age-from-create
 * ceiling, which no heartbeat exists to renew.
 */
const RUNNING_SILENCE_AFTER_MINUTES = 45
const PENDING_REAP_AFTER_MINUTES = 60

/** Exported for tests: the exact ceilings the reaper applies. */
export const STALE_SILENCE_AFTER_MS = RUNNING_SILENCE_AFTER_MINUTES * 60 * 1000
export const STALE_PENDING_AFTER_MS = PENDING_REAP_AFTER_MINUTES * 60 * 1000

const RUNNING_REAP_ERROR = `reaped: silent for ${RUNNING_SILENCE_AFTER_MINUTES} min (no heartbeat, events, or finish report)`
const PENDING_REAP_ERROR = `reaped: never picked up after ${PENDING_REAP_AFTER_MINUTES} min`

/** History cap — older commands (and their events) are pruned on create. */
const HISTORY_LIMIT = 50

export type ScrapeCommandRow = {
  id: string
  stores: string[]
  status: 'pending' | 'running' | 'success' | 'failed' | 'reaped'
  createdBy: string
  createdAt: string
  pickedUpAt: string | null
  finishedAt: string | null
  exitCode: number | null
  error: string | null
  logTruncated: boolean
}

type ScrapeCommandSqlRow = {
  id: string
  stores: string
  status: string
  created_by: string
  created_at: string
  picked_up_at: string | null
  finished_at: string | null
  exit_code: number | null
  error: string | null
  log_truncated: number
}

/** The one JSON-parse guard for the stored stores blob (feed rows + claims). */
function parseCommandStores(storesJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(storesJson)
    if (Array.isArray(parsed)) return parsed.map(String)
  } catch {
    // A malformed blob must never break the whole feed.
  }
  return []
}

function toCommand(row: ScrapeCommandSqlRow): ScrapeCommandRow {
  return {
    id: row.id,
    stores: parseCommandStores(row.stores),
    status: (row.status === 'running' ||
    row.status === 'success' ||
    row.status === 'failed' ||
    row.status === 'reaped'
      ? row.status
      : 'pending') as ScrapeCommandRow['status'],
    createdBy: row.created_by,
    createdAt: row.created_at,
    pickedUpAt: row.picked_up_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    error: row.error,
    logTruncated: row.log_truncated === 1,
  }
}

type ActiveScrapeCommandSqlRow = {
  id: string
  status: string
  created_at: string
  picked_up_at: string | null
}

function toActiveCommand(row: ActiveScrapeCommandSqlRow): ActiveScrapeCommand {
  return {
    id: row.id,
    status: row.status === 'running' ? 'running' : 'pending',
    createdAt: row.created_at,
    pickedUpAt: row.picked_up_at,
  }
}

/** D1 reports per-statement `meta.changes`; a batch SELECT reports 0. */
function changesOf(result: unknown): number {
  const meta = (result as { meta?: { changes?: number } } | undefined)?.meta
  return meta?.changes ?? 0
}

/**
 * The two reaper flips as prepared statements, so the create path can run them
 * in the SAME batch as its guarded INSERT. Age comparisons are lexical (ISO
 * timestamps sort chronologically), the same convention as the rest of the
 * table. Both flip to the NAMED `reaped` state and leave `exit_code` alone —
 * a reaped run never finished, so there is no exit code to record (the old
 * `failed` + exit_code 1 overloading is what audit M1 replaces); the error
 * string names the cause. `finished_at` stamps when the reaper closed the row.
 */
function staleReapStatements(db: D1Database, now: string): D1PreparedStatement[] {
  const nowMs = Date.parse(now)
  const silentBefore = new Date(nowMs - STALE_SILENCE_AFTER_MS).toISOString()
  const pendingBefore = new Date(nowMs - STALE_PENDING_AFTER_MS).toISOString()
  return [
    // SILENCE reap: heartbeat_at (claim-stamped, events-renewed) with
    // picked_up_at as the pre-lease fallback and created_at covering a
    // hand-written row with neither. A run that reports ANY event is live —
    // total age is irrelevant.
    db
      .prepare(
        `UPDATE scrape_commands
         SET status = 'reaped', error = ?, finished_at = ?
         WHERE status = 'running'
           AND COALESCE(heartbeat_at, picked_up_at, created_at) < ?`
      )
      .bind(RUNNING_REAP_ERROR, now, silentBefore),
    db
      .prepare(
        `UPDATE scrape_commands
         SET status = 'reaped', error = ?, finished_at = ?
         WHERE status = 'pending' AND created_at < ?`
      )
      .bind(PENDING_REAP_ERROR, now, pendingBefore),
  ]
}

export async function createScrapeCommand(
  db: D1Database,
  { stores, createdBy }: { stores: string[]; createdBy: string }
): Promise<{ id: string }> {
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()

  // One run at a time, without a SELECT-then-INSERT race:
  //
  // - Cloudflare runs db.batch() as ONE SQL transaction, with the statements
  //   executed sequentially and non-concurrently (D1 worker API docs), against
  //   the database's single SQLite writer. Two concurrent creates therefore
  //   cannot interleave their reaper/INSERT statements (D1 has no interactive
  //   BEGIN/COMMIT for Workers; a batch is the transaction primitive).
  // - The two reaper UPDATEs run first INSIDE that transaction, so the
  //   conflict check can only see rows that survived the stale ceilings.
  // - The INSERT is also the check: `WHERE NOT EXISTS (…pending/running…)`
  //   makes two concurrent creates unable to both write — the loser selects
  //   no row, so its statement reports meta.changes = 0. The SELECT after it,
  //   in the same transaction, names the live command for the 409 body.
  //
  // Net effect: exactly one pending row can exist, and a 409 is only raised
  // for a command that was fresh when this transaction ran.
  const reap = staleReapStatements(db, createdAt)
  const results = await db.batch([
    ...reap,
    db
      .prepare(
        `INSERT INTO scrape_commands (id, stores, status, created_by, created_at)
         SELECT ?, ?, 'pending', ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM scrape_commands WHERE status IN ('pending', 'running')
         )`
      )
      .bind(id, JSON.stringify(stores), createdBy, createdAt),
    db
      .prepare(
        `SELECT id, status, created_at, picked_up_at
         FROM scrape_commands
         WHERE status IN ('pending', 'running')
         ORDER BY created_at, id
         LIMIT 1`
      )
      .bind(),
  ])

  if (changesOf(results[reap.length]) === 0) {
    const active = (results[reap.length + 1]?.results?.[0] ??
      null) as ActiveScrapeCommandSqlRow | null
    throw new ScrapeConflictError(active ? toActiveCommand(active) : null)
  }

  // History cap: drop everything beyond the newest 50 (events explicitly —
  // the FK cascade is a no-op if the box runs with foreign_keys off).
  const old = await db
    .prepare(
      `SELECT id FROM scrape_commands WHERE id NOT IN (
         SELECT id FROM scrape_commands ORDER BY created_at DESC, id DESC LIMIT ?
       )`
    )
    .bind(HISTORY_LIMIT)
    .all<{ id: string }>()
  if ((old.results ?? []).length > 0) {
    const ids = (old.results ?? []).map((row) => row.id)
    const placeholders = ids.map(() => '?').join(', ')
    await db.batch([
      db
        .prepare(`DELETE FROM scrape_run_events WHERE command_id IN (${placeholders})`)
        .bind(...ids),
      db.prepare(`DELETE FROM scrape_commands WHERE id IN (${placeholders})`).bind(...ids),
    ])
  }

  return { id }
}

export type ClaimedCommand = {
  id: string
  stores: string[]
  createdAt: string
}

export async function claimNextScrapeCommand(db: D1Database): Promise<ClaimedCommand | null> {
  // Lazy stale sweep first: an agent that died mid-run (VPS reboot, OOM), or
  // a command the box never picked up, must not wedge the queue forever. It
  // uses the exact same ceilings and error strings as the create path, so the
  // two reapers cannot drift.
  await db.batch(staleReapStatements(db, new Date().toISOString()))

  // Two-step claim: pick the oldest pending, then flip it conditionally —
  // the `AND status = 'pending'` guard makes a double-claim return nothing.
  // The id tiebreaker (#596, the #555 sweep's missed site): two commands
  // stamped in the same second (datetime('now') resolution) made the pick
  // nondeterministic.
  const oldest = await db
    .prepare(
      `SELECT id FROM scrape_commands WHERE status = 'pending' ORDER BY created_at, id LIMIT 1`
    )
    .bind()
    .first<{ id: string }>()
  if (!oldest) return null

  const claimed = await db
    .prepare(
      `UPDATE scrape_commands
       SET status = 'running', picked_up_at = ?, heartbeat_at = ?
       WHERE id = ? AND status = 'pending'
       RETURNING id, stores, created_at`
    )
    .bind(new Date().toISOString(), new Date().toISOString(), oldest.id)
    .first<{ id: string; stores: string; created_at: string }>()
  if (!claimed) return null

  return {
    id: claimed.id,
    stores: parseCommandStores(claimed.stores),
    createdAt: claimed.created_at,
  }
}

export async function appendScrapeEvents(
  db: D1Database,
  commandId: string,
  events: ScrapeEvent[]
): Promise<void> {
  const command = await db
    .prepare(`SELECT status FROM scrape_commands WHERE id = ?`)
    .bind(commandId)
    .first<{ status: string }>()
  if (!command) throw new ScrapeNotFoundError()
  // Every terminal state refuses events — `reaped` included: the agent's
  // post-reap retries (postJson gives up on a 4xx immediately) must not
  // append log lines to a row the reaper already closed.
  if (command.status === 'success' || command.status === 'failed' || command.status === 'reaped') {
    throw new ScrapeConflictError(null, 'Command already finished')
  }

  // Idempotent by (command_id, seq): agent retries after a network error are
  // safe, and a replayed batch cannot duplicate rows. The trailing UPDATE is
  // the LEASE RENEWAL (audit M1's `running | event` row): every events POST
  // pushes heartbeat_at to now, so a run that keeps logging is never reaped
  // no matter how long it computes. Guarded on 'running' — a pending row has
  // no lease yet (the claim stamps it), and the guard keeps a reap that
  // committed between the SELECT and this batch from being resurrected.
  await db.batch([
    ...events.map((event) =>
      db
        .prepare(
          `INSERT INTO scrape_run_events (command_id, seq, ts, level, message)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (command_id, seq) DO NOTHING`
        )
        .bind(commandId, event.seq, event.ts, event.level, event.message)
    ),
    db
      .prepare(
        `UPDATE scrape_commands SET heartbeat_at = ?
         WHERE id = ? AND status = 'running'`
      )
      .bind(new Date().toISOString(), commandId),
  ])
}

export type ScrapeFinishInput = {
  status: 'success' | 'failed'
  exitCode: 0 | 1 | 2
  error?: string | null
  logTruncated?: boolean | null
}

/**
 * Only running→terminal. A repeat finish after a successful one is a no-op
 * (the agent's postJson retries must stay idempotent); a finish after a REAP
 * answers 409 — the reaper closed the row, this report is DROPPED, and the
 * agent must learn that instead of reading a phantom ok (audit M1's
 * finish-after-reap row). The route maps the conflict to 409; postJson gives
 * up on the 4xx immediately.
 */
export async function finishScrapeCommand(
  db: D1Database,
  commandId: string,
  body: ScrapeFinishInput
): Promise<void> {
  const command = await db
    .prepare(`SELECT status FROM scrape_commands WHERE id = ?`)
    .bind(commandId)
    .first<{ status: string }>()
  if (!command) throw new ScrapeNotFoundError()
  if (command.status === 'reaped') {
    throw new ScrapeConflictError(
      null,
      'Command was reaped — the agent went silent and this finish is not accepted'
    )
  }
  if (command.status !== 'running') return

  await db
    .prepare(
      `UPDATE scrape_commands
       SET status = ?, finished_at = ?, exit_code = ?, error = ?, log_truncated = ?
       WHERE id = ? AND status = 'running'`
    )
    .bind(
      body.status,
      new Date().toISOString(),
      body.exitCode,
      body.error ?? null,
      body.logTruncated ? 1 : 0,
      commandId
    )
    .run()
}

export async function listScrapeCommands(db: D1Database, limit = 20): Promise<ScrapeCommandRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, stores, status, created_by, created_at, picked_up_at, finished_at,
              exit_code, error, log_truncated
       FROM scrape_commands
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<ScrapeCommandSqlRow>()
  return (results ?? []).map(toCommand)
}

export async function listScrapeEvents(
  db: D1Database,
  commandId: string,
  // -1 = the full log (seq 0 reachable) — the same semantic the route applies
  // when the admin omits afterSeq; 0 would silently skip the first line.
  afterSeq = -1,
  limit = 1000
): Promise<{ events: ScrapeEvent[]; truncated: boolean }> {
  const command = await db
    .prepare(`SELECT id, log_truncated FROM scrape_commands WHERE id = ?`)
    .bind(commandId)
    .first<{ id: string; log_truncated: number }>()
  if (!command) throw new ScrapeNotFoundError()

  const { results } = await db
    .prepare(
      `SELECT seq, ts, level, message
       FROM scrape_run_events
       WHERE command_id = ? AND seq > ?
       ORDER BY seq
       LIMIT ?`
    )
    .bind(commandId, afterSeq, limit)
    .all<{ seq: number; ts: string; level: string; message: string }>()
  return {
    events: (results ?? []).map((row) => ({
      seq: row.seq,
      ts: row.ts,
      level: row.level === 'error' ? ('error' as const) : ('info' as const),
      message: row.message,
    })),
    truncated: command.log_truncated === 1,
  }
}
