-- The scrape command lease (ahaqqu/RumaQ#695 audit M1/L1): `heartbeat_at`
-- joins the row, `reaped` joins the status vocabulary, and the old
-- age-since-claim reap becomes a SILENCE reap.
--
-- WHY: the 150-min running ceiling encoded the pipeline's configurable
-- `RUN_DEADLINE_MS` (90 min default) + slack — a constant from another repo
-- (audit C3). Raising that env var past the ceiling made RumaQ reap a LIVE
-- run as stale and drop its eventual finish report while api.ts still
-- answered 200. The lease fixes the semantics: the claim stamps
-- `heartbeat_at`, every events POST renews it, and the reaper fires on
-- SILENCE (`coalesce(heartbeat_at, picked_up_at)` older than 45 min) instead
-- of age since claim — a run that reports is never reaped, whatever its
-- total age. The pending reap (60 min from created_at, "never picked up")
-- is unchanged.
--
-- `reaped` names the terminal cause instead of overloading `failed` (which
-- covered three causes) and overloading `exit_code = 1` (a reaped row has NO
-- exit code — the run never finished). Legacy rows: the reaper's error
-- strings always begin `reaped:`, so `error LIKE 'reaped:%'` identifies every
-- row the old age-based reaper flipped to `failed`; they map to
-- `status = 'reaped'`. Any other row keeps its status verbatim — the 0012
-- CHECK guaranteed one of pending/running/success/failed, all still valid.
--
-- The mapped rows keep EVERY column verbatim, `exit_code = 1` included: the
-- old reaper stamped it, and a migration does not rewrite history. So a
-- LEGACY reaped row may carry exit_code 1 (the admin history prints it) —
-- the "reaped rows have no exit code" invariant holds for NEW reaps only,
-- which always leave the column alone. The error string survives the same
-- way (`reaped: no finish report after 150 min ...`) and is what the admin
-- history shows as the cause.
--
-- SQLite cannot ALTER a CHECK, so the table rebuilds around the widened one
-- (the 0049 price_runs precedent). scrape_run_events REFERENCES
-- scrape_commands(id) ON DELETE CASCADE, so dropping the parent would
-- cascade-delete the run logs (with foreign_keys enforced, DROP performs an
-- implicit DELETE) — the events are mirrored FIRST (0025's
-- documents_legacy_files pattern), the parent rebuilds, then the events
-- return byte-identical.
--
-- NUMBERING NOTE: 0049 is applied (price_runs status CHECK, #708); this file
-- takes the next free number, 0050. NEVER rename an applied migration:
-- wrangler keys its d1_migrations table by filename, so a rename re-runs it.

-- The run logs' mirror: the exact columns 0012 declared, copied verbatim.
CREATE TABLE scrape_run_events_mirror (
  command_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (command_id, seq)
);

INSERT INTO scrape_run_events_mirror (command_id, seq, ts, level, message)
  SELECT command_id, seq, ts, level, message FROM scrape_run_events;

CREATE TABLE scrape_commands_new (
  id TEXT PRIMARY KEY,
  stores TEXT NOT NULL,                -- JSON array of store slugs
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'success', 'failed', 'reaped')),
  created_by TEXT NOT NULL,            -- admin user id
  created_at TEXT NOT NULL,
  picked_up_at TEXT,
  -- The lease heartbeat: stamped by the claim, renewed by every events POST.
  -- The reaper reads coalesce(heartbeat_at, picked_up_at) — rows claimed
  -- before this column existed silence-measure from their pickup.
  heartbeat_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,                   -- 0 ok / 1 failure / 2 quota (pipeline codes); NULL on reap — the run never finished
  error TEXT,
  -- The agent's ring buffer dropped the head of the log before it could be
  -- posted: the stored event stream is a tail, not the whole run.
  log_truncated INTEGER NOT NULL DEFAULT 0
);

INSERT INTO scrape_commands_new
  (id, stores, status, created_by, created_at, picked_up_at, heartbeat_at,
   finished_at, exit_code, error, log_truncated)
SELECT
  id, stores,
  CASE WHEN error LIKE 'reaped:%' THEN 'reaped' ELSE status END,
  created_by, created_at, picked_up_at, NULL, finished_at, exit_code, error,
  log_truncated
  FROM scrape_commands;

DROP TABLE scrape_commands;
ALTER TABLE scrape_commands_new RENAME TO scrape_commands;

CREATE INDEX IF NOT EXISTS idx_scrape_commands_created ON scrape_commands(created_at DESC);

-- The events return (the mirror is byte-identical; the parent rebuild never
-- touched a key). The mirror's leftovers are deleted with the mirror itself.
INSERT INTO scrape_run_events (command_id, seq, ts, level, message)
  SELECT command_id, seq, ts, level, message FROM scrape_run_events_mirror;

DROP TABLE scrape_run_events_mirror;
