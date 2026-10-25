// Retry engine — port of haqita scripts/common/http_client.py retry_call +
// QuotaExhaustedError. `withRetries` is the canonical generic engine (used by
// the fetch ladder and the publish client); `retryCall` is the Gemini-specific
// wrapper whose default policy understands SDK quota errors (429 /
// RESOURCE_EXHAUSTED, daily quota vs per-minute rate limit, retry-delay
// hints). Everywhere in this package `retries` counts EXTRA attempts after
// the first (so `retries: 2` makes at most 3 calls).

export class QuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuotaExhaustedError'
  }
}

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

export interface WithRetriesOptions {
  /** Extra attempts after the first (default 3). */
  retries?: number
  backoffMs?: number
  /** Errors that never succeed on retry — rethrown immediately. */
  isFatal?: (error: unknown) => boolean
  /** Label used in retry log lines. */
  context?: string
  /** Injectable for tests; defaults to real sleeping. */
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

/**
 * Generic retry with exponential backoff: `backoffMs * 2 ** attempt`. The
 * last error is always rethrown as-is (never masked), and fatal errors short
 * -circuit the loop without sleeping.
 */
export async function withRetries<T>(
  fn: () => Promise<T>,
  options: WithRetriesOptions = {}
): Promise<T> {
  const retries = options.retries ?? 3
  const backoffMs = options.backoffMs ?? 1000
  const context = options.context ?? 'call'
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const log = options.log ?? (() => {})

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (options.isFatal?.(error)) throw error
      if (attempt >= retries) throw error
      const wait = backoffMs * 2 ** attempt
      log(`[${context}] Attempt ${attempt + 1} failed (${String(error)}). Retrying in ${wait}ms...`)
      await sleep(wait)
    }
  }
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

export interface RetryOptions {
  /** Extra attempts after the first (default 2, i.e. 3 total calls). */
  retries?: number
  context?: string
  /** Injectable for tests; defaults to real sleeping. */
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

export async function retryCall<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 2
  const context = options.context ?? 'call'
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const log = options.log ?? (() => {})

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof QuotaExhaustedError) throw error
      const errStr = String(error)
      const errLower = errStr.toLowerCase()
      if (isQuotaSignal(errStr, errLower) && isDailyQuota(errStr, errLower)) {
        throw new QuotaExhaustedError(`Daily quota exhausted: ${errStr.slice(0, 200)}`)
      }
      // Final attempt: re-throw the real error — a persistent per-minute
      // rate limit must surface as itself, not as a masked generic failure.
      if (attempt >= retries) throw error
      if (isQuotaSignal(errStr, errLower)) {
        const waitTime = parseRetryDelay(errStr) ?? 60_000
        log(
          `[${context}] Rate limit hit. Sleeping ${waitTime}ms (attempt ${attempt + 1}/${retries + 1})...`
        )
        await sleep(waitTime)
      } else {
        const waitTime = 2 ** attempt * 1000
        log(`[${context}] Transient error: ${errStr}. Retrying in ${waitTime}ms...`)
        await sleep(waitTime)
      }
    }
  }
}
