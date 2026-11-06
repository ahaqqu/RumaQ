// Enablement resolution (ahaqqu/RumaQ#435 — plugin architecture phase A,
// docs/plan/plugin-architecture.md §4.3). Enablement is RESOLVED, never a
// bare boolean: the optional household_plugins row against the manifest
// default. This module is the ONLY reader of household_plugins (§4.1
// forbidden-3) — a plugin reads its own enablement through the gate, never
// through SQL.
import type { PluginManifest } from './types.js'

/** The per-request gate read: one indexed PK-prefix seek on
 * (household_id, plugin_id) — 0028's composite primary key serves it, and
 * migrations.test.ts pins the plan. Deliberately NOT joined with the auth
 * statement: the two reads must keep separate failure semantics (§4.4) even
 * at the cost of one extra indexed read per plugin request (§3.6). */
export const PLUGIN_ENABLEMENT_SQL =
  'SELECT status FROM household_plugins WHERE household_id = ? AND plugin_id = ?'

/** The bootstrap advertisement read: every enablement row for one household
 * in a single statement (resolveEnabledPluginIds applies the manifest
 * defaults on top of it). */
export const HOUSEHOLD_ENABLEMENT_ROWS_SQL =
  'SELECT plugin_id, status FROM household_plugins WHERE household_id = ?'

/** The settings catalog's read (ticket 5, #439): the enablement rows WITH
 * the purge columns (0035) — the catalog reports the purge state machine
 * honestly (§4.5) without a second table read. A different statement from
 * HOUSEHOLD_ENABLEMENT_ROWS_SQL on purpose: the advertisement stays exactly
 * as pinned (its consumers read two columns), and each read's shape is
 * pinned by its own test. */
export const HOUSEHOLD_CATALOG_ROWS_SQL =
  'SELECT plugin_id, status, purge_state, purge_requested_at, purge_completed_at FROM household_plugins WHERE household_id = ?'

/** The vault write-gate's read (ticket 5, #439): is a purge draining for
 * this (household, plugin)? A PK-prefix seek like PLUGIN_ENABLEMENT_SQL;
 * pinned in migrations.test.ts. */
export const PLUGIN_PURGE_STATE_SQL =
  'SELECT purge_state FROM household_plugins WHERE household_id = ? AND plugin_id = ?'

/** The single-row read the purge initiation answers with (ticket 5): the
 * enablement status AND the full purge slice for one (household, plugin) —
 * the PK-prefix seek, pinned in migrations.test.ts. */
export const PLUGIN_PURGE_ROW_SQL =
  'SELECT status, purge_state, purge_requested_at, purge_completed_at FROM household_plugins WHERE household_id = ? AND plugin_id = ?'

/** The manifest slice the resolver needs — the gate passes the full manifest,
 * tests pass the same two fields. */
export type EnablementSpec = Pick<PluginManifest, 'id' | 'defaultEnabled'>

// --- The cron driver's enabled set (ticket 7, #441) -------------------------
// A household-scoped cron task iterates the ENABLED set of its plugin across
// ALL households (§4.3: "a household-scoped task iterates the enabled set
// from one query") — the per-request reads above are PK-prefix seeks by
// household, which cannot list a plugin's enabled set, so the driver gets
// its own statement per defaultEnabled branch. Both resolve by the same §4.3
// truth table the gate applies; a read error fails CLOSED for the plugin's
// task (skipped for the night, logged) and stays open for core — the
// resolver's own posture, one section up.

/** defaultEnabled = true: every household EXCEPT those that explicitly
 * disabled the plugin. The NOT EXISTS rides the composite PK's (household_id,
 * plugin_id) prefix for the probe; the outer scan of households is bounded by
 * design (household-scale table, nightly cadence — the #426 expiry sweep's
 * own scan rationale). EXPLAIN-pinned in migrations.test.ts. Both statements
 * answer the SAME column shape (household_id) so the driver's reader is
 * statement-agnostic. */
export const HOUSEHOLDS_ENABLED_BY_DEFAULT_SQL = `SELECT id AS household_id FROM households
 WHERE NOT EXISTS (
   SELECT 1 FROM household_plugins
    WHERE household_plugins.household_id = households.id
      AND household_plugins.plugin_id = ?
      AND household_plugins.status = 'disabled'
 )`

/** defaultEnabled = false: only households that explicitly enabled the
 * plugin — no defaults to apply, so the enablement rows alone answer. The
 * plugin_id filter cannot ride the (household_id, plugin_id) PK (second
 * column) and gets no dedicated index: the 0035 header's own tradeoff — a
 * full index on a cold nightly read is write overhead on the enablement hot
 * path — and the row count is bounded by the expressed household choices
 * (§3.2: zero rows for households that never toggled anything). */
export const HOUSEHOLDS_ENABLED_EXPLICIT_SQL =
  "SELECT household_id FROM household_plugins WHERE plugin_id = ? AND status = 'enabled'"

/**
 * The enabled set for the cron driver (ticket 7, #441): every household the
 * plugin's household-scoped task serves, resolved by the same truth table as
 * resolvePluginEnabled (absent row → manifest default; explicit row wins).
 * Returns null on a read error — the resolver convention (the function above)
 * — and the DRIVER turns that into the fail-closed posture (the task skips
 * this tick, logged); this module never decides that, it only reports.
 */
export async function resolveEnabledHouseholdIds(
  db: D1Database,
  spec: EnablementSpec
): Promise<string[] | null> {
  try {
    const statement = spec.defaultEnabled
      ? HOUSEHOLDS_ENABLED_BY_DEFAULT_SQL
      : HOUSEHOLDS_ENABLED_EXPLICIT_SQL
    const { results } = await db.prepare(statement).bind(spec.id).all<{ household_id: string }>()
    return results.map((row) => row.household_id)
  } catch (err) {
    console.error(`[plugins] enabled-set read failed for ${spec.id}; the caller fails closed`, err)
    return null
  }
}

/**
 * §4.3 truth table — explicit rows always win; an absent row falls back to
 * the manifest default; a read error FAILS CLOSED (denies the plugin).
 *
 * | household_plugins row | manifest.defaultEnabled | effective        |
 * | --------------------- | ----------------------- | ---------------- |
 * | absent                | true                    | enabled          |
 * | absent                | false                   | disabled         |
 * | status = 'enabled'    | any                     | enabled          |
 * | status = 'disabled'   | any                     | disabled         |
 * | read error            | —                       | disabled, logged |
 *
 * The fail-closed posture is a privacy promise (§3.3, §4.4): when the
 * database cannot answer, the household has not demonstrably enabled the
 * feature, so it answers 404. The deployment flag (flags.ts) is the
 * deliberate opposite — fail OPEN — and the two must never be unified.
 */
export async function resolvePluginEnabled(
  db: D1Database,
  householdId: string,
  spec: EnablementSpec
): Promise<boolean> {
  try {
    const row = await db
      .prepare(PLUGIN_ENABLEMENT_SQL)
      .bind(householdId, spec.id)
      .first<{ status: string }>()
    if (!row) return spec.defaultEnabled
    return row.status === 'enabled'
  } catch (err) {
    console.error(`[plugins] enablement read failed for ${spec.id}; failing closed`, err)
    return false
  }
}

/**
 * The vault write-gate (ticket 5, #439): true while a purge is pending or
 * running for this plugin — the window in which new uploads are REFUSED
 * (409). Why refuse rather than let the drain catch up: a document uploaded
 * between the drain's final empty read and the 'done' transition would be
 * erased with the household's purged data — exactly the class of silent
 * loss this ticket exists to prevent. Fail-CLOSED on a read error: a
 * refused upload is a retried request; an upload that lands inside an
 * unverified drain window is data loss. (The enablement gate above fails
 * closed to DENY ACCESS; this one fails closed to DENY WRITES — same
 * posture, opposite direction, and neither may be unified with the
 * fail-open advertisement.)
 */
export async function resolvePluginPurgeActive(
  db: D1Database,
  householdId: string,
  pluginId: string
): Promise<boolean> {
  try {
    const row = await db
      .prepare(PLUGIN_PURGE_STATE_SQL)
      .bind(householdId, pluginId)
      .first<{ purge_state: string | null }>()
    return row?.purge_state === 'pending' || row?.purge_state === 'running'
  } catch (err) {
    console.error(`[plugins] purge-state read failed for ${pluginId}; blocking writes`, err)
    return true
  }
}

/**
 * The bootstrap advertisement (§4.5): the enabled plugin-id set for the
 * ACTIVE household, in registry order — ids only, no manifests, no React.
 * Returns null on a read error; the caller then OMITS the additive
 * enabledPlugins field, which clients read as "all catalog plugins enabled"
 * (§4.5). That asymmetry is deliberate: enforcement (the gate) fails closed
 * while advertisement fails open — the client can never gain access it
 * lacks, and a stale client is never shown an empty super app.
 */
export async function resolveEnabledPluginIds(
  db: D1Database,
  householdId: string,
  manifests: readonly EnablementSpec[]
): Promise<string[] | null> {
  try {
    const { results } = await db
      .prepare(HOUSEHOLD_ENABLEMENT_ROWS_SQL)
      .bind(householdId)
      .all<{ plugin_id: string; status: string }>()
    const statusById = new Map(results.map((row) => [row.plugin_id, row.status]))
    return manifests
      .filter((manifest) => {
        const status = statusById.get(manifest.id)
        return status === undefined ? manifest.defaultEnabled : status === 'enabled'
      })
      .map((manifest) => manifest.id)
  } catch (err) {
    console.error('[plugins] enablement listing failed; omitting enabledPlugins', err)
    return null
  }
}
