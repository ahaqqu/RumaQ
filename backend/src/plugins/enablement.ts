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

/** The manifest slice the resolver needs — the gate passes the full manifest,
 * tests pass the same two fields. */
export type EnablementSpec = Pick<PluginManifest, 'id' | 'defaultEnabled'>

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
