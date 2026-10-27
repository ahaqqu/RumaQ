// Run-report client (haqita-integration.md §7.1): POST one report per
// finished live run — including failed runs, which are exactly the ones the
// admin scraping monitor exists to surface. Reporting is strictly best-effort:
// a monitor outage must never affect the pipeline's own exit code, so every
// failure here is logged and swallowed by the caller (Effect.ignore).

import type { RunReport } from '@rumaq/contract'
import { Data, Effect } from 'effect'

import { withRetries } from '../util/retry.js'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export class RunReportError extends Data.TaggedError('RunReportError')<{
  message: string
}> {}

export interface RunReportOptions {
  /** Full ingest endpoint URL (…/api/internal/ingest/prices); the runs
   * endpoint is derived from it unless RUMAQ_INGEST_RUNS_URL is set. */
  ingestUrl?: string
  ingestSecret?: string
  /** Override for the derived runs endpoint URL. */
  runsUrl?: string
  fetch?: FetchLike
  retries?: number
  backoffMs?: number
  /** Per-attempt timeout — short, because this POST must never stall a run. */
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

export const DEFAULT_RUN_REPORT_TIMEOUT_MS = 15_000

/** /api/internal/ingest/prices → /api/internal/ingest/runs */
export function deriveRunsUrl(ingestUrl: string): string {
  return ingestUrl.replace(/\/prices$/, '/runs')
}

function resolveConfig(options: RunReportOptions): { url: string; secret: string } | null {
  const secret = options.ingestSecret ?? process.env.RUMAQ_INGEST_SECRET
  const ingestUrl = options.ingestUrl ?? process.env.RUMAQ_INGEST_URL
  const url =
    options.runsUrl ??
    process.env.RUMAQ_INGEST_RUNS_URL ??
    (ingestUrl ? deriveRunsUrl(ingestUrl) : undefined)
  if (!url || !secret) return null
  return { url, secret }
}

export function postRunReport(
  report: RunReport,
  options: RunReportOptions
): Effect.Effect<void, RunReportError> {
  return Effect.suspend(() => {
    const config = resolveConfig(options)
    if (!config) {
      // Unconfigured monitor reporting is a no-op, not an error — local and
      // manual runs have nothing to report to.
      return Effect.void
    }
    const fetchFn = options.fetch ?? fetch
    const retries = options.retries ?? 1
    const backoffMs = options.backoffMs ?? 5000
    const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_REPORT_TIMEOUT_MS
    const sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
    const log = options.log ?? (() => {})

    return withRetries(
      Effect.tryPromise({
        try: () =>
          fetchFn(config.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${config.secret}`,
            },
            body: JSON.stringify(report),
            signal: AbortSignal.timeout(timeoutMs),
          }),
        catch: (cause: unknown) =>
          new RunReportError({ message: `Run report POST failed: ${String(cause)}` }),
      }).pipe(
        Effect.flatMap((response) =>
          response.ok
            ? Effect.void
            : Effect.fail(
                new RunReportError({
                  message: `Run report endpoint returned HTTP ${response.status}`,
                })
              )
        )
      ),
      {
        retries,
        backoffMs,
        sleep,
        log,
        context: 'run-report',
      }
    ).pipe(
      Effect.map(() => {}),
      Effect.tap(() => Effect.sync(() => log('[run-report] reported run outcome')))
    )
  })
}
