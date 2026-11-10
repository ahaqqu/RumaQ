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

/**
 * Issue #536: how many consecutive DRY failures it takes to call the pipeline
 * dead. One dry run is a transient (a quota night, a box network blip — the
 * timer retries tomorrow); two is suspicious but still within what a single
 * bad upstream day explains. Three consecutive runs that published nothing
 * (~72h without a new price) is the smallest streak no single transient can
 * explain, and it is ~4 nights before the 7-day (168h) staleness gate whose
 * anchor — the latest observation — is exactly what a never-publishing
 * pipeline does not have.
 *
 * Advisory only: it decides when a banner and the freshness probe fire, never
 * whether the pipeline runs.
 */
export const FAILED_RUN_STREAK_THRESHOLD = 3

/**
 * The consecutive-failure read the monitor banner and the freshness probe
 * share (issue #536). Derived from stored run reports only — no new column,
 * no new ingest field.
 *
 * The alarm shape is "a run that failed and published nothing" (see
 * `isFailedWithoutPublish`), not "a run that carried a run-level
 * `failure.code`". The receipt is the stored proof of landing: a night where
 * one store failed but the rest published prices is NOT a dead pipeline
 * (that is a single blocked/failed store, and the freshness probe must not
 * page for it), while an all-stores-failed or all-stores-blocked night has
 * only per-store entries and is just as dead as a quota abort. The typed code
 * is only the banner's label (run-level entry preferred), never the trigger.
 */
export type FailedRunStreak = {
  /** Dry failures at the head of the feed. 0 means the newest run published
   * or succeeded. Bounded by the feed window (`listPriceRuns`' limit): a
   * longer streak is counted as the window size, which is far past the
   * threshold either way. */
  count: number
  /** The alarm threshold this count is judged against (issue #536). */
  threshold: number
  /** `runStartedAt` of the OLDEST dry run in the streak — the first run that
   * published nothing; null at count 0. */
  since: string | null
  /** Typed code of the NEWEST dry run's failure: a run-level entry
   * (`store: null` — the quota/publish abort classes) when it has one, else
   * the first entry. Null on rows recorded before #537 and on runs whose
   * failure was never typed (the free-text `error` is the monitor's fallback,
   * as it always was). */
  code: RunFailure['code'] | null
}

/**
 * Did this run land any prices? The publish receipt is the only stored proof:
 * `accepted > 0` on a `published` receipt. The pipeline omits the whole
 * `publish` block when nothing was posted (`mode: 'dry-run'` never reports),
 * and a `published` receipt with `accepted: 0` is an empty payload — the
 * all-stores-blocked night that published nothing.
 */
function publishedAnything(run: PriceRun): boolean {
  return run.publish?.mode === 'published' && (run.publish.accepted ?? 0) > 0
}

/**
 * One night towards the streak (issue #536): the run failed AND published
 * nothing. A failed run that still published prices breaks the streak instead
 * of extending it — it is a store-level red, not a dead pipeline.
 */
export function isFailedWithoutPublish(run: PriceRun): boolean {
  return run.status === 'failed' && !publishedAnything(run)
}

/**
 * Walk the feed newest-first and count the dry failures at its head
 * (issue #536). The walk stops at the first run that published anything or
 * succeeded — "consecutive" is over the runs as stored, so a replay (same
 * `runStartedAt`) cannot double-count: the upsert keeps one row per run.
 *
 * Every stored live run counts, including a queue-driven `Scrape Now` run —
 * the report schema has no origin field, and a manual scrape that fails
 * without publishing anything is the same pipeline failure. Those runs are
 * rare and each one is real, so the threshold absorbs them.
 */
export function summarizeFailedRunStreak(
  runs: PriceRun[],
  threshold = FAILED_RUN_STREAK_THRESHOLD
): FailedRunStreak {
  let count = 0
  while (count < runs.length && isFailedWithoutPublish(runs[count]!)) count += 1
  return {
    count,
    threshold,
    since: count > 0 ? runs[count - 1]!.runStartedAt : null,
    code: count > 0 ? runFailureCode(runs[0]!) : null,
  }
}

/** The typed class to put on the banner: the run-level entry wins, because a
 * store-less code (`embedding_unavailable` / `publish_failed`) names what
 * killed the whole run; otherwise the first entry is the closest thing. */
function runFailureCode(run: PriceRun): RunFailure['code'] | null {
  const failures = run.failures ?? []
  return (failures.find((failure) => failure.store == null) ?? failures[0])?.code ?? null
}

export type PriceRunsFeed = {
  runs: PriceRun[]
  lastSuccessAt: string | null
  /** Issue #536: the consecutive dry-failure read over `runs`. */
  failedStreak: FailedRunStreak
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

  // Issue #536: one derivation for both consumers — the admin monitor's banner
  // and the freshness probe (which cannot read this feed itself: it holds the
  // ingest secret, not an admin session).
  return { runs, lastSuccessAt, failedStreak: summarizeFailedRunStreak(runs) }
}
