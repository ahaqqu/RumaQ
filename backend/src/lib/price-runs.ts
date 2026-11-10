import type {
  RunAiUsage,
  RunFailure,
  RunProductsSummary,
  RunReport,
  RunReportStore,
  RunVerifierPrompt,
} from '@rumaq/contract'

// Storage for scraper run reports (haqita-integration.md §7.1). One row per
// finished live run; the monitor reads these instead of journald. Detail
// objects are stored as JSON blobs — the monitor renders them as-is and the
// schema is owned by @rumaq/contract, so columns would only duplicate it.

export type RunReportResult = {
  ok: boolean
  status: 'recorded'
}

export async function recordRunReport(db: D1Database, report: RunReport): Promise<void> {
  await db
    .prepare(
      `INSERT INTO price_runs
         (id, run_started_at, finished_at, exit_code, status, stage, per_store, match_stats, publish_result, index_version, products_summary, ai_usage, failures, error, ai_prompt_identity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_started_at) DO UPDATE SET
         finished_at = excluded.finished_at,
         exit_code = excluded.exit_code,
         status = excluded.status,
         stage = excluded.stage,
         per_store = excluded.per_store,
         match_stats = excluded.match_stats,
         publish_result = excluded.publish_result,
         index_version = excluded.index_version,
         products_summary = excluded.products_summary,
         ai_usage = excluded.ai_usage,
         failures = excluded.failures,
         error = excluded.error,
         ai_prompt_identity = excluded.ai_prompt_identity`
    )
    .bind(
      crypto.randomUUID(),
      report.runStartedAt,
      report.finishedAt,
      report.exitCode,
      report.status,
      report.stage,
      JSON.stringify(report.perStore),
      report.match ? JSON.stringify(report.match) : null,
      report.publish ? JSON.stringify(report.publish) : null,
      // Issue #463: the v2 receipt's index version + bounded product summary.
      // Nullish on old scrapers' reports and dry-runs — stored as NULL, which
      // the monitor renders as absent.
      report.indexVersion ?? null,
      report.products ? JSON.stringify(report.products) : null,
      // Issue #537: the run's AI spend and its run-level typed failures. Both
      // were validated and DROPPED before the 0043 columns existed, so the
      // monitor could not total a night's spend or read a store-less failure.
      // `usage` only in this column — the prompt identity gets its own column
      // below, and the generation config stays pipeline-private (see the
      // contract's runAiSchema comment). An empty `failures` array is stored
      // as NULL: "no failure entries" is one state, not two.
      report.ai ? JSON.stringify(report.ai.usage) : null,
      report.failures?.length ? JSON.stringify(report.failures) : null,
      report.error ?? null,
      // Pipeline #83: the verifier prompt identity that produced this run's
      // decisions. Every scraper today sends no `ai.verifierPrompt` (the
      // pipeline phase is a follow-up), so absence is bound as SQL NULL — the
      // same state as rows recorded before migration 0044. One "absent"
      // spelling across the whole table keeps `IS NULL` queries and future
      // backfills honest; a JSON literal `'null'` would be a present-but-empty
      // value that only `parseJson` happens to tolerate.
      report.ai?.verifierPrompt ? JSON.stringify(report.ai.verifierPrompt) : null
    )
    .run()
}

// The three detail blobs store exactly the validated report slices (the
// schema output, stringified verbatim), so their read types are derived from
// the contract rather than mirrored by hand: a hand-written copy drifts
// silently — this one had already lost modelsUsed / rejectedItems / audit /
// timing before issue #463 had to add provisionalMatches to it, and it cannot
// express the `null` a nullish contract field legitimately stores.
export type RunStoreSummary = RunReportStore
export type RunMatchSummary = NonNullable<RunReport['match']>
export type RunPublishSummary = NonNullable<RunReport['publish']>

export type PriceRun = {
  id: string
  runStartedAt: string
  finishedAt: string
  exitCode: number
  status: 'success' | 'failed'
  stage: string | null
  perStore: Record<string, RunStoreSummary>
  match: RunMatchSummary | null
  publish: RunPublishSummary | null
  /** Issue #463: the v2 receipt's canonical index version, null for runs
   * recorded before the field existed (and dry-runs). */
  indexVersion: number | null
  /** Issue #463: the v2 receipt's bounded product summary (created/existing
   * counts), null for pre-#463 rows and dry-runs. */
  products: RunProductsSummary | null
  /** Issue #537: the run's per-stage AI spend, null for runs recorded before
   * the pipeline sent `ai.usage` (and any producer that never metered). */
  ai: RunAiUsage | null
  /** Pipeline #83: the verifier prompt that produced this run's decisions
   * (`{ version, id, sha256 }`) — the answer to "v1 or v2 answered?", which
   * the run history could not name before. Null for rows recorded before the
   * field existed and for every producer that does not send it yet. */
  aiPromptIdentity: RunVerifierPrompt | null
  /** Issue #537: the run-level typed failure summary — every per-store failure
   * mirrored plus the store-less entries a run-level abort owns. Null when the
   * run had none (and on rows recorded before the field existed). */
  failures: RunFailure[] | null
  error: string | null
}

type PriceRunRow = {
  id: string
  run_started_at: string
  finished_at: string
  exit_code: number
  status: string
  stage: string | null
  per_store: string | null
  match_stats: string | null
  publish_result: string | null
  index_version: number | null
  products_summary: string | null
  ai_usage: string | null
  ai_prompt_identity: string | null
  failures: string | null
  error: string | null
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    // A malformed blob must never break the whole monitor feed.
    return null
  }
}

export type PriceRunsFeed = {
  runs: PriceRun[]
  lastSuccessAt: string | null
}

export async function listPriceRuns(db: D1Database, limit = 50): Promise<PriceRunsFeed> {
  const { results } = await db
    .prepare(
      `SELECT id, run_started_at, finished_at, exit_code, status, stage,
              per_store, match_stats, publish_result, index_version, products_summary,
              ai_usage, ai_prompt_identity, failures, error
       FROM price_runs
       ORDER BY run_started_at DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<PriceRunRow>()

  const runs = (results ?? []).map((row) => ({
    id: row.id,
    runStartedAt: row.run_started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    status: row.status === 'success' ? ('success' as const) : ('failed' as const),
    stage: row.stage,
    perStore: parseJson<Record<string, RunStoreSummary>>(row.per_store) ?? {},
    match: parseJson<RunMatchSummary>(row.match_stats),
    publish: parseJson<RunPublishSummary>(row.publish_result),
    // Issue #463: old rows have NULL in both columns — the monitor reads that
    // as "absent" and must keep rendering them.
    indexVersion: row.index_version ?? null,
    products: parseJson<RunProductsSummary>(row.products_summary),
    // Issue #537: NULL on runs recorded before 0043 (and any producer that
    // sends no `ai`/`failures`) — the monitor reads that as "absent".
    ai: parseJson<RunAiUsage>(row.ai_usage),
    // Pipeline #83: SQL NULL on pre-0044 rows and on every report that does
    // not send `ai.verifierPrompt` (every scraper today) — one absent state,
    // which the monitor renders as nothing.
    aiPromptIdentity: parseJson<RunVerifierPrompt>(row.ai_prompt_identity),
    failures: parseJson<RunFailure[]>(row.failures),
    error: row.error,
  }))

  const pageSuccess = runs.find((run) => run.status === 'success')?.runStartedAt ?? null
  // The page only holds the most recent `limit` runs; if all of them failed,
  // look for the last success beyond the page window.
  const lastSuccessAt =
    pageSuccess ??
    (
      await db
        .prepare(`SELECT MAX(run_started_at) AS last FROM price_runs WHERE status = 'success'`)
        .first<{ last: string | null }>()
    )?.last ??
    null

  return { runs, lastSuccessAt }
}
