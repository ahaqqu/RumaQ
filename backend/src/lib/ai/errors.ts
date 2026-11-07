// AiError — the ONE failure vocabulary of the door (ahaqqu/RumaQ#523, plan
// §5.2). Every provider failure reaches a caller as one of these codes: the
// routes map `httpStatus`, the review layer degrades on it, and a feature that
// already holds the call dimensions can write the failed attempt's usage row
// from `err.call` / `err.usage`.
//
// Adapters do NOT build AiError (they do not know the household, the funding
// or the provider row): they throw the narrow AdapterError in
// adapters/types.ts, and the facade attaches the call/usage context.

import { EMPTY_USAGE, type AiCall, type TokenUsage } from './types.js'

export type AiErrorCode =
  | 'not_configured'
  | 'unsupported'
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'provider_error'
  | 'invalid_response'
  | 'quota_exceeded'

// The code → HTTP table is fixed by plan §5.2. `timeout` deliberately keeps
// today's 502 so client handling is unchanged; the code carries the difference.
const HTTP_STATUS: Readonly<Record<AiErrorCode, 402 | 500 | 502>> = {
  not_configured: 402,
  quota_exceeded: 402,
  unsupported: 500,
  auth: 502,
  rate_limited: 502,
  timeout: 502,
  provider_error: 502,
  invalid_response: 502,
}

// The retryable set is deliberately small: a 429 or a 5xx can succeed later,
// everything else cannot. The door NEVER retries on its own (subrequest
// budget, plan §5.2) — the flag is for callers that own a retry policy.
const RETRYABLE: Readonly<Record<AiErrorCode, boolean>> = {
  not_configured: false,
  quota_exceeded: false,
  unsupported: false,
  auth: false,
  rate_limited: true,
  timeout: true,
  provider_error: false,
  invalid_response: false,
}

export type AiErrorOptions = {
  /**
   * null only for `not_configured`: there is no provider row to name, so there
   * is no call and no bill. Every other code carries the call it attempted.
   */
  call: AiCall | null
  /** Whatever the provider reported before failing; zeroes when nothing. */
  usage?: TokenUsage
  /** The provider's HTTP status, when the failure came from a response. */
  providerStatus?: number
  /** Seconds the provider asked us to wait (`Retry-After`), surfaced not slept. */
  retryAfterSeconds?: number
}

export class AiError extends Error {
  readonly code: AiErrorCode
  readonly httpStatus: 402 | 500 | 502
  readonly call: AiCall | null
  readonly usage: TokenUsage
  readonly providerStatus?: number
  readonly retryAfterSeconds?: number
  readonly retryable: boolean

  constructor(code: AiErrorCode, message: string, options: AiErrorOptions) {
    super(message)
    this.name = 'AiError'
    this.code = code
    this.httpStatus = HTTP_STATUS[code]
    this.call = options.call
    this.usage = options.usage ?? EMPTY_USAGE
    this.providerStatus = options.providerStatus
    this.retryAfterSeconds = options.retryAfterSeconds
    this.retryable = RETRYABLE[code]
  }
}

/** A structural check that survives a bundler boundary (instanceof, but named). */
export function isAiError(value: unknown): value is AiError {
  return value instanceof AiError
}
