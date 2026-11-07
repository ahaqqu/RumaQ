import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'
import { Hono } from 'hono'
import {
  isRateLimited,
  getRateLimitConfig,
  getLoginRateLimitConfig,
  resetRateLimit,
  ipRateLimitMiddleware,
  DEFAULT_LOGIN_RATE_MAX,
  DEFAULT_LOGIN_RATE_WINDOW_SEC,
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

// QA-F4 login limiter (ahaqqu/RumaQ#402): production runs the compiled-in
// 10 attempts / 60 s budget. ahaqqu/RumaQ#499 adds env knobs so the e2e
// harness can raise it; the defaults themselves must never weaken and no
// invalid value may turn the limiter off.
describe('getLoginRateLimitConfig', () => {
  it('defaults to the production budget: 10 attempts per 60 s', () => {
    const config = getLoginRateLimitConfig({})
    expect(config.maxAttempts).toBe(DEFAULT_LOGIN_RATE_MAX)
    expect(config.maxAttempts).toBe(10)
    expect(config.windowMs).toBe(DEFAULT_LOGIN_RATE_WINDOW_SEC * 1000)
    expect(config.windowMs).toBe(60_000)
  })

  it('reads LOGIN_RATE_MAX / LOGIN_RATE_WINDOW_SEC overrides', () => {
    const config = getLoginRateLimitConfig({
      LOGIN_RATE_MAX: '1000000',
      LOGIN_RATE_WINDOW_SEC: '5',
    })
    expect(config.maxAttempts).toBe(1_000_000)
    expect(config.windowMs).toBe(5_000)
  })

  it('falls back to the production default for invalid values', () => {
    for (const LOGIN_RATE_MAX of ['', '0', '-5', 'abc', '10.5', 'NaN']) {
      expect(getLoginRateLimitConfig({ LOGIN_RATE_MAX }).maxAttempts).toBe(10)
    }
    for (const LOGIN_RATE_WINDOW_SEC of ['', '0', '-60', 'abc', '0.5']) {
      expect(getLoginRateLimitConfig({ LOGIN_RATE_WINDOW_SEC }).windowMs).toBe(60_000)
    }
  })
})

describe('login limiter budget', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('trips on the 11th attempt with the default budget', () => {
    const { windowMs, maxAttempts } = getLoginRateLimitConfig({})
    for (let attempt = 1; attempt <= 10; attempt++) {
      expect(isRateLimited('login-default', windowMs, maxAttempts).limited).toBe(false)
    }
    expect(isRateLimited('login-default', windowMs, maxAttempts).limited).toBe(true)
  })

  it('honours the configured window: the budget re-opens once it elapses', () => {
    const { windowMs, maxAttempts } = getLoginRateLimitConfig({
      LOGIN_RATE_MAX: '2',
      LOGIN_RATE_WINDOW_SEC: '5',
    })
    expect(isRateLimited('login-window', windowMs, maxAttempts).limited).toBe(false)
    expect(isRateLimited('login-window', windowMs, maxAttempts).limited).toBe(false)
    expect(isRateLimited('login-window', windowMs, maxAttempts).limited).toBe(true)

    vi.setSystemTime(Date.now() + 4_999)
    expect(isRateLimited('login-window', windowMs, maxAttempts).limited).toBe(true)

    vi.setSystemTime(Date.now() + 1)
    expect(isRateLimited('login-window', windowMs, maxAttempts).limited).toBe(false)
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
