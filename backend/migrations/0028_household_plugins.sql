-- Plugin enablement rows (ahaqqu/RumaQ#435 — plugin architecture phase A,
-- docs/plan/plugin-architecture.md §4.3/§6): one row per (household, plugin)
-- recording the household's EXPLICIT choice. An ABSENT row resolves to the
-- plugin manifest's defaultEnabled (the documents plugin ships
-- defaultEnabled: true), so there is deliberately NO grandfathering backfill:
-- every existing household resolves enabled with zero rows, and flipping a
-- manifest default later touches only households that never expressed a
-- choice. Explicit rows always win over the default (§4.3 truth table).
--
-- NUMBERING NOTE: 0027 is RESERVED for the in-flight #429 task-assignments
-- branch; this file takes 0028 so both branches land without a renumber.
--
-- No writer exists yet in phase A (the owner-only enable/disable UI is
-- ticket 3) — the enablement resolver (backend/src/plugins/enablement.ts) is
-- the plugin gate's only reader, and it FAILS CLOSED on a read error (a
-- privacy posture; the deployment_flags table below is the deliberate
-- opposite — fail open — and the two must never be unified).
CREATE TABLE IF NOT EXISTS household_plugins (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  -- Small non-secret per-plugin settings (§4.6) — unused in phase A, shipped
  -- now so the settings catalog (ticket 3) does not need a schema change.
  -- CHECKed the same way `status` is: NULL is legal (no settings yet), a
  -- non-NULL value must be real JSON (json_valid, SQLite-native).
  config_json TEXT CHECK (config_json IS NULL OR json_valid(config_json)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- The composite PRIMARY KEY IS both the uniqueness constraint (one row per
  -- household + plugin, plan §6) and the household_id-prefix index every read
  -- seeks: the per-request gate read
  --   SELECT status FROM household_plugins WHERE household_id = ? AND plugin_id = ?
  -- and the bootstrap advertisement listing
  --   SELECT plugin_id, status FROM household_plugins WHERE household_id = ?
  -- are both PK-prefix seeks (EXPLAIN-pinned in migrations.test.ts). Plan §6
  -- words this as "an index on (household_id) and a uniqueness constraint on
  -- (household_id, plugin_id)" — one composite constraint delivers both, so
  -- no separate index is created on top of it.
  PRIMARY KEY (household_id, plugin_id)
);
