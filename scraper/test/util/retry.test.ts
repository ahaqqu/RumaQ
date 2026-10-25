// Port of haqita tests/ocr/test_gemini_quota.py — quota vs rate-limit
// classification and retry semantics (with an injected no-op sleep), plus
// the generic withRetries engine shared by the fetch ladder and publisher.

import { describe, expect, it, vi } from 'vite-plus/test'

import {
  QuotaExhaustedError,
  parseRetryDelay,
  retryCall,
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

describe('retryCall quota detection', () => {
  it.each(DAILY_QUOTA_ERRORS)('raises QuotaExhaustedError for daily quota: %s', async (message) => {
    const fn = async () => {
      throw new Error(message)
    }
    await expect(retryCall(fn, { sleep: async () => {}, retries: 2 })).rejects.toThrow(
      QuotaExhaustedError
    )
  })

  it.each(RATE_LIMIT_ERRORS)('retries (not fatal) for per-minute limits: %s', async (message) => {
    const sleep = vi.fn(async () => {})
    let attempts = 0
    const fn = async () => {
      attempts++
      if (attempts === 1) throw new Error(message)
      return 'ok'
    }
    await expect(retryCall(fn, { sleep, retries: 2 })).resolves.toBe('ok')
    expect(attempts).toBe(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('rejects with the original error when a per-minute limit exhausts all retries', async () => {
    const message = '429 Quota exceeded for quota metric GenerateRequests per minute'
    const sleep = vi.fn(async () => {})
    let attempts = 0
    const fn = async () => {
      attempts++
      throw new Error(message)
    }
    // Not a QuotaExhaustedError (that stays daily-only) and not a masked
    // generic failure — the real 429 surfaces after the final attempt.
    await expect(retryCall(fn, { sleep, retries: 2 })).rejects.toThrow(message)
    expect(attempts).toBe(3)
    // Sleeps between attempts only — never after the final one.
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('retries generic transient errors with backoff, then re-raises', async () => {
    const sleep = vi.fn(async () => {})
    let attempts = 0
    const fn = async () => {
      attempts++
      throw new Error('Some other error')
    }
    await expect(retryCall(fn, { sleep, retries: 1 })).rejects.toThrow('Some other error')
    expect(attempts).toBe(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('returns the value on success without sleeping', async () => {
    const sleep = vi.fn(async () => {})
    await expect(retryCall(async () => 42, { sleep })).resolves.toBe(42)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('propagates QuotaExhaustedError without retrying', async () => {
    const sleep = vi.fn(async () => {})
    let attempts = 0
    const fn = async () => {
      attempts++
      throw new QuotaExhaustedError('already exhausted')
    }
    await expect(retryCall(fn, { sleep, retries: 2 })).rejects.toThrow('already exhausted')
    expect(attempts).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('withRetries', () => {
  it('retries with exponential backoff and succeeds', async () => {
    const sleep = vi.fn(async (_ms: number) => {})
    let attempts = 0
    const fn = async () => {
      attempts++
      if (attempts < 3) throw new Error('boom')
      return 'ok'
    }
    await expect(withRetries(fn, { retries: 3, backoffMs: 5, sleep })).resolves.toBe('ok')
    expect(attempts).toBe(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5, 10])
  })

  it('rethrows the last error after exhausting retries', async () => {
    const sleep = vi.fn(async () => {})
    let attempts = 0
    const fn = async () => {
      attempts++
      throw new Error(`failure ${attempts}`)
    }
    await expect(withRetries(fn, { retries: 2, backoffMs: 1, sleep })).rejects.toThrow('failure 3')
    expect(attempts).toBe(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('short-circuits fatal errors without sleeping', async () => {
    const sleep = vi.fn(async () => {})
    let attempts = 0
    const fn = async () => {
      attempts++
      throw new Error('fatal!')
    }
    await expect(
      withRetries(fn, {
        retries: 3,
        sleep,
        isFatal: (error) => String(error).includes('fatal'),
      })
    ).rejects.toThrow('fatal!')
    expect(attempts).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('succeeds without sleeping when the first attempt works', async () => {
    const sleep = vi.fn(async () => {})
    await expect(withRetries(async () => 7, { retries: 2, sleep })).resolves.toBe(7)
    expect(sleep).not.toHaveBeenCalled()
  })
})
