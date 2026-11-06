-- Plugin lifecycle audit (ahaqqu/RumaQ#437 — plugin architecture ticket 3,
-- docs/plan/plugin-architecture.md §3.4/§6): the CORE-owned lifecycle trail —
-- plugin_enabled / plugin_disabled rows written by the settings catalog's
-- owner-only enable/disable endpoint. Ticket 5's purge job writes
-- plugin_purged here, which is why the CHECK already admits it: widening a
-- CHECK would need a table rebuild, and the event vocabulary is fixed by the
-- plan (§3.4's lifecycle table).
--
-- NUMBERING NOTE: 0031 is the merged household calendar (#430); this file
-- takes 0032, the next free number on the main chain. The open owner-gated
-- PR #452 carries migrations numbered 0031+0032 on its branch and renumbers
-- them to 0033+0034 at its merge — do not treat 0033/0034 as free either.
--
-- An audit row is a RECEIPT, not a child of the household (plan §3.4): both
-- handles are PLAIN TEXT with no FK, so deleting a household cascades its
-- household_plugins enablement rows but can never erase the record that a
-- plugin was enabled/disabled (and, at ticket 5, purged). This is the
-- deliberate opposite of document_audit / household_task_audit, whose
-- household_id IS an ON DELETE CASCADE FK — they name data that dies with
-- the household; this table names a lifecycle fact that must outlive it.
CREATE TABLE IF NOT EXISTS household_plugin_audit (
  -- Dashed UUID at runtime (lib/plugins.ts); TEXT PK NOT NULL per the 0021
  -- note — on rowid tables a TEXT PRIMARY KEY does NOT imply NOT NULL.
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  -- The household owner who toggled. Nullable + plain handle: ticket 5's
  -- purge job writes system-actor rows (no user), and no FK means a future
  -- account cleanup cannot take the receipt with it.
  actor_user_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('plugin_enabled', 'plugin_disabled', 'plugin_purged')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The lifecycle feed reads one household's events newest-first:
--   SELECT plugin_id, action, created_at FROM household_plugin_audit
--    WHERE household_id = ? ORDER BY created_at
-- The (household_id, created_at) columns match the 0022/0027 audit-feed
-- index pair, so the window seek needs no temp B-tree — the plan is pinned
-- by an EXPLAIN in migrations.test.ts. No (plugin_id, ...) index yet: no
-- query walks one plugin across households; the §3.6 enable-funnel metrics
-- are per-household aggregates. Add it with the first cross-household
-- consumer, never speculatively.
CREATE INDEX IF NOT EXISTS idx_household_plugin_audit_household
  ON household_plugin_audit(household_id, created_at);
