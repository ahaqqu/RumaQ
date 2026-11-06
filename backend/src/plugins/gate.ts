// The plugin enablement gate (ahaqqu/RumaQ#435 — plugin architecture phase A,
// docs/plan/plugin-architecture.md §4.3). The household-aware middleware
// installed AFTER auth INSIDE each plugin app: gateway dispatch is path-only
// (gateway.ts) and the household is unknown until propsAuthMiddleware has
// resolved it (auth.ts), so a gateway-level check would have to re-implement
// auth or guess — rev 2 moved the gate here for exactly that reason.
//
// A disabled (or not-available) plugin answers 404 with the standard error
// envelope — fail closed, consistent with the foreign-household posture
// (§3.2). Not a secrecy claim: the settings catalog advertises every plugin
// anyway (ticket 3), so enablement is deliberately not hidden (plan §4.3).
// Acknowledged consequence: this 404 is distinguishable from a route-miss 404
// (no-cache header + the error envelope) and from a plain apiApp 404 — a
// sanctioned oracle for tests/ops, not a leak to close.
import { createMiddleware } from 'hono/factory'
import type { MiddlewareHandler } from 'hono'
import type { Env } from '../types.js'
import { pluginManifestById, type PluginId } from './manifests.js'
import { resolvePluginEnabled } from './enablement.js'
import { isPluginDeploymentAvailable } from './flags.js'

// Per-household fact — never cached at the edge (every other authenticated
// response in the app carries the same directive).
const NO_CACHE = { 'Cache-Control': 'private, no-cache' }

/**
 * One gate per plugin, installed on every path pattern the plugin's auth
 * lines cover — plugins/documents/app.ts registers auth and the gate from
 * ONE shared pattern list, so the pairing is structural (`use(path)` does not cover
 * subpaths, the #292 landmine). Registered after the auth middleware so the
 * household variable is always set when the gate runs.
 */
export function pluginGate(pluginId: PluginId): MiddlewareHandler<Env> {
  const manifest = pluginManifestById(pluginId)
  return createMiddleware<Env>(async (c, next) => {
    const householdId = c.get('householdId')
    // Auth always ran ahead on the same paths, so a missing household is a
    // wiring mistake, not a state to guess around — deny.
    if (!manifest || !householdId) {
      return c.json({ error: 'Not found' }, 404, NO_CACHE)
    }
    // Layer 1 — deployment availability (the ops kill-switch): FAIL-OPEN on
    // a read error; a flags outage must not take the plugin down (§3.3).
    if (!(await isPluginDeploymentAvailable(c.env, manifest.id))) {
      return c.json({ error: 'Not found' }, 404, NO_CACHE)
    }
    // Layer 2 — household enablement (the customer's choice): FAIL-CLOSED on
    // a read error — a privacy promise (§3.3, §4.4). The two postures are
    // deliberate and must never be unified.
    if (!(await resolvePluginEnabled(c.env.DB, householdId, manifest))) {
      return c.json({ error: 'Not found' }, 404, NO_CACHE)
    }
    // Layer 3 — plan entitlement (§3.3/§6) composes here from ticket 3 on:
    // household enablement is a preference and never reads user_plans; the
    // entitlement check stays a paywall per route.
    await next()
  })
}
