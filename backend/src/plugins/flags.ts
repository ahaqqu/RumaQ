// Deployment availability flags (ahaqqu/RumaQ#435 — plugin architecture phase
// A, docs/plan/plugin-architecture.md §3.3/§4.6). The ops kill-switch is
// data (0029), read once per isolate with a ≤30 s cache — the same
// module-state-per-isolate pattern the gateway's secrets check uses
// (gateway.ts secretCache). cloudflare.config.ts carries no flag state: a
// flag there is a PR plus a deploy, the wrong latency for the incident this
// lever exists to handle.
//
// FAIL-OPEN: a read error, like an absent key, means "available" (§8.6). A
// flags outage must not take the vault down — this is the deliberate
// opposite of household enablement (enablement.ts), which fails CLOSED for
// privacy. The two postures are documented at each read and must never be
// unified. A failed read is NOT cached, so the next request retries instead
// of pinning the failure for a TTL.

export const DEPLOYMENT_FLAGS_TTL_MS = 30_000

/** The one key shape phase A writes. Absent key = available; 'off' = down. */
export function deploymentFlagKey(pluginId: string): string {
  return `plugin.${pluginId}.available`
}

export const DEPLOYMENT_FLAGS_SQL = 'SELECT key, value FROM deployment_flags'

type FlagCacheEntry = {
  fetchedAt: number
  flags: Map<string, string>
}

// Module state lives for the isolate's lifetime; keyed by the env object so
// tests (and multi-binding setups) never share cache across envs.
const flagCache = new WeakMap<object, FlagCacheEntry>()

/**
 * The flag map for this isolate, or null when the read failed (fail-open
 * signal for the caller). `now` is injectable so tests can cross the TTL
 * boundary without a real 30 s wait.
 */
export async function getDeploymentFlags(
  env: { DB: D1Database },
  now: number = Date.now()
): Promise<Map<string, string> | null> {
  const cached = flagCache.get(env)
  if (cached && now - cached.fetchedAt < DEPLOYMENT_FLAGS_TTL_MS) {
    return cached.flags
  }
  try {
    const { results } = await env.DB.prepare(DEPLOYMENT_FLAGS_SQL).all<{
      key: string
      value: string
    }>()
    const flags = new Map(results.map((row) => [row.key, row.value]))
    flagCache.set(env, { fetchedAt: now, flags })
    return flags
  } catch (err) {
    console.warn('[plugins] deployment_flags read failed; failing open', err)
    return null
  }
}

/**
 * Is the plugin available on THIS deployment? Layer 1 of the gate (§3.3):
 * effective access is deployment-available AND household-enabled (the plan
 * entitlement composes later, ticket 3+). Absent key, unknown value, and a
 * failed read all mean available — only an explicit 'off' says no.
 */
export async function isPluginDeploymentAvailable(
  env: { DB: D1Database },
  pluginId: string,
  now: number = Date.now()
): Promise<boolean> {
  const flags = await getDeploymentFlags(env, now)
  if (!flags) return true
  return flags.get(deploymentFlagKey(pluginId)) !== 'off'
}
