// Port of haqita tests/ocr/test_gemini_quota.py — quota vs rate-limit
// classification and retry semantics (with an injected no-op sleep).

import { describe, expect, it, vi } from 'vite-plus/test'

import { QuotaExhaustedError, parseRetryDelay, retryCall } from '../../src/util/retry.js'

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
    await expect(retryCall(fn, { sleep: async () => {}, maxRetries: 3 })).rejects.toThrow(
      QuotaExhaustedError
    )
  })

  it.each(RATE_LIMIT_ERRORS)('retries (not fatal) for per-minute limits: %s', async (message) => {
    const sleep = vi.fn(async () => {})
    const fn = async () => {
      throw new Error(message)
    }
    try {
      await retryCall(fn, { sleep, maxRetries: 1 })
      throw new Error('should have rejected')
    } catch (error) {
      expect(error).not.toBeInstanceOf(QuotaExhaustedError)
    }
    expect(sleep).toHaveBeenCalled()
  })

  it('retries generic transient errors with backoff, then re-raises', async () => {
    const sleep = vi.fn(async () => {})
    let attempts = 0
    const fn = async () => {
      attempts++
      throw new Error('Some other error')
    }
    await expect(retryCall(fn, { sleep, maxRetries: 2 })).rejects.toThrow('Some other error')
    expect(attempts).toBe(2)
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
    await expect(retryCall(fn, { sleep, maxRetries: 3 })).rejects.toThrow('already exhausted')
    expect(attempts).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})
