import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { Hono } from 'hono'
import {
  isRateLimited,
  getRateLimitConfig,
  resetRateLimit,
  ipRateLimitMiddleware,
} from '../lib/rate-limit.js'
import { createMockEnv, type MockEnv } from './support/env.js'

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

// QA-F4 (ahaqqu/RumaQ#402): the 429 must be an explicit, client-visible
// signal — body carries error + retry_after seconds, header echoes it.
describe('ipRateLimitMiddleware', () => {
  it('returns an explicit 429 body (error + retry_after) with a Retry-After header', async () => {
    const app = new Hono<{ Bindings: MockEnv }>()
    app.use('*', ipRateLimitMiddleware)
    app.get('/', (c) => c.json({ ok: true }))
    const env = createMockEnv({ RATE_LIMIT_WINDOW_MS: '60000', RATE_LIMIT_MAX_REQUESTS: '2' })
    const headers = { 'CF-Connecting-IP': '203.0.113.9' }

    expect((await app.request('/', { headers }, env)).status).toBe(200)
    expect((await app.request('/', { headers }, env)).status).toBe(200)
    const limited = await app.request('/', { headers }, env)
    expect(limited.status).toBe(429)
    const body = (await limited.json()) as { error: string; retry_after: number }
    expect(body.error).toContain('Too many requests')
    expect(Number.isInteger(body.retry_after)).toBe(true)
    expect(body.retry_after).toBeGreaterThan(0)
    expect(limited.headers.get('Retry-After')).toBe(String(body.retry_after))
  })
})
