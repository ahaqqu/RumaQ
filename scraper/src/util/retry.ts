// Retry engine (Effect) — port of haqita scripts/common/http_client.py
// retry_call + QuotaExhaustedError. `withRetries` is the canonical generic
// engine (used by the fetch ladder and the publish client);
// `withQuotaPolicy` is the Gemini-specific policy that understands SDK quota
// errors (429 / RESOURCE_EXHAUSTED, daily quota vs per-minute rate limit,
// retry-delay hints from the error payload — which is why this is not a
// `Schedule`: schedules cannot read the failed error to pick a delay).
// Everywhere in this package `retries` counts EXTRA attempts after the first
// (so `retries: 2` makes at most 3 calls). Sleep stays injectable so tests
// are fast and deterministic.

import { Data, Effect } from 'effect'

export class QuotaExhausted extends Data.TaggedError('QuotaExhausted')<{
  message: string
}> {}

export function parseRetryDelay(errorMessage: string): number | null {
  const patterns = [
    /retry in (\d+\.?\d*)s/i,
    /retrydelay.*?(\d+)s/i,
    /please retry in (\d+\.?\d*)s/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(errorMessage)
    if (match?.[1]) return Math.round(parseFloat(match[1])) + 15
  }
  return null
}

function isQuotaSignal(err: string, errLower: string): boolean {
  return (
    err.includes('429') || err.includes('RESOURCE_EXHAUSTED') || errLower.includes('rate limit')
  )
}

function isDailyQuota(err: string, errLower: string): boolean {
  return (
    errLower.includes('quota') &&
    (errLower.includes('per day') || errLower.includes('daily') || err.includes('PerDay'))
  )
}

/** Maps a thrown SDK error to its typed retry classification. */
export function classifyQuotaError(cause: unknown): QuotaExhausted | null {
  const errStr = String(cause)
  const errLower = errStr.toLowerCase()
  if (isQuotaSignal(errStr, errLower) && isDailyQuota(errStr, errLower)) {
    return new QuotaExhausted({ message: `Daily quota exhausted: ${errStr.slice(0, 200)}` })
  }
  return null
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * A 4xx that can never succeed on retry. 429 (backoff signal), 408
 * (request timeout) and 425 (too early) are semantically transient client
 * statuses and stay retryable; everything else in 400–499 fails fast so a
 * dead route never burns the ladder's attempts and backoff waits.
 */
export function isPermanentClientStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429 && status !== 408 && status !== 425
}

export interface RetryOptions {
  /** Extra attempts after the first (default 3). */
  retries?: number
  backoffMs?: number
  /** Errors that never succeed on retry — failed immediately, no sleep. */
  isFatal?: (error: unknown) => boolean
  /** Label used in retry log lines. */
  context?: string
  /** Injectable for tests; defaults to real sleeping. */
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

/**
 * Generic retry with exponential backoff: `backoffMs * 2 ** attempt`. The
 * last error is always re-failed as-is (never masked), and fatal errors
 * short-circuit without sleeping.
 */
export function withRetries<A, E>(
  effect: Effect.Effect<A, E>,
  options: RetryOptions = {}
): Effect.Effect<A, E> {
  const retries = options.retries ?? 3
  const backoffMs = options.backoffMs ?? 1000
  const context = options.context ?? 'call'
  const sleep = options.sleep ?? defaultSleep
  const log = options.log ?? (() => {})

  const attempt = (n: number): Effect.Effect<A, E> =>
    Effect.suspend(() => effect).pipe(
      Effect.catchIf(
        () => true,
        (error) => {
          if (options.isFatal?.(error) || n >= retries) return Effect.fail(error)
          const wait = backoffMs * 2 ** n
          return Effect.sync(() => {
            log(
              `[${context}] Attempt ${n + 1} failed (${errorText(error)}). Retrying in ${wait}ms...`
            )
          }).pipe(
            Effect.flatMap(() => Effect.promise(() => sleep(wait))),
            Effect.flatMap(() => attempt(n + 1))
          )
        }
      )
    )
  return attempt(0)
}

/**
 * Quota-aware retry for Gemini SDK calls: `QuotaExhausted` propagates
 * immediately (the caller aborts the run — exit code 2), per-minute rate
 * limits sleep the delay parsed from the error payload (60s fallback),
 * everything else backs off exponentially. On the final attempt the real
 * error is re-failed — a persistent rate limit surfaces as itself.
 */
export function withQuotaPolicy<A, E>(
  effect: Effect.Effect<A, E>,
  options: Omit<RetryOptions, 'isFatal'> = {}
): Effect.Effect<A, E> {
  const retries = options.retries ?? 2
  const context = options.context ?? 'call'
  const sleep = options.sleep ?? defaultSleep
  const log = options.log ?? (() => {})

  const attempt = (n: number): Effect.Effect<A, E> =>
    Effect.suspend(() => effect).pipe(
      Effect.catchIf(
        () => true,
        (error) => {
          if (error instanceof QuotaExhausted) return Effect.fail(error)
          if (n >= retries) return Effect.fail(error)
          const errStr = errorText(error)
          const isRateLimit = isQuotaSignal(errStr, errStr.toLowerCase())
          // parseRetryDelay speaks seconds (haqita convention); sleep speaks ms.
          const waitTime = isRateLimit ? (parseRetryDelay(errStr) ?? 60) * 1000 : 2 ** n * 1000
          return Effect.sync(() => {
            if (isRateLimit) {
              log(
                `[${context}] Rate limit hit. Sleeping ${waitTime}ms (attempt ${n + 1}/${retries + 1})...`
              )
            } else {
              log(`[${context}] Transient error: ${errStr}. Retrying in ${waitTime}ms...`)
            }
          }).pipe(
            Effect.flatMap(() => Effect.promise(() => sleep(waitTime))),
            Effect.flatMap(() => attempt(n + 1))
          )
        }
      )
    )
  return attempt(0)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
