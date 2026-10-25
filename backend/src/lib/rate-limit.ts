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
