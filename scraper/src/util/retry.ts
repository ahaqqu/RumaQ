// Port of haqita scripts/common/http_client.py retry_call + QuotaExhaustedError.
// The default policy handles Gemini SDK errors (429 / RESOURCE_EXHAUSTED,
// daily quota vs per-minute rate limit, retry-delay hints); everything else
// falls into generic exponential backoff.

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
  maxRetries?: number
  context?: string
  /** Injectable for tests; defaults to real sleeping. */
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

export async function retryCall<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 3
  const context = options.context ?? 'call'
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const log = options.log ?? (() => {})

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof QuotaExhaustedError) throw error
      const errStr = String(error)
      const errLower = errStr.toLowerCase()
      if (isQuotaSignal(errStr, errLower)) {
        if (isDailyQuota(errStr, errLower)) {
          throw new QuotaExhaustedError(`Daily quota exhausted: ${errStr.slice(0, 200)}`)
        }
        const waitTime = parseRetryDelay(errStr) ?? 60_000
        log(
          `[${context}] Rate limit hit. Sleeping ${waitTime}ms (attempt ${attempt + 1}/${maxRetries})...`
        )
        await sleep(waitTime)
      } else if (attempt < maxRetries - 1) {
        const waitTime = 2 ** attempt * 1000
        log(`[${context}] Transient error: ${errStr}. Retrying in ${waitTime}ms...`)
        await sleep(waitTime)
      } else {
        throw error
      }
    }
  }
  throw new Error('retryCall: unreachable')
}
