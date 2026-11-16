-- price_runs.status gets its CHECK (ahaqqu/RumaQ#695 audit L3): the column
-- had no constraint (0010), so the only thing keeping the vocabulary to the
-- contract's picklist was the ingest schema — a hand-fixed or future value
-- would silently change what the #536 dead-pipeline streak counts (anything
-- not 'success' is a dry failure), inflating the alarm. The CHECK makes an
-- unknown status unrepresentable at the schema level.
--
-- SQLite cannot ALTER a CHECK, so the table rebuilds around the new one (the
-- 0036 household_plugin_audit precedent). Every existing row copies over
-- verbatim: production rows are written ONLY by recordRunReport
-- (lib/price-runs.ts) from contract-validated run reports, whose
-- runReportSchema picklist admits exactly 'success' | 'failed' — so the
-- rebuild's INSERT..SELECT cannot fail on real data, and a violating row (a
-- hand-fixed one) fails the migration loudly, which is the point: the
-- narrowing must be enforced, not guessed.
--
-- NUMBERING NOTE: 0048 is applied (price_sources.family); this file takes the
-- next free number, 0049. NEVER rename an applied migration: wrangler keys
-- its d1_migrations table by filename, so a rename re-runs the file.
CREATE TABLE price_runs_new (
  id TEXT PRIMARY KEY,
  run_started_at TEXT NOT NULL UNIQUE, -- the run's scrapedAt (report replay key)
  finished_at TEXT NOT NULL,
  exit_code INTEGER NOT NULL,          -- 0 ok / 1 failure / 2 quota
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  stage TEXT,                          -- 'scrape' | 'match' | 'publish' | 'done' (where the run died / finished)
  per_store TEXT,                      -- JSON: {slug: {pagesFound, newImages, itemsExtracted, …, error}}
  match_stats TEXT,                    -- JSON: {exact, embedding, ai, solo, reviewItems, embeddingsDegraded}
  publish_result TEXT,                 -- JSON: {mode, accepted, skipped, error}
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- 0040: the v2 receipt's index version + bounded product summary. Null for
  -- old scrapers' reports and dry-runs — the monitor renders NULL as absent.
  index_version INTEGER,
  products_summary TEXT,
  -- 0043: the run's AI spend (JSON) and its run-level typed failures (JSON).
  ai_usage TEXT,
  failures TEXT,
  -- 0044 / pipeline #83: the verifier prompt identity (JSON), NULL on rows
  -- recorded before the field and for every producer that does not send it.
  ai_prompt_identity TEXT
);

INSERT INTO price_runs_new
  (id, run_started_at, finished_at, exit_code, status, stage, per_store, match_stats,
   publish_result, error, created_at, index_version, products_summary, ai_usage,
   failures, ai_prompt_identity)
  SELECT id, run_started_at, finished_at, exit_code, status, stage, per_store, match_stats,
         publish_result, error, created_at, index_version, products_summary, ai_usage,
         failures, ai_prompt_identity
    FROM price_runs;

DROP TABLE price_runs;
ALTER TABLE price_runs_new RENAME TO price_runs;

CREATE INDEX IF NOT EXISTS idx_price_runs_started ON price_runs(run_started_at DESC);
