import type { ReviewItemPair } from '@rumaq/contract'

// Storage + queries for the match review queue (issue #294, docs/294-design.md
// §2/§3/§4). One row per flagged candidate pair; display fields ride the
// pair_data JSON blob (contract-owned schema, price_runs.match_stats
// precedent) while identity/ordering/decision fields are columns.
//
// Never-reopen invariant: the upsert's DO UPDATE list refreshes evidence
// columns only and never mentions status/decided_at/decided_by — a human
// verdict stands no matter how often the pair re-flags. first_flagged_at
// also stays, so recurrence stays visible on the record.

export type ReviewStatus = 'pending' | 'approved' | 'rejected'
export type ReviewDecision = 'approved' | 'rejected'

// Same budget math as ingest.ts: one db.batch() is one query against D1's
// per-invocation limit; 50 statements of 11 binds each keeps both the query
// budget and the per-statement parameter cap comfortable. The producer caps
// pairs at 200 per report (pipeline REVIEW_ITEM_PAIRS_CAP), so one ingest
// never exceeds 4 batches.
const BATCH_CHUNK = 50

type Statement = ReturnType<D1Database['prepare']>

async function runBatch(db: D1Database, statements: Statement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK))
  }
}

/**
 * Persist a run report's review pairs (called by the runs ingest handler
 * after recordRunReport). Idempotent per (item, entry): a failed pair insert
 * 500s the report, the scraper's report retry re-runs the whole idempotent
 * upsert set — at-least-once, safe.
 */
export async function recordReviewItems(
  db: D1Database,
  runStartedAt: string,
  pairs: ReviewItemPair[]
): Promise<void> {
  if (pairs.length === 0) return
  await runBatch(
    db,
    pairs.map((pair) =>
      db
        .prepare(
          `INSERT INTO match_review_items
             (id, item_product_key, entry_product_key, pair_data, reason, match_method,
              confidence, run_started_at, first_flagged_at, last_flagged_at, flag_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(item_product_key, entry_product_key) DO UPDATE SET
             pair_data = excluded.pair_data,
             reason = excluded.reason,
             match_method = excluded.match_method,
             confidence = excluded.confidence,
             run_started_at = excluded.run_started_at,
             last_flagged_at = excluded.last_flagged_at,
             flag_count = flag_count + 1`
        )
        .bind(
          crypto.randomUUID(),
          pair.itemProductKey,
          pair.entryProductKey,
          JSON.stringify(pair),
          pair.reason,
          pair.matchMethod,
          pair.confidence,
          runStartedAt,
          runStartedAt,
          runStartedAt
        )
    )
  )
}

// The list/export response flattens the pair_data blob with the column
// fields the queue acts on — nothing filters on display fields, so they
// never earned columns.
type ReviewRow = {
  id: string
  pair_data: string
  status: string
  decided_at: string | null
  decided_by: string | null
  flag_count: number
  first_flagged_at: string
  last_flagged_at: string
  run_started_at: string
  run_id?: string | null
}

export type ReviewItem = ReviewItemPair & {
  id: string
  status: ReviewStatus
  decidedAt: string | null
  decidedBy: string | null
  flagCount: number
  firstFlaggedAt: string
  lastFlaggedAt: string
  runStartedAt: string
  /** price_runs.id for the monitor deep-link; null when the run aged out. */
  runId: string | null
}

export type ReviewCounts = { pending: number; approved: number; rejected: number }

export type ReviewListPage = {
  items: ReviewItem[]
  counts: ReviewCounts
  filteredTotal: number
}

function parsePair(json: string): ReviewItemPair | null {
  try {
    return JSON.parse(json) as ReviewItemPair
  } catch {
    // A malformed blob must never break the whole page.
    return null
  }
}

function toReviewItem(row: ReviewRow): ReviewItem | null {
  const pair = parsePair(row.pair_data)
  if (!pair) return null
  return {
    ...pair,
    id: row.id,
    status: (row.status === 'approved' || row.status === 'rejected'
      ? row.status
      : 'pending') as ReviewStatus,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    flagCount: row.flag_count,
    firstFlaggedAt: row.first_flagged_at,
    lastFlaggedAt: row.last_flagged_at,
    runStartedAt: row.run_started_at,
    runId: row.run_id ?? null,
  }
}

/**
 * One page of the review queue, newest flags first, plus the exact
 * per-status counts. Offset pagination on purpose: last_flagged_at mutates
 * via upsert, so a cursor would skip/repeat rows across a re-flag — the
 * table is order-of-hundreds and the UI appends pages, so offsets are
 * honest. Counts come from one GROUP BY: exact at any size, independent of
 * paging.
 */
export async function listReviewItems(
  db: D1Database,
  options: { status?: ReviewStatus | 'all'; limit?: number; offset?: number } = {}
): Promise<ReviewListPage> {
  const status = options.status ?? 'pending'
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const offset = Math.max(options.offset ?? 0, 0)

  const [pageResult, countResult, filteredResult] = await db.batch([
    db
      .prepare(
        `SELECT r.id, r.pair_data, r.status, r.decided_at, r.decided_by, r.flag_count,
                r.first_flagged_at, r.last_flagged_at, r.run_started_at, p.id AS run_id
         FROM match_review_items r
         LEFT JOIN price_runs p ON p.run_started_at = r.run_started_at
         WHERE (? = 'all' OR r.status = ?)
         -- Pairs flagged by the same run share last_flagged_at; the natural
         -- key tie-break makes the total order deterministic so an offset
         -- page walk cannot skip/repeat tied rows across reads.
         ORDER BY r.last_flagged_at DESC, r.item_product_key ASC, r.entry_product_key ASC
         LIMIT ? OFFSET ?`
      )
      .bind(status, status, limit, offset),
    db.prepare(`SELECT status, COUNT(*) AS count FROM match_review_items GROUP BY status`).bind(),
    db
      .prepare(`SELECT COUNT(*) AS count FROM match_review_items WHERE (? = 'all' OR status = ?)`)
      .bind(status, status),
  ])

  const items: ReviewItem[] = []
  for (const row of (pageResult.results ?? []) as unknown as ReviewRow[]) {
    const item = toReviewItem(row)
    if (item) items.push(item)
  }

  const counts: ReviewCounts = { pending: 0, approved: 0, rejected: 0 }
  for (const row of (countResult.results ?? []) as unknown as { status: string; count: number }[]) {
    if (row.status === 'pending' || row.status === 'approved' || row.status === 'rejected') {
      counts[row.status] = row.count
    }
  }

  const filteredRows = (filteredResult.results ?? []) as unknown as { count: number }[]
  return { items, counts, filteredTotal: filteredRows[0]?.count ?? 0 }
}

async function getReviewRow(db: D1Database, id: string): Promise<ReviewItem | null> {
  const row = await db
    .prepare(
      `SELECT r.id, r.pair_data, r.status, r.decided_at, r.decided_by, r.flag_count,
              r.first_flagged_at, r.last_flagged_at, r.run_started_at, p.id AS run_id
       FROM match_review_items r
       LEFT JOIN price_runs p ON p.run_started_at = r.run_started_at
       WHERE r.id = ?`
    )
    .bind(id)
    .first<ReviewRow>()
  return row ? toReviewItem(row) : null
}

/**
 * Record a human verdict (last verdict wins — deciding twice overwrites).
 * Returns the updated row, or null for an unknown id (404 at the route).
 */
export async function decideReviewItem(
  db: D1Database,
  id: string,
  decision: ReviewDecision,
  userId: string
): Promise<ReviewItem | null> {
  await db
    .prepare(
      'UPDATE match_review_items SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?'
    )
    .bind(decision, new Date().toISOString(), userId, id)
    .run()
  return getReviewRow(db, id)
}

/**
 * Undo a verdict: back to pending, decision fields cleared. Undoing an
 * already-pending row is an idempotent no-op. Returns the row, or null for
 * an unknown id.
 */
export async function undoReviewDecision(db: D1Database, id: string): Promise<ReviewItem | null> {
  await db
    .prepare(
      "UPDATE match_review_items SET status = 'pending', decided_at = NULL, decided_by = NULL WHERE id = ?"
    )
    .bind(id)
    .run()
  return getReviewRow(db, id)
}

// ---------------------------------------------------------------------------
// Export — the artifact a future matcher-feedback loop consumes. Versioned
// envelope, keyset-paged reads so the export carries EVERY decided row no
// matter how the list paginates (non-truncation pinned by test).

export type ReviewExportRow = {
  itemProductKey: string
  itemName: string
  itemStore: string
  itemPrice: number
  entryProductKey: string
  entryName: string
  entryStore: string
  entryPrice: number
  decision: ReviewDecision
  decidedAt: string
  decidedBy: string | null
  runStartedAt: string
  confidence: number
  matchMethod: string
  reason: string
  flagCount: number
}

const EXPORT_PAGE = 200

type ExportRow = {
  id: string
  pair_data: string
  status: string
  decided_at: string
  decided_by: string | null
  flag_count: number
  run_started_at: string
}

function toExportRow(row: ExportRow): ReviewExportRow | null {
  const pair = parsePair(row.pair_data)
  if (!pair) return null
  return {
    itemProductKey: pair.itemProductKey,
    itemName: pair.itemName,
    itemStore: pair.itemStore,
    itemPrice: pair.itemPrice,
    entryProductKey: pair.entryProductKey,
    entryName: pair.entryName,
    entryStore: pair.entryStore,
    entryPrice: pair.entryPrice,
    decision: row.status === 'approved' ? 'approved' : 'rejected',
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    runStartedAt: row.run_started_at,
    confidence: pair.confidence,
    matchMethod: pair.matchMethod,
    reason: pair.reason,
    flagCount: row.flag_count,
  }
}

async function listDecidedPage(
  db: D1Database,
  after: { decidedAt: string; id: string } | null
): Promise<Array<{ id: string; row: ReviewExportRow }>> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.pair_data, r.status, r.decided_at, r.decided_by, r.flag_count, r.run_started_at
       FROM match_review_items r
       WHERE r.status != 'pending'
         AND (? IS NULL OR r.decided_at > ? OR (r.decided_at = ? AND r.id > ?))
       ORDER BY r.decided_at ASC, r.id ASC
       LIMIT ${EXPORT_PAGE}`
    )
    .bind(
      after?.decidedAt ?? null,
      after?.decidedAt ?? null,
      after?.decidedAt ?? null,
      after?.id ?? null
    )
    .all<ExportRow>()
  const rows: Array<{ id: string; row: ReviewExportRow }> = []
  for (const raw of results ?? []) {
    const row = toExportRow(raw)
    if (row) rows.push({ id: raw.id, row })
  }
  return rows
}

/**
 * Stream every decided row as `{"schema":1,"exportedAt":"…","decisions":[…]}`
 * — chunks enqueue as each keyset page lands, so memory stays flat and the
 * file is complete regardless of the list endpoint's pagination.
 */
export function exportReviewDecisions(db: D1Database): ReadableStream {
  const encoder = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          `{"schema":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"decisions":[`
        )
      )
      let first = true
      let after: { decidedAt: string; id: string } | null = null
      for (;;) {
        const page = await listDecidedPage(db, after)
        if (page.length === 0) break
        for (const { row } of page) {
          controller.enqueue(encoder.encode(`${first ? '' : ','}${JSON.stringify(row)}`))
          first = false
        }
        const last = page[page.length - 1]!
        after = { decidedAt: last.row.decidedAt, id: last.id }
        if (page.length < EXPORT_PAGE) break
      }
      controller.enqueue(encoder.encode(']}'))
      controller.close()
    },
  })
}
