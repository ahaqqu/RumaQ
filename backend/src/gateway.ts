import type { Env } from './types.js'
import { authApp } from './apps/auth.js'
import { apiApp } from './apps/api.js'
import { householdsApp } from './apps/households.js'
import { tasksApp } from './apps/tasks.js'
import { calendarApp } from './apps/calendar.js'
import { pluginsApp } from './apps/plugins.js'
import { matchPlugin } from './plugins/registry.js'
import { deleteExpiredAiUsageEvents } from './lib/ai-access.js'
import { logDueDocumentReminders } from './lib/document-expiry.js'
import { PURGE_TICK_OBJECT_BUDGET, runPluginPurgeTick } from './lib/plugin-purge.js'

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

      // Household member management (ahaqqu/RumaQ#331) is its own domain app
      // (backend conventions: one app per domain) — dispatched before the
      // general apiApp fallthrough. Core domain, not a plugin: enablement is
      // not a household choice here.
      if (path === '/api/households' || path.startsWith('/api/households/')) {
        return householdsApp.fetch(request, env, ctx)
      }

      // Household tasks (ahaqqu/RumaQ#429) — same domain-app pattern.
      if (path === '/api/tasks' || path.startsWith('/api/tasks/')) {
        return tasksApp.fetch(request, env, ctx)
      }

      // Household calendar (ahaqqu/RumaQ#430) — core domain, NOT a plugin:
      // the shared family calendar (stored events + derive-on-read document
      // deadlines) is a household fixture like tasks, not an enablement
      // choice. One app, one prefix: /api/calendar serves the view union,
      // /api/calendar/events the stored-event CRUD.
      if (path === '/api/calendar' || path.startsWith('/api/calendar/')) {
        return calendarApp.fetch(request, env, ctx)
      }

      // Plugin settings catalog (ahaqqu/RumaQ#437, plugin architecture §4.5):
      // the CORE-owned enablement surface — household_plugins CRUD + the
      // lifecycle audit. Deliberately NOT a plugin and dispatched AHEAD of the
      // registry's prefix matching: it must answer even when every plugin is
      // disabled, because it is the thing that re-enables them. This block —
      // like every core dispatch above — is one of CORE_GATEWAY_PREFIXES
      // (plugins/core-prefixes.ts): validatePluginManifests rejects any
      // manifest claiming one of these prefixes, so matchPlugin below can
      // never shadow a core app. Keep the two in lockstep when adding one.
      if (path === '/api/plugins' || path.startsWith('/api/plugins/')) {
        return pluginsApp.fetch(request, env, ctx)
      }

      // Plugin dispatch (ahaqqu/RumaQ#435, plugin architecture §4.3): the
      // registry owns plugin prefixes (documents registered first). Dispatch
      // stays path-only and boundary-aware (`path === p ||
      // path.startsWith(p + '/')`) — the household-aware enablement gate
      // installs after auth INSIDE each plugin app, where the household is
      // actually known.
      const plugin = matchPlugin(path, env)
      if (plugin) {
        return plugin.app.fetch(request, env, ctx)
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
  // are deleted after one year (issue #353), and the document expiry sweep
  // (#426) computes + logs the per-household due set — v1 renders in-app only
  // (no new notification channel); v2 dispatch rides this same sweep. The
  // plugin purge chunk driver (#439, ticket 5) rides the same tick: one
  // budgeted chunk per in-flight drain per night (PURGE_TICK_OBJECT_BUDGET
  // carries the subrequest math — a scheduled invocation shares the fetch
  // path's 50-subrequest cap). T7 (#441) will generalize plugin-declared
  // scheduled tasks on top of the PluginPurgeJob seam; the general cron
  // machinery is deliberately NOT built here.
  async scheduled(
    _controller: ScheduledController,
    env: Env['Bindings'],
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(deleteExpiredAiUsageEvents(env))
    ctx.waitUntil(logDueDocumentReminders(env.DB))
    ctx.waitUntil(
      runPluginPurgeTick(env, PURGE_TICK_OBJECT_BUDGET).then((summary) => {
        // The log line is the tick's artifact (the #353/#426 cron
        // precedent): one line per night with an active drain.
        if (summary.chunks > 0) {
          console.log(
            `[plugin-purge] tick: ${summary.chunks} chunk(s), ${summary.objects} object(s) deleted`
          )
        }
      })
    )
  },
}
