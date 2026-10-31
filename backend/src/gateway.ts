import type { Env } from './types.js'
import { authApp } from './apps/auth.js'
import { apiApp } from './apps/api.js'
import { deleteExpiredAiUsageEvents } from './lib/ai-access.js'

const AUTH_ROUTES = new Set([
  '/api/auth/login',
  '/api/auth/callback',
  '/api/auth/logout',
  '/api/auth/email-login',
])

const REQUIRED_SECRETS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'WORKER_JWT_SECRET',
  'WORKER_ENCRYPTION_KEY',
] as const

const secretCache = new WeakMap<object, string[]>()

function missingSecrets(env: Env['Bindings']): string[] {
  if (env.RUN_SECRETS_CHECK !== 'true') return []
  if (env.TEST_MODE === 'true') return []
  const cacheKey = env as unknown as object
  if (secretCache.has(cacheKey)) {
    return secretCache.get(cacheKey) ?? []
  }
  const missing = REQUIRED_SECRETS.filter((k) => !env[k])
  secretCache.set(cacheKey, missing)
  return missing
}

export const gateway = {
  async fetch(request: Request, env: Env['Bindings'], ctx: ExecutionContext): Promise<Response> {
    const missing = missingSecrets(env)
    if (missing.length > 0) {
      return new Response(
        JSON.stringify({
          error: `Worker misconfigured; missing required secrets: ${missing.join(', ')}`,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const url = new URL(request.url)
    const path = url.pathname

    if (path.startsWith('/api/')) {
      if (AUTH_ROUTES.has(path)) {
        const adjustedUrl = new URL(request.url)
        adjustedUrl.pathname = path.replace(/^\/api\/auth/, '')
        const adjustedRequest = new Request(adjustedUrl.toString(), request)
        return authApp.fetch(adjustedRequest, env, ctx)
      }

      try {
        const exports = ctx.exports as Record<string, unknown> | undefined
        if (exports?.CachedApi) {
          return (exports.CachedApi as { fetch: Function }).fetch(request, env)
        }
      } catch {
        // ctx.exports not available (Miniflare / test mode)
      }
      return apiApp.fetch(request, env, ctx)
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request)
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  },

  // Daily cron (triggers.scheduled in cloudflare.config.ts): usage records
  // are deleted after one year (issue #353).
  async scheduled(
    _controller: ScheduledController,
    env: Env['Bindings'],
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(deleteExpiredAiUsageEvents(env))
  },
}
