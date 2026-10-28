// Brochure image upload (issue #293 design-arch §2.3): PUT each current-run
// NEW brochure page to the Worker's internal endpoint. The scraper holds no
// R2 credentials — the PUT rides the same bearer channel as the ingest POST
// (RUMAQ_INGEST_URL / RUMAQ_INGEST_SECRET), reusing publish/client.ts's
// error vocabulary and retry engine. The PUT is idempotent, so at-least-once
// runs are safe; a 404 is fatal by design (a wrong URL is a config error —
// the Worker must deploy before the scraper, else the nightly goes red on
// purpose).

import { Effect } from 'effect'

import { isPermanentClientStatus, withRetries } from '../util/retry.js'
import {
  PublishConfigError,
  PublishError,
  PublishHttpStatus,
  PublishRejected,
  type FetchLike,
  type PublishFailure,
} from './client.js'

export type { PublishFailure }

export interface BrochureUploadTarget {
  storeSlug: string
  /** Compact scrape date (YYYYMMDD) — also the sweep's age segment. */
  date: string
  filename: string
  contentType: string
}

export interface BrochureUploadOptions {
  ingestUrl?: string
  ingestSecret?: string
  dryRun: boolean
  fetch?: FetchLike
  retries?: number
  backoffMs?: number
  /** Per-attempt PUT timeout; a stalled endpoint becomes a retryable PublishError. */
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

/** Default per-attempt PUT timeout (matches the ingest POST's). */
export const DEFAULT_BROCHURE_TIMEOUT_MS = 60_000

/** …/api/internal/ingest/prices → <origin>/api/internal/brochures */
export function deriveBrochuresBase(ingestUrl: string): string {
  const marker = '/api/internal/ingest/'
  const idx = ingestUrl.indexOf(marker)
  const origin = idx >= 0 ? ingestUrl.slice(0, idx) : ingestUrl.replace(/\/+$/, '')
  return `${origin}/api/internal/brochures`
}

/** The stored, relative same-origin URL observations point at. */
export function brochureObjectUrl(target: BrochureUploadTarget): string {
  return `/api/brochures/${target.storeSlug}/${target.date}/${target.filename}`
}

/**
 * Upload one brochure image. Dry-run skips the PUT entirely (mirroring the
 * ingest POST skip). Failures reuse the publish client's typed errors: 401/
 * 403 are PublishRejected; every permanent 4xx (400 bad key, 404 wrong URL,
 * 413 oversize, 415 type) is fatal; 5xx and transport errors retry.
 */
export function uploadBrochure(
  bytes: Uint8Array,
  target: BrochureUploadTarget,
  options: BrochureUploadOptions
): Effect.Effect<void, PublishFailure> {
  return Effect.suspend(() => {
    if (options.dryRun) return Effect.void
    const fetchFn = options.fetch ?? fetch
    const retries = options.retries ?? 3
    const backoffMs = options.backoffMs ?? 5000
    const timeoutMs = options.timeoutMs ?? DEFAULT_BROCHURE_TIMEOUT_MS
    const log = options.log ?? (() => {})

    return resolveConfig(target, options).pipe(
      Effect.flatMap(({ endpoint, secret }) =>
        withRetries(
          Effect.tryPromise({
            // Fresh AbortSignal per attempt (client.ts precedent): each retry
            // gets its own timeout window; an abort is retryable, never a defect.
            try: () =>
              fetchFn(endpoint, {
                method: 'PUT',
                headers: {
                  'Content-Type': target.contentType,
                  Authorization: `Bearer ${secret}`,
                },
                body: bytes as unknown as BodyInit,
                signal: AbortSignal.timeout(timeoutMs),
              }),
            catch: (cause: unknown) =>
              new PublishError({ message: `Brochure upload failed: ${String(cause)}` }),
          }).pipe(
            Effect.flatMap(
              (
                response
              ): Effect.Effect<void, PublishRejected | PublishHttpStatus | PublishError> => {
                if (response.status === 401 || response.status === 403) {
                  return Effect.fail(
                    new PublishRejected({
                      status: response.status,
                      message: `Brochure endpoint rejected credentials (HTTP ${response.status})`,
                    })
                  )
                }
                if (!response.ok) {
                  return Effect.fail(
                    new PublishHttpStatus({
                      status: response.status,
                      message: `Brochure upload returned HTTP ${response.status}`,
                    })
                  )
                }
                return Effect.void
              }
            )
          ),
          {
            retries,
            backoffMs,
            sleep: options.sleep,
            log,
            context: 'brochure-upload',
            // Same fatal set as the ingest POST: credentials and permanent
            // 4xx (including 404 — deploy order) can never succeed on retry.
            isFatal: (error) =>
              error instanceof PublishRejected ||
              (error instanceof PublishHttpStatus && isPermanentClientStatus(error.status)),
          }
        )
      ),
      Effect.asVoid
    )
  })
}

function resolveConfig(
  target: BrochureUploadTarget,
  options: BrochureUploadOptions
): Effect.Effect<{ endpoint: string; secret: string }, PublishConfigError> {
  return Effect.suspend(() => {
    const url = options.ingestUrl ?? process.env.RUMAQ_INGEST_URL
    const secret = options.ingestSecret ?? process.env.RUMAQ_INGEST_SECRET
    if (!url)
      return Effect.fail(
        new PublishConfigError({ message: 'RUMAQ_INGEST_URL not set — cannot upload brochure' })
      )
    if (!secret)
      return Effect.fail(
        new PublishConfigError({ message: 'RUMAQ_INGEST_SECRET not set — cannot upload brochure' })
      )
    const endpoint = `${deriveBrochuresBase(url)}/${target.storeSlug}/${target.date}/${encodeURIComponent(target.filename)}`
    return Effect.succeed({ endpoint, secret })
  })
}
