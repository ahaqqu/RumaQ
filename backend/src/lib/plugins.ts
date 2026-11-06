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
import { HOUSEHOLD_CATALOG_ROWS_SQL, PLUGIN_PURGE_ROW_SQL } from '../plugins/enablement.js'
import { isPluginDeploymentAvailable } from '../plugins/flags.js'
import { requireOwner } from './households.js'

export type PluginEnablementStatus = 'enabled' | 'disabled'

/** Where a plugin's enablement state comes from (§4.3 truth table). */
export type PluginEnablementSource = 'default' | 'household'

/** The purge state machine (0035, §3.4): pending → running → done. */
export type PluginPurgeStatus = 'pending' | 'running' | 'done'

/** The catalog's purge slice — null until the household ever requested a
 * purge (the zero-cost resting state; §3.2). */
export type PluginPurgeInfo = {
  state: PluginPurgeStatus
  requested_at: string | null
  completed_at: string | null
}

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
  /** The purge state machine (ticket 5, #439) — null = never requested. */
  purge: PluginPurgeInfo | null
}

/** The pluginId path parameter named no registered manifest. */
export class PluginNotFoundError extends Error {
  constructor() {
    super('Plugin not found')
  }
}

/** The named manifest does not declare the 'purge' capability. */
export class PluginPurgeUnsupportedError extends Error {
  constructor() {
    super('Plugin does not support purge')
  }
}

/** The typed confirmation did not match the plugin's name. */
export class PluginPurgeConfirmationError extends Error {
  constructor() {
    super('Confirmation does not match the plugin name')
  }
}

/** Nothing to cancel: no purge drain is pending or running. */
export class PluginPurgeNotActiveError extends Error {
  constructor() {
    super('No purge is in flight for this plugin')
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

/** The 0035 purge columns as the catalog's purge slice. A NULL purge_state
 * is the resting state — never requested — mapped to null. */
function purgeInfoOf(row: {
  purge_state: string | null
  purge_requested_at: string | null
  purge_completed_at: string | null
}): PluginPurgeInfo | null {
  if (!row.purge_state) return null
  return {
    state: row.purge_state as PluginPurgeStatus,
    requested_at: row.purge_requested_at,
    completed_at: row.purge_completed_at,
  }
}

/**
 * The settings catalog (§4.5): every registered manifest in registry order,
 * each with its three-layer posture and its purge state (ticket 5). Any
 * member of the household may read it — enablement is deliberately not
 * hidden (§3.2); only the WRITE is owner-only.
 */
export async function getPluginCatalog(
  env: Pick<Env['Bindings'], 'DB'>,
  householdId: string
): Promise<PluginCatalogEntry[]> {
  const { results } = await env.DB.prepare(HOUSEHOLD_CATALOG_ROWS_SQL).bind(householdId).all<{
    plugin_id: string
    status: string
    purge_state: string | null
    purge_requested_at: string | null
    purge_completed_at: string | null
  }>()
  const rows = new Map(results.map((row) => [row.plugin_id, row]))

  const entries: PluginCatalogEntry[] = []
  for (const manifest of PLUGIN_MANIFESTS) {
    const row = rows.get(manifest.id)
    const status = row?.status
    const enabled = status === undefined ? manifest.defaultEnabled : status === 'enabled'
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
      source: status === undefined ? 'default' : 'household',
      deployment_available: deploymentAvailable,
      plan_entitled: planEntitled,
      available: deploymentAvailable && planEntitled && enabled,
      purge: row ? purgeInfoOf(row) : null,
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
 * The purge initiation (ticket 5, #439): mark the drain 'pending', record
 * WHO typed the confirmation (the actor the completion receipt copies onto
 * the record that outlives the household — 0035's plain handles), and clear
 * any previous run's cursor/timestamps. NO bytes, NO rows, NO receipt move
 * here — the nightly chunk driver does the deleting (§3.4: "purge is a job,
 * not a request"; plugin_purged "written once, at completion — never at the
 * start"). The state guard (P1-A1 fix round, PR #474) keeps the marking
 * safe for EVERY caller: an already pending/running drain is never
 * clobbered (its cursor, actor and progress survive) — the endpoint
 * early-returns on that case, and the dissolution drain's
 * ensurePurgePending re-invocations must not reset an in-flight cursor.
 */
export const PURGE_INITIATE_SQL = `UPDATE household_plugins
SET purge_state = 'pending', purge_cursor = NULL, purge_requested_by = ?,
    purge_requested_at = datetime('now'), purge_completed_at = NULL
WHERE household_id = ? AND plugin_id = ?
  AND (purge_state IS NULL OR purge_state = 'done')`

/**
 * The purge cancel (P1-A3, PR #474 review): back to the NULL resting state,
 * every purge column cleared — the write gate releases the moment this
 * commits. Guarded on an ACTIVE drain only: changes = 0 means nothing was
 * in flight (the caller answers the typed 409).
 */
export const PURGE_CANCEL_SQL = `UPDATE household_plugins
SET purge_state = NULL, purge_cursor = NULL, purge_requested_by = NULL,
    purge_requested_at = NULL, purge_completed_at = NULL
WHERE household_id = ? AND plugin_id = ?
  AND purge_state IN ('pending', 'running')`

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

  // The catalog read (with the 0035 purge columns) serves BOTH the
  // idempotency check and the returned posture — the toggle never touches
  // the purge columns, so its response reports their current truth.
  const { results } = await env.DB.prepare(HOUSEHOLD_CATALOG_ROWS_SQL).bind(args.householdId).all<{
    plugin_id: string
    status: string
    purge_state: string | null
    purge_requested_at: string | null
    purge_completed_at: string | null
  }>()
  const rows = new Map(results.map((row) => [row.plugin_id, row.status]))
  const current = resolveEnablement(manifest, rows)
  if ((current.enabled ? 'enabled' : 'disabled') === args.status) {
    // Already there — an event-free read of the current posture.
    const existing = results.find((row) => row.plugin_id === manifest.id)
    return buildEntry(env, manifest, current, existing ? purgeInfoOf(existing) : null)
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

  return buildEntry(
    env,
    manifest,
    { enabled: args.status === 'enabled', source: 'household' },
    // The upsert above never touches the purge columns; their pre-batch
    // truth (from the same read) is what the response reports. An absent
    // row is a never-requested purge — purgeInfoOf maps NULL to null.
    purgeInfoOf(
      results.find((row) => row.plugin_id === manifest.id) ?? {
        purge_state: null,
        purge_requested_at: null,
        purge_completed_at: null,
      }
    )
  )
}

/**
 * The purge initiation (ticket 5, #439): owner-only, typed-confirmation,
 * job-marking — nothing is deleted HERE. The request validates the typed
 * confirmation against the plugin's manifest name (the string the
 * confirmation modal tells the owner to type; the server re-checks — never
 * trust the client), then marks the enablement row 'pending'; the nightly
 * cron's chunk driver does the actual bytes-before-rows work (§3.4: "purge
 * is a job, not a request"). Idempotent while a drain is in flight: a
 * second initiation during pending/running returns the current posture
 * without re-writing (the plugin_purged receipt is written ONCE, at
 * completion — by the job, never here).
 *
 * The enablement row must EXIST for the purge columns to live on (0035), so
 * an initiation for a household that never expressed a choice (absent row,
 * manifest default) upserts the row at its RESOLVED status first — the
 * enablement choice is untouched, only materialized. Purging does not
 * require the plugin to be disabled (§3.4: disable never deletes, delete
 * never required a disable) and does not require availability: data
 * ownership outranks the ops kill-switch.
 */
export async function requestPluginPurge(
  env: Pick<Env['Bindings'], 'DB'>,
  args: { householdId: string; userId: string; pluginId: string; confirm: string }
): Promise<PluginCatalogEntry> {
  const manifest = pluginManifestById(args.pluginId)
  if (!manifest) throw new PluginNotFoundError()
  if (!manifest.capabilities.includes('purge')) throw new PluginPurgeUnsupportedError()

  await requireOwner(env.DB, args.householdId, args.userId)

  // The typed confirmation (plan §3.4: "owner-only, typed-confirmation
  // flow"): the exact manifest name. A checkbox is a misclick away; a typed
  // string is the deliberate act UU PDP erasure evidence can point to.
  if (args.confirm !== manifest.name) throw new PluginPurgeConfirmationError()

  const { results } = await env.DB.prepare(HOUSEHOLD_CATALOG_ROWS_SQL).bind(args.householdId).all<{
    plugin_id: string
    status: string
    purge_state: string | null
    purge_requested_at: string | null
    purge_completed_at: string | null
  }>()
  const existing = results.find((row) => row.plugin_id === manifest.id)

  // Idempotent while a drain is in flight — and after 'done' with no new
  // data a re-request simply re-enters 'pending' (the completion guard
  // writes no second receipt for an empty drain).
  if (existing?.purge_state === 'pending' || existing?.purge_state === 'running') {
    return buildEntry(
      env,
      manifest,
      {
        enabled:
          existing.status === undefined ? manifest.defaultEnabled : existing.status === 'enabled',
        source: existing.status === undefined ? 'default' : 'household',
      },
      purgeInfoOf(existing)
    )
  }

  await env.DB.batch([
    // Materialize the row at its RESOLVED status (absent row → the manifest
    // default) so the initiation UPDATE below has a row to land on. No
    // plugin_enabled/plugin_disabled receipt: this writes NO enablement
    // transition, only the row the purge state rides.
    env.DB.prepare(ENABLEMENT_UPSERT_SQL).bind(
      args.householdId,
      manifest.id,
      existing === undefined ? (manifest.defaultEnabled ? 'enabled' : 'disabled') : existing.status
    ),
    // Mark the drain. The next nightly tick claims it ('running') and
    // chunks through; the write gate (resolvePluginPurgeActive) starts
    // refusing uploads the moment this commits.
    env.DB.prepare(PURGE_INITIATE_SQL).bind(args.userId, args.householdId, manifest.id),
  ])

  // Read the marked row back so the response carries the REAL requested_at
  // (datetime('now') ran inside the batch) — initiation is rare; the extra
  // PK-prefix seek buys an honest payload over a guessed timestamp.
  const marked = await env.DB.prepare(PLUGIN_PURGE_ROW_SQL)
    .bind(args.householdId, manifest.id)
    .first<{
      status: string
      purge_state: string | null
      purge_requested_at: string | null
      purge_completed_at: string | null
    }>()

  return buildEntry(
    env,
    manifest,
    {
      enabled: existing === undefined ? manifest.defaultEnabled : existing.status === 'enabled',
      source: existing === undefined ? 'default' : 'household',
    },
    marked ? purgeInfoOf(marked) : { state: 'pending', requested_at: null, completed_at: null }
  )
}

/**
 * The purge CANCEL (P1-A3, PR #474 review): the owner's release lever for a
 * drain that can never complete — one poisoned `r2_key` makes every chunk
 * that reaches its document throw forever (the same guard throws in the
 * user-facing delete paths, so the owner cannot even remove the poison
 * document to unblock the drain), and the write gate would refuse that
 * household's uploads indefinitely. Owner-only, like the initiation. One
 * GUARDED update returns the row to the NULL resting state and clears every
 * purge column: changes = 0 means nothing was in flight (state NULL or
 * 'done') — a typed 409, not a silent success. NOT audited as a lifecycle
 * receipt (the 0032 vocabulary is the closed enablement/purge domain and a
 * cancel moved no bytes — the legal story "no erasure occurred" needs no
 * receipt); the catalog's state line is the visible trace.
 *
 * Mid-chunk semantics: a tick's in-flight chunk finishes its current batch
 * (bytes-before-rows held per document — deleted docs are fully gone), its
 * cursor/cursor-clear updates no-op on the state guard, and the completion
 * batch's receipt guard reads the NULL state and no-ops: a cancelled drain
 * stops with some documents purged, the rest intact with their bytes, and
 * no receipt — consistent from every angle.
 */
export async function cancelPluginPurge(
  env: Pick<Env['Bindings'], 'DB'>,
  args: { householdId: string; userId: string; pluginId: string }
): Promise<PluginCatalogEntry> {
  const manifest = pluginManifestById(args.pluginId)
  if (!manifest) throw new PluginNotFoundError()
  if (!manifest.capabilities.includes('purge')) throw new PluginPurgeUnsupportedError()

  await requireOwner(env.DB, args.householdId, args.userId)

  const result = await env.DB.prepare(PURGE_CANCEL_SQL).bind(args.householdId, manifest.id).run()
  const changes = (result as { meta?: { changes?: number } })?.meta?.changes
  if ((changes ?? 0) === 0) {
    throw new PluginPurgeNotActiveError()
  }

  // Read the released row back for the honest posture (same shape as the
  // initiation's read-back).
  const released = await env.DB.prepare(PLUGIN_PURGE_ROW_SQL)
    .bind(args.householdId, manifest.id)
    .first<{
      status: string
      purge_state: string | null
      purge_requested_at: string | null
      purge_completed_at: string | null
    }>()
  return buildEntry(
    env,
    manifest,
    {
      enabled:
        !released || released.status === undefined
          ? manifest.defaultEnabled
          : released.status === 'enabled',
      source: !released || released.status === undefined ? 'default' : 'household',
    },
    released ? purgeInfoOf(released) : null
  )
}

async function buildEntry(
  env: Pick<Env['Bindings'], 'DB'>,
  manifest: PluginManifest,
  enablement: { enabled: boolean; source: PluginEnablementSource },
  purge: PluginPurgeInfo | null
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
    purge,
  }
}
