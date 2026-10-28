-- Admin-triggered scrape commands (docs/plan/scrape-now.md §3): the admin UI
-- queues a command in D1; the VPS agent claims it over the bearer-secret
-- channel, streams the run's output lines back as events, and posts a
-- terminal finish. Global (non-household) table, like price_runs. One run at
-- a time — createScrapeCommand 409s while a pending/running command exists.

CREATE TABLE IF NOT EXISTS scrape_commands (
  id TEXT PRIMARY KEY,
  stores TEXT NOT NULL,                -- JSON array of store slugs
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'success', 'failed')),
  created_by TEXT NOT NULL,            -- admin user id
  created_at TEXT NOT NULL,
  picked_up_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,                   -- 0 ok / 1 failure / 2 quota (pipeline codes)
  error TEXT,
  -- The agent's ring buffer dropped the head of the log before it could be
  -- posted: the stored event stream is a tail, not the whole run.
  log_truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_scrape_commands_created ON scrape_commands(created_at DESC);

CREATE TABLE IF NOT EXISTS scrape_run_events (
  command_id TEXT NOT NULL REFERENCES scrape_commands(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,                -- agent-assigned, monotonic per command
  ts TEXT NOT NULL,
  level TEXT NOT NULL,                 -- 'info' | 'error'
  message TEXT NOT NULL,
  PRIMARY KEY (command_id, seq)
);
