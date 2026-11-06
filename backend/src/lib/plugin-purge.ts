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
// Core knows the CONTRACT (PluginPurgeJob + purgeBudgetFloor,
// plugins/types.ts) and the work-set query (household_plugins is
// core-owned, 0028/0035); the plugin owns the HOW (its index, its port).
// T7 (#441) will generalize this into plugin-declared scheduled tasks —
// this module is deliberately the thin seam that generalizes, not the
// general machinery itself.

import { pluginRegistrations } from '../plugins/registry.js'
import { ENABLEMENT_UPSERT_SQL, PURGE_INITIATE_SQL } from './plugins.js'
import { HOUSEHOLD_ENABLEMENT_ROWS_SQL, type EnablementSpec } from '../plugins/enablement.js'
import type { Env } from '../types.js'

/**
 * The per-invocation object budget: how many storage deletes one cron tick
 * may spend across ALL drains. The Workers free plan caps EVERY invocation
 * (fetch AND scheduled) at 50 subrequests, and each storage delete, each D1
 * read and each D1 batch is one subrequest. The accounting (P1-A4, PR #474
 * review — recounted, every statement counted):
 *
 *   per purge chunk  = 4 D1 reads (claim UPDATE, state read-back, doc page,
 *                      file keys) + 1 D1 batch (rows + cursor)
 *                    + `objects` storage deletes (1 subrequest each)
 *   per tick, fixed  = 1 work-set seek per purge-capable plugin
 *                    + 2 sibling sweeps (#353 usage DELETE, #426 expiry read)
 *
 *   tick worst case  = 40 deletes + 5 (chunk) + 1 (work-set) + 2 (sweeps)
 *                    = 48 < 50.
 *
 * So THE MATH FOR THE 200-DOCUMENT VAULT: ~200 objects (one file per
 * document) / 40 objects per nightly tick = 5 nightly invocations; the
 * cursor makes invocation n+1 resume exactly where the last one stopped.
 * The worst legal vault (200 documents × 20 files = 4,000 objects) drains
 * in 100 nightly ticks — slow by design, never request-scoped, never lossy.
 * (Each chunk also processes whole documents only; zero-file documents ride
 * along for free as batch statements, not subrequests.) NOTE FOR T7: the
 * second purge-capable plugin doubles the work-set term — 49 is the last
 * free slot on the free plan; the third needs the paid tier (1000).
 */
export const PURGE_TICK_OBJECT_BUDGET = 40

/**
 * The nightly work-set read: which (plugin, household) pairs have a drain
 * in flight. The partial index idx_household_plugins_purging (0035) holds
 * ONLY rows with a purge pending/running — ~always empty — so this seek is
 * an index seek against an (almost) empty structure, pinned by an EXPLAIN
 * in migrations.test.ts (the exact-statement pin — this constant IS what
 * ships). Per-plugin (plugin_id bound) because the registry hands out one
 * PluginPurgeJob per plugin; core routes, it does not fan out.
 */
export const PURGING_HOUSEHOLDS_SQL = `SELECT household_id
  FROM household_plugins
 WHERE plugin_id = ? AND purge_state IN ('pending', 'running')`

/**
 * Mark (or confirm) a household's purge as requested, for the dissolution
 * drain: a drain must never run against a household whose plugin has no
 * ACTIVE purge row — `complete` would otherwise mean "nothing was pending",
 * and the cascade would erase post-purge uploads (with their bytes' only
 * key records) with no receipt at all. Idempotent: an already
 * pending/running row is left alone (the owner's original request, actor
 * and all); an absent row is materialized at its RESOLVED enablement status
 * first (the initiation endpoint's own shape — no enablement transition, no
 * lifecycle receipt); a 'done' row re-enters 'pending' for the new data.
 * The drain's actor rides purge_requested_by when the drain is the first
 * requester (a dissolution is an owner-authorized act); an owner-initiated
 * request keeps its owner. A mid-drain CANCEL surfaces as the plugin job's
 * typed PluginPurgeCancelledError (plugins/documents/purge.ts) — it
 * propagates to the caller, because a household that cancelled does not
 * want its remaining documents erased; re-invoking the drain re-requests
 * the purge (an explicit caller decision), it never resumes silently.
 * Exported so tests pin the enablement resolution by the exact function
 * (the ENABLEMENT_UPSERT_SQL precedent).
 */
export async function ensurePurgePending(
  db: D1Database,
  householdId: string,
  spec: EnablementSpec,
  actorUserId: string | null
): Promise<void> {
  const { results } = await db
    .prepare(HOUSEHOLD_ENABLEMENT_ROWS_SQL)
    .bind(householdId)
    .all<{ plugin_id: string; status: string }>()
  const existing = results.find((row) => row.plugin_id === spec.id)
  await db.batch([
    // An ABSENT row is materialized at the manifest's RESOLVED default
    // (P1R2-B2, PR #474 review — this used to hardcode 'enabled') — the
    // initiation endpoint's own shape (requestPluginPurge in lib/plugins.ts)
    // — so a future default-off purge-capable plugin cannot gain enablement
    // as a side effect of a drain. An unknown manifest cannot resolve a
    // default and fails closed (the enablement resolver's posture);
    // unreachable through the drain, whose caller iterates registrations.
    db
      .prepare(ENABLEMENT_UPSERT_SQL)
      .bind(
        householdId,
        spec.id,
        existing === undefined ? (spec.defaultEnabled ? 'enabled' : 'disabled') : existing.status
      ),
    db.prepare(PURGE_INITIATE_SQL).bind(actorUserId, householdId, spec.id),
  ])
}

/**
 * One nightly tick: every purge-capable registration gets its share of the
 * budget, household by household, until the budget can no longer hold a
 * whole document of that plugin (the registration's purgeBudgetFloor —
 * P1-A2: a sub-floor remainder used to be handed to the job, which refused
 * it by contract, aborting the whole tick and starving every household
 * behind it). A failing household is ISOLATED, not fatal: the error is
 * logged (the log line is the tick's artifact — the #353/#426 precedent)
 * and the remaining households still get their chunk that night; the
 * failed drain retries next night from its cursor (every step idempotent).
 * Returns a summary for the log line.
 */
export async function runPluginPurgeTick(
  env: Env['Bindings'],
  budget: number = PURGE_TICK_OBJECT_BUDGET
): Promise<{ objects: number; chunks: number; failed: number }> {
  let remaining = budget
  let objects = 0
  let chunks = 0
  let failed = 0
  for (const registration of pluginRegistrations(env)) {
    const { purge, purgeBudgetFloor } = registration
    if (!purge) continue
    const floor = purgeBudgetFloor ?? 1
    const { results } = await env.DB.prepare(PURGING_HOUSEHOLDS_SQL)
      .bind(registration.manifest.id)
      .all<{ household_id: string }>()
    for (const { household_id: householdId } of results) {
      // Budget exhausted for this plugin's whole-document granularity: stop
      // the tick — the next night resumes from the cursor. Never hand out a
      // sub-floor chunk (the job would refuse it — the P1-A2 stall).
      if (remaining < floor) return { objects, chunks, failed }
      try {
        const chunk = await purge({ db: env.DB, householdId, maxObjects: remaining })
        remaining -= chunk.objects
        objects += chunk.objects
        chunks += 1
      } catch (err) {
        // One poisoned household (a corrupted r2_key, say) must not take the
        // others' night down with it — the owner's cancel lever (the DELETE
        // endpoint) releases a drain that can never complete.
        failed += 1
        console.error(
          `[plugin-purge] chunk failed for ${registration.manifest.id}/${householdId}; it retries next tick (cancel via DELETE /api/plugins/${registration.manifest.id}/purge)`,
          err
        )
      }
    }
  }
  return { objects, chunks, failed }
}

/**
 * The household-dissolution precondition (§3.4, the ticket's ordering
 * requirement): drain EVERY purge-capable plugin for ONE household to
 * completion — purge requested, bytes gone, plugin rows gone, receipts
 * written — BEFORE the caller may delete the household row. The dissolution
 * flow does not exist yet (no route deletes a household; leaveHousehold
 * only removes memberships) — when it lands, IT MUST CALL THIS FIRST, then
 * `DELETE FROM households`, in that order; a test in plugin-purge.test.ts
 * pins both directions of that contract (drain-then-cascade is safe;
 * cascade-first orphans every object). The drain REQUESTS the purge itself
 * (ensurePurgePending) — `complete: true` therefore always means a
 * confirmed completion receipt exists, never "there was nothing pending".
 *
 * Budget-capped like the tick: a vault too big for one invocation's
 * subrequest cap returns complete: false and the caller re-calls
 * (resumable — same cursor, same idempotency); a remaining budget below the
 * registration's purgeBudgetFloor is exhaustion, not a callable chunk
 * (P1-A2). `actorUserId` names the dissolution's authorized actor for the
 * receipt when the owner has not already requested the purge.
 */
export async function drainPluginPurgesForHousehold(
  env: Env['Bindings'],
  householdId: string,
  opts: { actorUserId?: string | null; budget?: number } = {}
): Promise<{ complete: boolean; objects: number }> {
  const budget = opts.budget ?? PURGE_TICK_OBJECT_BUDGET
  let remaining = budget
  let objects = 0
  // `complete` stays true unless the budget runs out: each plugin's loop
  // exits only through `drained` (that plugin has nothing left) or through
  // the budget return below (the caller re-calls and resumes).
  let complete = true
  for (const registration of pluginRegistrations(env)) {
    const { purge, purgeBudgetFloor } = registration
    if (!purge) continue
    const floor = purgeBudgetFloor ?? 1
    await ensurePurgePending(env.DB, householdId, registration.manifest, opts.actorUserId ?? null)
    for (;;) {
      if (remaining < floor) return { complete: false, objects }
      const chunk = await purge({ db: env.DB, householdId, maxObjects: remaining })
      remaining -= chunk.objects
      objects += chunk.objects
      if (chunk.drained) break
    }
  }
  return { complete, objects }
}
