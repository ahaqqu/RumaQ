import { createMiddleware } from 'hono/factory'
import type { Env } from '../types.js'

type WindowEntry = {
  count: number
  resetAt: number
}

// In-memory fixed-window rate limiter: one counter per key, reset when the
// window expires. This is acceptable for an MVP running on a single Worker
// instance. For multi-instance production deployments, move this state to
// Cloudflare KV.
const windows = new Map<string, WindowEntry>()

export function getRateLimitConfig(env: {
  RATE_LIMIT_WINDOW_MS?: string
  RATE_LIMIT_MAX_REQUESTS?: string
}): { windowMs: number; maxRequests: number } {
  const parsedWindow = Number(env.RATE_LIMIT_WINDOW_MS)
  const parsedMax = Number(env.RATE_LIMIT_MAX_REQUESTS)
  const windowMs = Number.isFinite(parsedWindow) && parsedWindow > 0 ? parsedWindow : 60_000
  const maxRequests = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 100
  return { windowMs, maxRequests }
}

// QA-F4 login limiter (ahaqqu/RumaQ#402): /email-login runs its own, much
// tighter fixed window than the general API limiter. These are the PRODUCTION
// defaults — 10 attempts per 60 s per client IP — and nothing in the app may
// weaken them; they are the single source of truth for both the parser default
// and the docs.
//
// The local/e2e harness logs the whole suite in from one Docker IP (browser
// logins carry no X-Forwarded-For, so every scenario shares one bucket), which
// is more than 10 attempts. Rather than carrying a test-only branch in the
// app, it raises the budget through LOGIN_RATE_MAX / LOGIN_RATE_WINDOW_SEC in
// automation/docker-compose.yml (ahaqqu/RumaQ#499).
export const DEFAULT_LOGIN_RATE_MAX = 10
export const DEFAULT_LOGIN_RATE_WINDOW_SEC = 60

// Env parsing for the login limiter. Anything that is not a positive integer
// (missing, NaN, 0, negative, fractional) falls back to the production default:
// a typo can make the limit tighter or leave it unchanged, never unlimited.
function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function getLoginRateLimitConfig(env: {
  LOGIN_RATE_MAX?: string
  LOGIN_RATE_WINDOW_SEC?: string
}): { windowMs: number; maxAttempts: number } {
  const maxAttempts = positiveInteger(env.LOGIN_RATE_MAX, DEFAULT_LOGIN_RATE_MAX)
  const windowMs = positiveInteger(env.LOGIN_RATE_WINDOW_SEC, DEFAULT_LOGIN_RATE_WINDOW_SEC) * 1000
  return { windowMs, maxAttempts }
}

export function isRateLimited(
  key: string,
  windowMs: number,
  maxRequests: number
): { limited: boolean; retryAfter: number } {
  const now = Date.now()
  const entry = windows.get(key)

  if (!entry || now >= entry.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs })
    return { limited: false, retryAfter: 0 }
  }

  if (entry.count < maxRequests) {
    entry.count += 1
    return { limited: false, retryAfter: 0 }
  }

  const retryAfter = Math.ceil((entry.resetAt - now) / 1000)
  return { limited: true, retryAfter }
}

export function resetRateLimit(key?: string): void {
  if (key) {
    windows.delete(key)
  } else {
    windows.clear()
  }
}

// Rate-limit by client IP. In production, Cloudflare sets CF-Connecting-IP,
// which is authoritative. The X-Forwarded-For fallback is only for the local
// Docker test stack, where the reverse proxy supplies a synthetic IP per test
// scenario. A browser client cannot spoof CF-Connecting-IP. Shared so the
// stricter per-endpoint limiters (e.g. /email-login, QA-F4) key identically
// to the general middleware.
export function getClientIp(c: { req: { header(name: string): string | undefined } }): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  )
}

// General per-user/per-IP API rate limiting, shared by every public domain
// app (api.ts and households.ts run the same stack). Applied after CORS but
// before auth so that unauthenticated bursts are also throttled. Keys are
// in-memory only; move to KV for multi-instance deployments. A domain app can
// layer a stricter, keyed limiter on top (e.g. invite-code redemption) using
// isRateLimited directly.
export const ipRateLimitMiddleware = createMiddleware<Env>(async (c, next) => {
  const key = `api:${getClientIp(c)}`
  const { windowMs, maxRequests } = getRateLimitConfig(c.env)
  const { limited, retryAfter } = isRateLimited(key, windowMs, maxRequests)
  if (limited) {
    // Explicit client-visible signal (QA-F4): the body carries retry_after so
    // clients that never read the Retry-After header still get the number.
    return c.json({ error: 'Too many requests. Please slow down.', retry_after: retryAfter }, 429, {
      'Retry-After': String(retryAfter),
    })
  }
  await next()
})
