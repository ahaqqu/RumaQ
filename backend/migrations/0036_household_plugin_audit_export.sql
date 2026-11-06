-- Plugin lifecycle audit: the export event (ahaqqu/RumaQ#440 — plugin
-- architecture ticket 6, docs/plan/plugin-architecture.md §3.4's lifecycle
-- table "export event recorded"). The per-plugin archive export is the
-- data-ownership capability that ships alongside the purge (§3.4: the UI
-- routes delete through export-first), and its receipt rides the same CORE
-- lifecycle trail — the table whose rows outlive the household (plain
-- handles, no FK), exactly where plugin_enabled / plugin_disabled /
-- plugin_purged already live.
--
-- SQLite cannot ALTER a CHECK, so the table rebuilds around the widened one
-- (the 0025 document_audit precedent); every existing row copies over
-- verbatim and the plain-handle shape (the whole point of 0032 — the
-- receipt is not a child of the household) is preserved untouched.
--
-- NUMBERING NOTE: 0033 and 0034 remain RESERVED for the open owner-gated
-- PR #452 (the 0035 note); this file takes 0036, the next free number.
CREATE TABLE household_plugin_audit_new (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  actor_user_id TEXT,
  -- 'plugin_exported' joins the vocabulary: one receipt per archive — a
  -- large vault exports as several sequential archives (the subrequest
  -- budget caps one response), so the trail shows the true access shape.
  action TEXT NOT NULL CHECK (
    action IN ('plugin_enabled', 'plugin_disabled', 'plugin_purged', 'plugin_exported')
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO household_plugin_audit_new
  (id, household_id, plugin_id, actor_user_id, action, created_at)
  SELECT id, household_id, plugin_id, actor_user_id, action, created_at
    FROM household_plugin_audit;

DROP TABLE household_plugin_audit;
ALTER TABLE household_plugin_audit_new RENAME TO household_plugin_audit;

CREATE INDEX IF NOT EXISTS idx_household_plugin_audit_household
  ON household_plugin_audit(household_id, created_at);
