// The generalized cron handoff (ahaqqu/RumaQ#441 — plugin architecture
// ticket 7, docs/plan/plugin-architecture.md §4.3 scheduling + §4.4 failure
// isolation): the nightly plugin-tasks cron invocation routes every
// plugin-declared scheduled task — the MANIFEST declares (name, scope), the
// registration binds the handler (plugins/types.ts), and this driver owns
// the WHEN, the enablement resolution, and the isolation. It is the seam
// plugin-purge.ts anticipated ("deliberately the thin seam that
// generalizes") generalized to declared tasks; the PURGE JOB STAYS ON THE
// CORE TICK beside this driver, not under it — its per-invocation object
// budget, budget floor and cancel race (P1-A2/P1-A3) are purge-specific
// semantics the generic handoff has no reason to learn, and its household
// set is the purge work-set (rows IN FLIGHT), not the enabled set (§4.3).
// The first real declaration rides the next task that needs scheduling
// (#426 v2 dispatch, #433 reminders, #429 recurrence sweeps) — no shipped
// plugin declares one yet (§4.3: "No plugin in v1 needs either").
//
// SUBREQUEST BUDGET (the constraint that shaped this module): each cron
// trigger is its own scheduled invocation with its own per-invocation
// subrequest cap — 50 on the free plan — so plugin tasks ride the SECOND
// trigger (PLUGIN_TASKS_CRON_SCHEDULE, cron-schedules.ts) and never compete
// with the core tick's 48/50 worst case (plugin-purge.ts's accounting).
// The driver's own fixed spend is ONE enabled-set read per household-scoped
// task (zero for 'global' or for plugins declaring nothing, i.e. today's
// nightly invocation costs no subrequests at all). Everything a HANDLER
// spends is that handler's own contract to stay within its invocation's cap
// — a spendy task must chunk/resume like the purge job does
// (PURGE_TICK_OBJECT_BUDGET is the precedent), and the first household-scoped
// declaration's driver overhead (1 read) leaves 49 free subrequests for it.
//
// FAILURE AUDIT: the artifact is a structured log line per failure — the
// codebase's existing facility for operational failures (Workers Logs
// persistence keeps the lines queryable, #451; the purge tick's
// poisoned-household isolation logs the same way, P1-A3), pinned by test.
// No failure ROWS: the 0032 lifecycle vocabulary is the closed
// enablement/purge domain (a failed task moved nothing and decided nothing —
// the purge-cancel rationale in lib/plugins.ts), a nightly failure would
// repeat for a poisoned household with no retention story and no reader, and
// widening the CHECK would need a table rebuild. If a durable failure row is
// ever wanted, the next free migration slot takes it and this module is the
// one place a writer slots in.

import { pluginRegistrations } from '../plugins/registry.js'
import { resolveEnabledHouseholdIds } from '../plugins/enablement.js'
import type { PluginRegistration } from '../plugins/types.js'
import type { Env } from '../types.js'

/**
 * The drift check between a registration's declared tasks (manifest) and its
 * bound handlers: every manifest cronTasks[].name must have exactly one
 * handler and vice versa. Returns human-readable violations (the
 * ManifestViolation shape); an empty list is the only passing state.
 * Exercised against the REAL composed registry + synthetic drift by
 * plugin-registry.test.ts (the build-time validation pattern — a binding
 * bug must fail the test, never the nightly tick; the driver's runtime
 * soft-guard below is the second net, not the first).
 */
export function cronTaskBindingViolations(
  registrations: readonly Pick<PluginRegistration, 'manifest' | 'cronTaskHandlers'>[]
): string[] {
  const violations: string[] = []
  for (const registration of registrations) {
    const { manifest, cronTaskHandlers } = registration
    const declared = (manifest.cronTasks ?? []).map((task) => task.name)
    const bound = Object.keys(cronTaskHandlers ?? {})
    for (const name of declared) {
      if (!bound.includes(name)) {
        violations.push(
          `manifest ${manifest.id}: cron task ${JSON.stringify(name)} is declared with no bound handler`
        )
      }
    }
    for (const name of bound) {
      if (!declared.includes(name)) {
        violations.push(
          `manifest ${manifest.id}: cron task handler ${JSON.stringify(name)} has no manifest declaration`
        )
      }
    }
  }
  return violations
}

/**
 * One plugin-tasks invocation: every registered plugin's declared tasks, in
 * registry order. ISOLATION IS THE CONTRACT (§4.4, the ticket's acceptance):
 * each task — and each household within a household-scoped task — runs under
 * its own try/catch; a poisoned task fails ITS plugin/household for the
 * night (logged, retried next tick) and every other plugin's task, and the
 * core tick on the other trigger, continue untouched. Enablement is resolved
 * per household by the §4.3 truth table (manifest default on an absent row);
 * an enabled-set read error fails CLOSED for that plugin's task only
 * (resolveEnabledHouseholdIds returns null → the task is skipped, logged).
 * The driver itself never throws and returns a summary for the tick's log
 * line (the #353/#426/#439 artifact pattern).
 *
 * `registrations` is injectable for the real-SQL tests (fixture plugins
 * against a real SQLite database); production callers omit it and get the
 * composed registry.
 */
export async function runPluginCronTasks(
  env: Env['Bindings'],
  registrations: readonly PluginRegistration[] = pluginRegistrations(env)
): Promise<{ ran: number; failed: number }> {
  let ran = 0
  let failed = 0
  for (const registration of registrations) {
    const { manifest } = registration
    for (const task of manifest.cronTasks ?? []) {
      const label = `${manifest.id}/${task.name}`
      const handler = registration.cronTaskHandlers?.[task.name]
      // Compose drift (declared, never bound): soft-guarded so a binding bug
      // cannot take the nightly invocation down — cronTaskBindingViolations
      // is the build-time net that makes this unreachable in CI.
      if (!handler) {
        failed += 1
        console.error(
          `[plugin-cron] ${label} is declared with no bound handler; skipping (compose drift)`
        )
        continue
      }
      if (task.scope === 'global') {
        // A global task ignores enablement (§4.3) — one call, no household.
        try {
          await handler({ db: env.DB })
          ran += 1
        } catch (err) {
          failed += 1
          console.error(`[plugin-cron] task failed for ${label}; it retries next tick`, err)
        }
        continue
      }
      // Household scope: the enabled set from ONE query, then one isolated
      // call per household — one poisoned household never costs the others
      // their night (the purge tick's P1-A3 shape).
      const householdIds = await resolveEnabledHouseholdIds(env.DB, manifest)
      if (householdIds === null) {
        // Fail closed FOR THE PLUGIN, open for core (§4.4): the task is
        // skipped this tick; everything else continues.
        failed += 1
        console.error(`[plugin-cron] enabled-set read failed for ${label}; failing closed`)
        continue
      }
      for (const householdId of householdIds) {
        try {
          await handler({ db: env.DB, householdId })
          ran += 1
        } catch (err) {
          failed += 1
          console.error(
            `[plugin-cron] task failed for ${label}/${householdId}; it retries next tick`,
            err
          )
        }
      }
    }
  }
  return { ran, failed }
}
