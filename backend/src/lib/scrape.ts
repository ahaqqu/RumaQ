import type { ScrapeEvent } from '@rumaq/contract'

// Admin-triggered scrape commands (docs/plan/scrape-now.md §3): a D1-backed
// command queue between the admin UI and the VPS polling agent. One run at a
// time (a pending/running command blocks new ones); the agent claims, streams
// events, and posts a terminal finish. Timestamps are ISO strings so they
// sort lexically — the same convention as price_runs.

export class ScrapeConflictError extends Error {
  constructor(message = 'A scrape is already pending or running') {
    super(message)
    this.name = 'ScrapeConflictError'
  }
}

export class ScrapeNotFoundError extends Error {
  constructor() {
    super('Scrape command not found')
    this.name = 'ScrapeNotFoundError'
  }
}

/** Commands stuck in 'running' for longer than this are swept to 'failed'. */
const STALE_RUNNING_AFTER_MS = 2 * 60 * 60 * 1000
/** History cap — older commands (and their events) are pruned on create. */
const HISTORY_LIMIT = 50

export type ScrapeCommandRow = {
  id: string
  stores: string[]
  status: 'pending' | 'running' | 'success' | 'failed'
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
    status: (row.status === 'running' || row.status === 'success' || row.status === 'failed'
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

export async function createScrapeCommand(
  db: D1Database,
  { stores, createdBy }: { stores: string[]; createdBy: string }
): Promise<{ id: string }> {
  // One run at a time: the scraper's lock file serialises processes on the
  // VPS, but a queued backlog would surprise the admin — refuse instead.
  const active = await db
    .prepare(`SELECT id FROM scrape_commands WHERE status IN ('pending', 'running') LIMIT 1`)
    .first<{ id: string }>()
  if (active) throw new ScrapeConflictError()

  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO scrape_commands (id, stores, status, created_by, created_at)
       VALUES (?, ?, 'pending', ?, ?)`
    )
    .bind(id, JSON.stringify(stores), createdBy, createdAt)
    .run()

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
  // Lazy stale sweep first: an agent that died mid-run (VPS reboot, OOM) must
  // not wedge the queue forever — after 2h without a terminal report the run
  // is marked failed and the queue opens up again.
  const staleBefore = new Date(Date.now() - STALE_RUNNING_AFTER_MS).toISOString()
  await db
    .prepare(
      `UPDATE scrape_commands
       SET status = 'failed', finished_at = ?, error = 'agent lost — no terminal report'
       WHERE status = 'running' AND picked_up_at < ?`
    )
    .bind(staleBefore, staleBefore)
    .run()

  // Two-step claim: pick the oldest pending, then flip it conditionally —
  // the `AND status = 'pending'` guard makes a double-claim return nothing.
  const oldest = await db
    .prepare(`SELECT id FROM scrape_commands WHERE status = 'pending' ORDER BY created_at LIMIT 1`)
    .first<{ id: string }>()
  if (!oldest) return null

  const claimed = await db
    .prepare(
      `UPDATE scrape_commands
       SET status = 'running', picked_up_at = ?
       WHERE id = ? AND status = 'pending'
       RETURNING id, stores, created_at`
    )
    .bind(new Date().toISOString(), oldest.id)
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
  if (command.status === 'success' || command.status === 'failed') {
    throw new ScrapeConflictError('Command already finished')
  }

  // Idempotent by (command_id, seq): agent retries after a network error are
  // safe, and a replayed batch cannot duplicate rows.
  await db.batch(
    events.map((event) =>
      db
        .prepare(
          `INSERT INTO scrape_run_events (command_id, seq, ts, level, message)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (command_id, seq) DO NOTHING`
        )
        .bind(commandId, event.seq, event.ts, event.level, event.message)
    )
  )
}

export type ScrapeFinishInput = {
  status: 'success' | 'failed'
  exitCode: 0 | 1 | 2
  error?: string | null
  logTruncated?: boolean | null
}

/** Only running→terminal; repeat finishes and unknown commands are no-ops. */
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
