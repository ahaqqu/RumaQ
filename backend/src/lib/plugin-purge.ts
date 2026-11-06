// The core purge driver (ahaqqu/RumaQ#439 — plugin architecture ticket 5,
// docs/plan/plugin-architecture.md §3.4). Purge cannot be a request handler
// (§4.3/§6 — a 200-document vault is 200+ storage deletes plus D1 writes,
// past the per-invocation subrequest cap of 50 free / 1000 paid), so the
// driver is a JOB: the nightly cron tick (gateway.ts scheduled) calls
// runPluginPurgeTick, which routes each purge-capable plugin's in-flight
// drains to the plugin's own PluginPurgeJob one CHUNK at a time under a
// shared object budget. drainPluginPurgesForHousehold is the same machinery
// as the callable capability the household-dissolution flow must use — the
// purge is a PRECONDITION of the cascade, never its consequence (§3.4: the
// cascade erases the only record of the storage keys).
//
// Core knows the CONTRACT (PluginPurgeJob, plugins/types.ts) and the
// work-set query (household_plugins is core-owned, 0028/0035); the plugin
// owns the HOW (its index, its port). T7 (#441) will generalize this into
// plugin-declared scheduled tasks — this module is deliberately the thin
// seam that generalizes, not the general machinery itself.

import { pluginRegistrations } from '../plugins/registry.js'
import type { Env } from '../types.js'

/**
 * The per-invocation object budget: how many storage deletes one cron tick
 * may spend across ALL drains. The Workers free plan caps EVERY invocation
 * (fetch AND scheduled) at 50 subrequests, and each storage delete, each D1
 * read and each D1 batch is one subrequest. The chunk accounting:
 *
 *   per purge chunk  = 3 D1 subrequests (claim+state read, doc page, file
 *                      keys) + 1 D1 batch (rows + cursor)
 *                    + `objects` storage deletes (1 subrequest each)
 *
 *   tick worst case  = budget(40) + 5 D1 + the tick's existing tenants
 *                      (the #353 usage sweep: 1 DELETE; the #426 expiry
 *                      sweep: 1 read) ≈ 47 < 50.
 *
 * So THE MATH FOR THE 200-DOCUMENT VAULT: ~200 objects (one file per
 * document) / 40 objects per nightly tick = 5 nightly invocations; the
 * cursor makes invocation n+1 resume exactly where n stopped. The worst
 * legal vault (200 documents × 20 files = 4,000 objects) drains in 100
 * nightly ticks — slow by design, never request-scoped, never lossy.
 * (Each chunk also processes whole documents only; zero-file documents ride
 * along for free as batch statements, not subrequests.)
 */
export const PURGE_TICK_OBJECT_BUDGET = 40

/**
 * The nightly work-set read: which (plugin, household) pairs have a drain
 * in flight. The partial index idx_household_plugins_purging (0035) holds
 * ONLY rows with a purge pending/running — ~always empty — so this seek is
 * an index seek against an (almost) empty structure, pinned by an EXPLAIN
 * in migrations.test.ts. Per-plugin (plugin_id bound) because the registry
 * hands out one PluginPurgeJob per plugin; core routes, it does not fan out.
 */
const PURGING_HOUSEHOLDS_SQL = `SELECT household_id
  FROM household_plugins
 WHERE plugin_id = ? AND purge_state IN ('pending', 'running')`

/**
 * One nightly tick: every purge-capable registration gets its share of the
 * budget, household by household, until the budget is spent. Returns a
 * summary for the log line (the #353/#426 cron precedent — the log IS the
 * artifact). A plugin job throwing fails THIS tick (the waitUntil reports
 * it); the next night replays the same chunk — every step is idempotent.
 */
export async function runPluginPurgeTick(
  env: Env['Bindings'],
  budget: number = PURGE_TICK_OBJECT_BUDGET
): Promise<{ objects: number; chunks: number }> {
  let remaining = budget
  let objects = 0
  let chunks = 0
  for (const registration of pluginRegistrations(env)) {
    const { purge } = registration
    if (!purge) continue
    const { results } = await env.DB.prepare(PURGING_HOUSEHOLDS_SQL)
      .bind(registration.manifest.id)
      .all<{ household_id: string }>()
    for (const { household_id: householdId } of results) {
      if (remaining <= 0) return { objects, chunks }
      const chunk = await purge({ db: env.DB, householdId, maxObjects: remaining })
      remaining -= chunk.objects
      objects += chunk.objects
      chunks += 1
    }
  }
  return { objects, chunks }
}

/**
 * The household-dissolution precondition (§3.4, the ticket's ordering
 * requirement): drain EVERY purge-capable plugin for ONE household to
 * completion — bytes gone, plugin rows gone, receipts written — BEFORE the
 * caller may delete the household row. The dissolution flow does not exist
 * yet (no route deletes a household; leaveHousehold only removes
 * memberships) — when it lands, IT MUST CALL THIS FIRST, then
 * `DELETE FROM households`, in that order; a test in plugin-purge.test.ts
 * pins both directions of that contract (drain-then-cascade is safe;
 * cascade-first orphans every object). Budget-capped like the tick: a vault
 * too big for one invocation's subrequest cap returns complete: false and
 * the caller re-calls (resumable — same cursor, same idempotency).
 */
export async function drainPluginPurgesForHousehold(
  env: Env['Bindings'],
  householdId: string,
  budget: number = PURGE_TICK_OBJECT_BUDGET
): Promise<{ complete: boolean; objects: number }> {
  let remaining = budget
  let objects = 0
  // `complete` stays true unless the budget runs out: each plugin's loop
  // exits only through `drained` (that plugin has nothing left) or through
  // the budget return below (the caller re-calls and resumes).
  let complete = true
  for (const registration of pluginRegistrations(env)) {
    const { purge } = registration
    if (!purge) continue
    for (;;) {
      if (remaining <= 0) return { complete: false, objects }
      const chunk = await purge({ db: env.DB, householdId, maxObjects: remaining })
      remaining -= chunk.objects
      objects += chunk.objects
      if (chunk.drained) break
    }
  }
  return { complete, objects }
}
