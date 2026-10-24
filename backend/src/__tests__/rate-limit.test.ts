import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { isRateLimited, getRateLimitConfig, resetRateLimit } from '../lib/rate-limit.js'

beforeEach(() => {
  resetRateLimit()
})

describe('getRateLimitConfig', () => {
  it('uses defaults when env vars are missing', () => {
    const config = getRateLimitConfig({})
    expect(config.windowMs).toBe(60_000)
    expect(config.maxRequests).toBe(100)
  })

  it('reads env vars', () => {
    const config = getRateLimitConfig({
      RATE_LIMIT_WINDOW_MS: '30000',
      RATE_LIMIT_MAX_REQUESTS: '50',
    })
    expect(config.windowMs).toBe(30_000)
    expect(config.maxRequests).toBe(50)
  })

  it('falls back to defaults for invalid values', () => {
    const config = getRateLimitConfig({
      RATE_LIMIT_WINDOW_MS: 'not-a-number',
      RATE_LIMIT_MAX_REQUESTS: '0',
    })
    expect(config.windowMs).toBe(60_000)
    expect(config.maxRequests).toBe(100)
  })
})

describe('isRateLimited', () => {
  it('allows requests under the limit', () => {
    const { limited } = isRateLimited('ip1', 60_000, 3)
    expect(limited).toBe(false)
  })

  it('blocks requests at the limit', () => {
    isRateLimited('ip2', 60_000, 2)
    isRateLimited('ip2', 60_000, 2)
    const { limited, retryAfter } = isRateLimited('ip2', 60_000, 2)
    expect(limited).toBe(true)
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(60)
  })

  it('tracks keys independently', () => {
    isRateLimited('ipA', 60_000, 1)
    const { limited: aLimited } = isRateLimited('ipA', 60_000, 1)
    const { limited: bLimited } = isRateLimited('ipB', 60_000, 1)
    expect(aLimited).toBe(true)
    expect(bLimited).toBe(false)
  })
})
