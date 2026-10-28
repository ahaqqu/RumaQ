// Port of haqita tests/ocr/test_gemini_quota.py — quota vs rate-limit
// classification and retry semantics for the Effect-based engine (with an
// injected no-op sleep).

import { describe, expect, it, vi } from 'vite-plus/test'
import { Data, Effect } from 'effect'

import {
  classifyQuotaError,
  isModelFatalError,
  parseRetryDelay,
  QuotaExhausted,
  withQuotaPolicy,
  withRetries,
} from '../../src/util/retry.js'

const DAILY_QUOTA_ERRORS = [
  '429 You have exhausted your daily quota. QuotaID: GenerateRequestsPerDayPerProjectPerModel-FreeTier',
  '429 RESOURCE_EXHAUSTED: quota metric per day limit exceeded',
  '429 Quota exceeded for quota metric GenerateRequests per day',
  'RESOURCE_EXHAUSTED: Quota exceeded for GenerateRequestsPerDayPerProjectPerModel',
]

const RATE_LIMIT_ERRORS = [
  '429 RESOURCE_EXHAUSTED: retry in 30s',
  '429 rate limit exceeded. Please retry in 55.0s',
  '429 Quota exceeded for quota metric GenerateRequests per minute',
]

describe('parseRetryDelay', () => {
  it('extracts the delay plus a 15s buffer', () => {
    expect(parseRetryDelay('429 RESOURCE_EXHAUSTED: retry in 30s')).toBe(45)
    expect(parseRetryDelay('429 rate limit exceeded. Please retry in 55.0s')).toBe(70)
  })

  it('returns null when no delay is mentioned', () => {
    expect(parseRetryDelay('500 Internal Server Error')).toBeNull()
  })
})

describe('classifyQuotaError', () => {
  it.each(DAILY_QUOTA_ERRORS)('classifies daily quota messages: %s', (message) => {
    const error = classifyQuotaError(new Error(message))
    expect(error).toBeInstanceOf(QuotaExhausted)
    expect(error!.message).toContain('Daily quota exhausted')
  })

  it.each(RATE_LIMIT_ERRORS)('does not classify per-minute limits as fatal: %s', (message) => {
    expect(classifyQuotaError(new Error(message))).toBeNull()
  })

  it('returns null for non-quota errors', () => {
    expect(classifyQuotaError(new Error('Some other error'))).toBeNull()
  })
})

class Transient extends Data.TaggedError('Transient')<{ message: string }> {}

// Verbatim shape of the issue #306 live-log failure (code/message/status).
const MODEL_GONE_404 =
  '{"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash …","status":"NOT_FOUND"}}'

describe('isModelFatalError', () => {
  it('classifies the live 404 NOT_FOUND model-gone body as fatal', () => {
    expect(isModelFatalError(new Error(MODEL_GONE_404))).toBe(true)
    expect(isModelFatalError(new Error('404 NOT_FOUND: models/gemini-x not found'))).toBe(true)
  })

  it.each([
    '400 INVALID_ARGUMENT: Model models/gemini-x is not supported for generateContent',
    '400 INVALID_ARGUMENT: models/gemini-x not found for API version v1beta',
  ])('classifies explicit invalid-model 400s as fatal: %s', (message) => {
    expect(isModelFatalError(new Error(message))).toBe(true)
  })

  it.each([
    '503 UNAVAILABLE',
    '500 INTERNAL',
    '429 RESOURCE_EXHAUSTED: retry in 30s',
    '400 INVALID_ARGUMENT: Request payload size exceeds the limit',
    'ECONNRESET',
  ])('keeps transient and non-model errors retryable: %s', (message) => {
    expect(isModelFatalError(new Error(message))).toBe(false)
  })
})

describe('withRetries', () => {
  it('returns the value on success without sleeping', async () => {
    const sleep = vi.fn(async () => {})
    const result = await Effect.runPromise(withRetries(Effect.succeed(42), { sleep }))
    expect(result).toBe(42)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries generic errors with backoff, then succeeds', async () => {
    const sleep = vi.fn(async () => {})
    let attempts = 0
    const effect = Effect.suspend(() => {
      attempts++
      return attempts < 3 ? Effect.fail(new Transient({ message: 'nope' })) : Effect.succeed('ok')
    })
    await expect(
      Effect.runPromise(withRetries(effect, { retries: 3, sleep, backoffMs: 1 }))
    ).resolves.toBe('ok')
    expect(attempts).toBe(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('re-fails with the last error after exhausting retries', async () => {
    const sleep = vi.fn(async () => {})
    let attempts = 0
    const effect = Effect.suspend(() => {
      attempts++
      return Effect.fail(new Transient({ message: 'still broken' }))
    })
    await expect(
      Effect.runPromise(withRetries(effect, { retries: 2, sleep, backoffMs: 1 }))
    ).rejects.toThrow('still broken')
    expect(attempts).toBe(3) // 1 initial + 2 retries
  })

  it('fails immediately on fatal errors without sleeping', async () => {
    const sleep = vi.fn(async () => {})
    class Fatal extends Data.TaggedError('Fatal')<{ message: string }> {}
    let attempts = 0
    const effect = Effect.suspend(() => {
      attempts++
      return Effect.fail(new Fatal({ message: 'credentials rejected' }))
    })
    await expect(
      Effect.runPromise(
        withRetries(effect, {
          retries: 3,
          sleep,
          backoffMs: 1,
          isFatal: (error) => (error as { _tag?: string })._tag === 'Fatal',
        })
      )
    ).rejects.toThrow('credentials rejected')
    expect(attempts).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('withQuotaPolicy', () => {
  it('fails fast on a model-gone 404 — no retries, no sleeps', async () => {
    const sleep = vi.fn(async () => {})
    let attempts = 0
    const effect = Effect.suspend(() => {
      attempts++
      return Effect.fail(new Transient({ message: MODEL_GONE_404 }))
    })
    await expect(Effect.runPromise(withQuotaPolicy(effect, { retries: 3, sleep }))).rejects.toThrow(
      /no longer available/
    )
    expect(attempts).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('propagates QuotaExhausted immediately without retrying', async () => {
    const sleep = vi.fn(async () => {})
    let attempts = 0
    const effect = Effect.suspend(() => {
      attempts++
      return Effect.fail(
        classifyQuotaError(new Error(DAILY_QUOTA_ERRORS[0]!)) ??
          new Transient({ message: 'unreachable' })
      )
    })
    await expect(Effect.runPromise(withQuotaPolicy(effect, { retries: 3, sleep }))).rejects.toThrow(
      /Daily quota exhausted/
    )
    expect(attempts).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it.each(RATE_LIMIT_ERRORS)('retries (not fatal) per-minute limits: %s', async (message) => {
    const sleep = vi.fn(async () => {})
    const effect = Effect.fail(new Transient({ message }))
    try {
      await Effect.runPromise(withQuotaPolicy(effect, { retries: 1, sleep }))
      throw new Error('should have rejected')
    } catch (error) {
      expect(error).not.toBeInstanceOf(QuotaExhausted)
      expect(sleep).toHaveBeenCalled()
    }
  })

  it('rejects with the original error when a per-minute limit exhausts all retries', async () => {
    const sleep = vi.fn(async () => {})
    const message = '429 RESOURCE_EXHAUSTED: retry in 30s'
    const effect = Effect.fail(new Transient({ message }))
    await expect(Effect.runPromise(withQuotaPolicy(effect, { retries: 1, sleep }))).rejects.toThrow(
      message
    )
    // attempt 0 sleeps the parsed delay; attempt 1 is final → no second sleep.
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(45_000)
  })

  it('retries transient errors with exponential backoff, then re-fails', async () => {
    const sleep = vi.fn(async () => {})
    let attempts = 0
    const effect = Effect.suspend(() => {
      attempts++
      return Effect.fail(new Transient({ message: 'Some other error' }))
    })
    await expect(Effect.runPromise(withQuotaPolicy(effect, { retries: 2, sleep }))).rejects.toThrow(
      'Some other error'
    )
    expect(attempts).toBe(3)
    expect(sleep).toHaveBeenNthCalledWith(1, 1000)
    expect(sleep).toHaveBeenNthCalledWith(2, 2000)
  })

  it('logs retry waits when a logger is provided', async () => {
    const log = vi.fn()
    const sleep = vi.fn(async () => {})
    let attempt = 0
    const effect = Effect.suspend(() => {
      attempt++
      return attempt === 1
        ? Effect.fail(new Transient({ message: '429 RESOURCE_EXHAUSTED: retry in 30s' }))
        : Effect.succeed(1)
    })
    await Effect.runPromise(
      withQuotaPolicy(effect, { retries: 2, sleep, log, context: 'gemini_ocr' })
    )
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Rate limit hit'))
    expect(sleep).toHaveBeenCalledWith(45_000)
  })
})
