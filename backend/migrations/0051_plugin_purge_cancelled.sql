-- The purge `cancelled` state + receipt (ahaqqu/RumaQ#695 audit M2/L4/C1):
-- a cancelled drain stops being erased from the record. Until now the
-- owner's cancel lever NULLed purge_state and EVERY provenance column —
-- a withdrawal became indistinguishable from "never requested": the catalog
-- reported null, the requesting actor and timestamp vanished (L4), and the
-- catalog's "state line is the visible trace" claim was false (C1).
--
-- The M2 machine: `cancelled` is a TERMINAL purge state. Cancel writes the
-- receipt (requested_by/at PRESERVED, completed_at stamped, the cancel's
-- actor and cause recorded); re-initiating from `cancelled` starts a new
-- pending run (the drain's own cursor machinery is the same flow 'done'
-- already uses); the durable legal receipt rides the 0032 lifecycle trail
-- as `plugin_purge_cancelled` — the one place that outlives the household
-- (plain handles, no FK; the enablement row itself dies in the cascade).
--
-- MIGRATION MAP (the machine's own row): NO existing row can be `cancelled`
-- — the pre-change lever NULLed the state, so pre-change cancellations are
-- unrecoverable and are REPORTED AS `none` (never guessed): every legacy row
-- copies over verbatim with the new receipt columns NULL. The audit trail's
-- rows copy verbatim too — no legacy row carries the new action.
--
-- SQLite cannot ALTER a CHECK, so both tables rebuild around the widened
-- ones: household_plugins (the 0035 columns' CHECK plus the two receipt
-- columns) and household_plugin_audit (the 0032 action vocabulary — the
-- 0036 rebuild precedent). Neither table has child FKs; every row copies
-- verbatim.
--
-- NUMBERING NOTE: 0050 is applied (scrape command lease, same wave); this
-- file takes the next free number, 0051. NEVER rename an applied migration:
-- wrangler keys its d1_migrations table by filename, so a rename re-runs it.

CREATE TABLE household_plugins_new (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  -- Small non-secret per-plugin settings (§4.6): NULL is legal, a non-NULL
  -- value must be real JSON (0028's json_valid CHECK, preserved verbatim).
  config_json TEXT CHECK (config_json IS NULL OR json_valid(config_json)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- The purge state machine (0035 + this migration): NULL is the resting
  -- state (never requested); 'pending'/'running' are the drain window; 'done'
  -- marks the last completed purge; 'cancelled' marks the owner's withdrawal
  -- — a terminal state the receipt below describes.
  purge_state TEXT
    CHECK (purge_state IS NULL OR purge_state IN ('pending', 'running', 'done', 'cancelled')),
  -- The resumability cursor (0035): NULL legal, non-NULL must be real JSON.
  purge_cursor TEXT CHECK (purge_cursor IS NULL OR json_valid(purge_cursor)),
  -- Who typed the confirmation and when (0035, preserved verbatim — on a
  -- cancelled row these are the RECEIPT's requester, never erased).
  purge_requested_by TEXT,
  purge_requested_at TEXT,
  purge_completed_at TEXT,
  -- The cancel receipt (audit L4): who pulled the lever and the system cause
  -- the row carries. NULL until a cancellation lands; re-initiating a
  -- `cancelled` run clears them (a NEW run — the durable history lives in
  -- household_plugin_audit's plugin_purge_cancelled receipt below).
  purge_cancelled_by TEXT,
  purge_cancelled_reason TEXT,
  PRIMARY KEY (household_id, plugin_id)
);

INSERT INTO household_plugins_new
  (household_id, plugin_id, status, config_json, updated_at,
   purge_state, purge_cursor, purge_requested_by, purge_requested_at,
   purge_completed_at, purge_cancelled_by, purge_cancelled_reason)
SELECT household_id, plugin_id, status, config_json, updated_at,
       purge_state, purge_cursor, purge_requested_by, purge_requested_at,
       purge_completed_at, NULL, NULL
  FROM household_plugins;

DROP TABLE household_plugins;
ALTER TABLE household_plugins_new RENAME TO household_plugins;

-- The nightly chunk driver's work set: which (plugin, household) pairs have
-- a drain in flight — the 0035 partial index, rebuilt verbatim.
CREATE INDEX IF NOT EXISTS idx_household_plugins_purging
  ON household_plugins (plugin_id, household_id)
  WHERE purge_state IN ('pending', 'running');

-- The lifecycle receipt trail (0032/0036): the action vocabulary gains the
-- withdrawal. `plugin_purge_cancelled` is written ONCE, by the cancel lever,
-- with the cancelling owner as actor — the record that a REQUESTED erasure
-- was stopped, and by whom, outliving any household cascade.
CREATE TABLE household_plugin_audit_new (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  actor_user_id TEXT,
  action TEXT NOT NULL CHECK (
    action IN (
      'plugin_enabled',
      'plugin_disabled',
      'plugin_purged',
      'plugin_exported',
      'plugin_purge_cancelled'
    )
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
