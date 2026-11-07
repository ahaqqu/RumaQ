import type { Env } from './types.js'
import { authApp } from './apps/auth.js'
import { apiApp } from './apps/api.js'
import { householdsApp } from './apps/households.js'
import { tasksApp } from './apps/tasks.js'
import { calendarApp } from './apps/calendar.js'
import { pluginsApp } from './apps/plugins.js'
import { matchPlugin } from './plugins/registry.js'
import { isApiPath } from './plugins/core-prefixes.js'
import { deleteExpiredAiUsageEvents } from './lib/ai-access.js'
import { logDueDocumentReminders } from './lib/document-expiry.js'
import { PURGE_TICK_OBJECT_BUDGET, runPluginPurgeTick } from './lib/plugin-purge.js'
import { runPluginCronTasks } from './lib/plugin-cron.js'
import { runReviewAiSweep } from './lib/review-ai.js'
import { PLUGIN_TASKS_CRON_SCHEDULE, REVIEW_AI_CRON_SCHEDULE } from './cron-schedules.js'

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

    if (isApiPath(path)) {
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

  // Cron dispatch (triggers.scheduled in cloudflare.config.ts — THREE
  // schedules since the AI review sweep (#484), cron-schedules.ts carries the
  // strings and the budget rationale). Each trigger is its own invocation with
  // its own per-invocation subrequest cap, and the handler tells them apart
  // via ScheduledController.cron:
  //
  //   CORE_CRON_SCHEDULE ('17 3 * * *') — usage records are deleted after one
  //   year (issue #353), the document expiry sweep (#426) computes + logs the
  //   per-household due set — v1 renders in-app only (no new notification
  //   channel); v2 dispatch rides this same sweep — and the plugin purge
  //   chunk driver (#439, ticket 5) rides the same tick: one budgeted chunk
  //   per in-flight drain per night (PURGE_TICK_OBJECT_BUDGET carries the
  //   subrequest math). Worst case 48/50 with one purge-capable plugin —
  //   which is exactly why plugin-declared tasks do NOT join this invocation.
  //
  //   PLUGIN_TASKS_CRON_SCHEDULE ('43 3 * * *') — the generalized handoff
  //   (ticket 7, #441): every plugin-declared cron task, per-task and
  //   per-household error-isolated (lib/plugin-cron.ts). No shipped plugin
  //   declares a task yet, so this invocation is a no-op until the first
  //   declaration lands.
  //
  //   REVIEW_AI_CRON_SCHEDULE ('*/30 * * * *') — the AI match-review sweep
  //   (#484): lib/review-ai.ts's runReviewAiSweep, which is itself the mode
  //   gate (only `auto` makes provider calls; manual/assist return before the
  //   first one) and is bounded to ≤20 pending items per tick.
  //
  // Anything else (undefined in tests / local tooling) falls through to the
  // core tick — the safe default, never the plugin fan-out or the AI sweep.
  async scheduled(
    controller: ScheduledController,
    env: Env['Bindings'],
    ctx: ExecutionContext
  ): Promise<void> {
    if (controller.cron === PLUGIN_TASKS_CRON_SCHEDULE) {
      ctx.waitUntil(
        runPluginCronTasks(env).then((summary) => {
          // The log line is the tick's artifact (the #353/#426/#439
          // precedent); silent on a night with nothing declared.
          if (summary.ran + summary.failed > 0) {
            console.log(`[plugin-cron] tick: ${summary.ran} ran, ${summary.failed} failed`)
          }
        })
      )
      return
    }
    if (controller.cron === REVIEW_AI_CRON_SCHEDULE) {
      ctx.waitUntil(
        runReviewAiSweep(env).catch((err: unknown) => {
          // A failed sweep must never fail the invocation or the next tick:
          // no verdict was written, the item stays pending, the next tick
          // retries it (the same degrade-on-failure posture as a provider
          // error).
          console.error('[review-ai] cron sweep failed', err)
        })
      )
      return
    }
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
