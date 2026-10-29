-- Match review queue (issue #294): one row per flagged candidate pair the
-- matcher reported on the run report (docs/294-design.md §2/§3). Global
-- (non-household) table, like price_runs. Natural key (item, entry) — a
-- re-flagged pair UPSERTS (evidence refresh + flag_count) and a decided row
-- is never auto-reopened: the upsert's DO UPDATE list simply omits the
-- decision columns. Display fields live in pair_data (the contract owns that
-- schema — the price_runs.match_stats "blob + scalar subset" precedent).

CREATE TABLE IF NOT EXISTS match_review_items (
  id TEXT PRIMARY KEY,                 -- Worker UUID at ingest
  item_product_key TEXT NOT NULL,
  entry_product_key TEXT NOT NULL,
  pair_data TEXT NOT NULL,             -- JSON: the validated contract pair, verbatim
  reason TEXT NOT NULL,                -- 'price_ratio' | 'verifier_unresolved'
  match_method TEXT NOT NULL,          -- 'exact' | 'embedding' | 'ai'
  confidence REAL NOT NULL,
  run_started_at TEXT NOT NULL,        -- join price_runs(run_started_at) for the monitor link
  first_flagged_at TEXT NOT NULL,
  last_flagged_at TEXT NOT NULL,
  flag_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_at TEXT,
  decided_by TEXT,                     -- admin user id
  -- The natural key. SQLite requires table-level constraints after ALL
  -- column definitions, so this sits at the tail.
  UNIQUE(item_product_key, entry_product_key)
);
CREATE INDEX IF NOT EXISTS idx_review_status_flagged ON match_review_items(status, last_flagged_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_flagged ON match_review_items(last_flagged_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_decided ON match_review_items(decided_at) WHERE status != 'pending';
