-- Plugin purge job state (ahaqqu/RumaQ#439 — plugin architecture ticket 5,
-- docs/plan/plugin-architecture.md §3.4/§3.5 phase C): per-plugin purge
-- state machine + resumability cursor ON the enablement row, exactly where
-- the plan puts it — "a purge_state (pending → running → done) plus a cursor
-- lives on the enablement row; the existing daily cron drives chunks of
-- documents". One row per (household, plugin) already exists for enablement,
-- so the purge state rides it: a purge is never a second source of truth
-- about which plugins a household has.
--
-- NUMBERING NOTE: 0033 and 0034 are RESERVED — the open owner-gated PR #452
-- carries migrations numbered 0031+0032 on its branch and renumbers them to
-- 0033+0034 at its merge (same situation as 0028's note, one number later).
-- This file takes 0035 so both branches land without a renumber.
--
-- THE GRACE DECISION (plan §8 open question 4 / §9.1): purge runs IMMEDIATE —
-- no grace timer, no held 'pending' window. DokumenQ's amendment 1 (§9.1.9)
-- set the RumaQ vault app's gc_grace_days to 0 precisely because #388
-- promises hard delete removes object AND metadata; its 30-day GC grace is
-- the default for generic apps, not for this one. Aligning the two products
-- (the §8 question's own criterion) therefore means aligning on "the vault
-- purges immediately" — a 30-day soft window here would make RumaQ hold
-- bytes the DokumenQ adapter contract says are gone. The state machine keeps
-- the door cheap to reopen: 'pending' already exists, so a future grace is
-- one nullable timestamp column + one cron predicate (plan §8: "the state
-- machine already has a pending state a grace timer can hold") — additive,
-- no rebuild, no vocabulary change.

-- The purge state machine. NULL is the resting state (never requested —
-- zero-cost §3.2 for households that never purge); 'pending'/'running' are
-- the drain window (the nightly chunk driver's work set); 'done' marks the
-- last completed purge and lets the catalog report it without a second
-- table. Re-purging later re-enters 'pending' (new data since 'done' is
-- the household's new data, and the same flow covers it).
ALTER TABLE household_plugins ADD COLUMN purge_state TEXT
  CHECK (purge_state IS NULL OR purge_state IN ('pending', 'running', 'done'));

-- The resumability cursor: the ordering key (created_at, id) of the LAST
-- document the drain processed, as JSON — the keyset predicate
-- (created_at, id) > (cursor) makes every invocation resume exactly where
-- the last one stopped (plan §3.4: "a crash or a timeout resumes from the
-- cursor"). NULL = not started / completed (cleared at 'done'). json_valid
-- guards the same way config_json does: NULL is legal, a non-NULL value
-- must be real JSON — a hand-edited or corrupted cursor degrades to a
-- re-read (idempotent), never to a failed drain.
ALTER TABLE household_plugins ADD COLUMN purge_cursor TEXT
  CHECK (purge_cursor IS NULL OR json_valid(purge_cursor));

-- Who typed the confirmation (owner-only initiation) and when. Plain TEXT
-- handles, deliberately NO FK: the enablement row dies with the household
-- cascade (0028), and the durable legal record is the plugin_purged receipt
-- in household_plugin_audit (0032) — the job copies the initiator INTO that
-- receipt's actor_user_id at completion, which is the only place it
-- outlives the household (UU PDP 27/2022 erasure evidence). The timestamps
-- use the same TEXT datetime('now') convention as every sibling column.
ALTER TABLE household_plugins ADD COLUMN purge_requested_by TEXT;
ALTER TABLE household_plugins ADD COLUMN purge_requested_at TEXT;
ALTER TABLE household_plugins ADD COLUMN purge_completed_at TEXT;

-- The nightly chunk driver's work set: which (plugin, household) pairs have
-- a drain in flight. It is a PARTIAL index — it holds rows ONLY while a
-- purge is pending/running, i.e. ~always empty, so enablement writes (the
-- hot path) never maintain a growing structure and the nightly seek is an
-- index seek, not a scan of the enablement table. The query it serves:
--   SELECT household_id FROM household_plugins
--    WHERE plugin_id = ? AND purge_state IN ('pending','running')
-- pinned by an EXPLAIN in migrations.test.ts (the 0022/0032 index-plan
-- discipline). A partial predicate the query literally contains lets
-- SQLite prove applicability; a plain full index would be write overhead
-- for a cold path.
CREATE INDEX IF NOT EXISTS idx_household_plugins_purging
  ON household_plugins (plugin_id, household_id)
  WHERE purge_state IN ('pending', 'running');
