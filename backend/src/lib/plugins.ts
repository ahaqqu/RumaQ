// Plugin settings catalog + owner-only enablement (ahaqqu/RumaQ#437 — plugin
// architecture ticket 3, docs/plan/plugin-architecture.md §3.3/§4.3/§4.5).
// The settings catalog is CORE-owned (§4.5 — a plugin never contributes its
// own settings screen): it advertises every manifest (not a secrecy claim,
// §3.2), reports each enablement layer honestly, and writes household_plugins
// + the lifecycle audit trail (0032) in ONE batch. Enablement rows themselves
// stay read through plugins/enablement.ts's statements — that module owns the
// household_plugins read vocabulary (§4.1 forbidden-3) even though this lib,
// not a plugin, is the writer.
import type { Env } from '../types.js'
import { pluginManifestById, PLUGIN_MANIFESTS } from '../plugins/manifests.js'
import type { PluginManifest } from '../plugins/types.js'
import { HOUSEHOLD_ENABLEMENT_ROWS_SQL } from '../plugins/enablement.js'
import { isPluginDeploymentAvailable } from '../plugins/flags.js'
import { requireOwner } from './households.js'

export type PluginEnablementStatus = 'enabled' | 'disabled'

/** Where a plugin's enablement state comes from (§4.3 truth table). */
export type PluginEnablementSource = 'default' | 'household'

/** One catalog row: the manifest's public slice plus every posture layer. */
export type PluginCatalogEntry = {
  id: string
  name: string
  capabilities: string[]
  default_enabled: boolean
  /** The household layer, resolved: an absent row falls back to the default. */
  enabled: boolean
  source: PluginEnablementSource
  /** Layer 1 — the ops kill-switch (fail-open read, §3.3). */
  deployment_available: boolean
  /** Layer 3 — the plan paywall. See the note at pluginPlanEntitled. */
  plan_entitled: boolean
  /** The §3.3 conjunction: deployment ∧ plan ∧ household. */
  available: boolean
}

/** The pluginId path parameter named no registered manifest. */
export class PluginNotFoundError extends Error {
  constructor() {
    super('Plugin not found')
  }
}

/** The household layer for one manifest, given the household's rows. */
function resolveEnablement(
  manifest: { id: string; defaultEnabled: boolean },
  rows: ReadonlyMap<string, string>
): { enabled: boolean; source: PluginEnablementSource } {
  const status = rows.get(manifest.id)
  if (status === undefined) return { enabled: manifest.defaultEnabled, source: 'default' }
  return { enabled: status === 'enabled', source: 'household' }
}

/**
 * Layer 3 (plan entitlement, §3.3): the plan paywall that denies with 403 —
 * the only actionable denial. NO plugin declares required entitlements yet
 * (the manifest has no entitlement field; PLAN_ENTITLEMENTS is prices-only),
 * so every plugin is entitled tonight and the catalog still carries the
 * layer so the UI renders the full posture honestly instead of growing a
 * field later. The gate composition arrives with the first paywalled plugin.
 */
function pluginPlanEntitled(): boolean {
  return true
}

/**
 * The settings catalog (§4.5): every registered manifest in registry order,
 * each with its three-layer posture. Any member of the household may read it
 * — enablement is deliberately not hidden (§3.2); only the WRITE is
 * owner-only.
 */
export async function getPluginCatalog(
  env: Pick<Env['Bindings'], 'DB'>,
  householdId: string
): Promise<PluginCatalogEntry[]> {
  const { results } = await env.DB.prepare(HOUSEHOLD_ENABLEMENT_ROWS_SQL)
    .bind(householdId)
    .all<{ plugin_id: string; status: string }>()
  const rows = new Map(results.map((row) => [row.plugin_id, row.status]))

  const entries: PluginCatalogEntry[] = []
  for (const manifest of PLUGIN_MANIFESTS) {
    const { enabled, source } = resolveEnablement(manifest, rows)
    // flags.ts owns the kill-switch read and its fail-open posture; its
    // ≤30 s isolate cache makes the per-row reads one table read.
    const deploymentAvailable = await isPluginDeploymentAvailable(env, manifest.id)
    const planEntitled = pluginPlanEntitled()
    entries.push({
      id: manifest.id,
      name: manifest.name,
      capabilities: [...manifest.capabilities],
      default_enabled: manifest.defaultEnabled,
      enabled,
      source,
      deployment_available: deploymentAvailable,
      plan_entitled: planEntitled,
      available: deploymentAvailable && planEntitled && enabled,
    })
  }
  return entries
}

/** The enablement row this lib writes — the 0028 shape with the settings
 * column untouched (config_json belongs to a later ticket, §4.6). Exported
 * alongside AUDIT_INSERT_SQL so the real-SQL guard test (migrations.test.ts)
 * can run the exact batch, not a transcription of it. */
export const ENABLEMENT_UPSERT_SQL = `INSERT INTO household_plugins (household_id, plugin_id, status, updated_at)
VALUES (?, ?, ?, datetime('now'))
ON CONFLICT (household_id, plugin_id)
DO UPDATE SET status = excluded.status, updated_at = datetime('now')`

/** The lifecycle receipt (0032): what changed, for whom, by whom. Plain
 * handles everywhere — the receipt outlives the household (plan §3.4).
 * The INSERT..SELECT form re-checks the transition INSIDE the batch (S1-A4,
 * PR #470 review): D1 serializes the batch, not the surrounding read, so
 * two concurrent identical toggles can both pass setPluginEnablement's
 * idempotency check — the guard lets only the FIRST commit a receipt, and
 * §3.6's enable-funnel metrics never see one transition twice. The audit
 * statement runs BEFORE the upsert in the batch so the COALESCE reads the
 * row as committed pre-batch (the upsert would otherwise make every
 * transition look like a no-op); an absent row resolves to the manifest
 * default, bound as the same 'enabled'/'disabled' vocabulary the outside
 * check compares. */
export const AUDIT_INSERT_SQL = `INSERT INTO household_plugin_audit (id, household_id, plugin_id, actor_user_id, action)
SELECT ?, ?, ?, ?, ?
WHERE COALESCE(
  (SELECT status FROM household_plugins WHERE household_id = ? AND plugin_id = ?),
  ?
) <> ?`

/**
 * The owner-only enable/disable (§4.3: "a row per (household, plugin),
 * owner-only, audited"). One batch commits the row AND the audit event — a
 * half-committed toggle is a rumor, the calendar's audit discipline. Setting
 * a plugin to the state it already resolves to is an idempotent NO-OP: no
 * write, no audit row (§3.6's enable-funnel metrics read the rows; redundant
 * calls must not manufacture adoption). Returns the fresh posture.
 *
 * Concurrency (S1-A4, PR #470 review): the idempotency read is outside the
 * batch — D1 serializes the batch, not the surrounding read. A duplicate
 * concurrent toggle therefore still runs its batch; the audit receipt is
 * guarded in-batch (AUDIT_INSERT_SQL) so one transition yields exactly one
 * receipt, and the duplicate's upsert re-lands the same value. The narrow
 * residual window: a no-op decided on a stale read can miss another owner's
 * just-committed opposite transition — the fresh posture the response
 * returns plus the UI's onSettled invalidation reconcile it; a true fix
 * would need the read inside the transaction, which D1 batches cannot do.
 */
export async function setPluginEnablement(
  env: Pick<Env['Bindings'], 'DB'>,
  args: {
    householdId: string
    userId: string
    pluginId: string
    status: PluginEnablementStatus
  }
): Promise<PluginCatalogEntry> {
  const manifest = pluginManifestById(args.pluginId)
  if (!manifest) throw new PluginNotFoundError()

  // The household-admin gate (the rename/members idiom): typed 404/403 the
  // app's onError maps. Auth resolved the ACTIVE household; only the role
  // check remains.
  await requireOwner(env.DB, args.householdId, args.userId)

  const { results } = await env.DB.prepare(HOUSEHOLD_ENABLEMENT_ROWS_SQL)
    .bind(args.householdId)
    .all<{ plugin_id: string; status: string }>()
  const rows = new Map(results.map((row) => [row.plugin_id, row.status]))
  const current = resolveEnablement(manifest, rows)
  if ((current.enabled ? 'enabled' : 'disabled') === args.status) {
    // Already there — an event-free read of the current posture.
    return buildEntry(env, manifest, current)
  }

  await env.DB.batch([
    // The receipt FIRST: its in-batch guard must read the row as committed
    // pre-batch (see AUDIT_INSERT_SQL) — the upsert below lands the new
    // status and would make every transition look like a no-op.
    env.DB.prepare(AUDIT_INSERT_SQL).bind(
      crypto.randomUUID(),
      args.householdId,
      manifest.id,
      args.userId,
      args.status === 'enabled' ? 'plugin_enabled' : 'plugin_disabled',
      args.householdId,
      manifest.id,
      manifest.defaultEnabled ? 'enabled' : 'disabled',
      args.status
    ),
    env.DB.prepare(ENABLEMENT_UPSERT_SQL).bind(args.householdId, manifest.id, args.status),
  ])

  return buildEntry(env, manifest, { enabled: args.status === 'enabled', source: 'household' })
}

async function buildEntry(
  env: Pick<Env['Bindings'], 'DB'>,
  manifest: PluginManifest,
  enablement: { enabled: boolean; source: PluginEnablementSource }
): Promise<PluginCatalogEntry> {
  // flags.ts owns the kill-switch read and its fail-open posture.
  const deploymentAvailable = await isPluginDeploymentAvailable(env, manifest.id)
  const planEntitled = pluginPlanEntitled()
  return {
    id: manifest.id,
    name: manifest.name,
    capabilities: [...manifest.capabilities],
    default_enabled: manifest.defaultEnabled,
    enabled: enablement.enabled,
    source: enablement.source,
    deployment_available: deploymentAvailable,
    plan_entitled: planEntitled,
    available: deploymentAvailable && planEntitled && enablement.enabled,
  }
}
