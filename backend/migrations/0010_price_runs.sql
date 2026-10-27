-- Pipeline run reports pushed by the rumaq-scraper (haqita integration,
-- docs/plan/haqita-integration.md §7.1): one row per finished live run so the
-- admin scraping monitor can show history, per-run detail, and last-success
-- age without reading journald on the VPS. Global (non-household) table.

CREATE TABLE IF NOT EXISTS price_runs (
  id TEXT PRIMARY KEY,
  run_started_at TEXT NOT NULL UNIQUE, -- the run's scrapedAt (report replay key)
  finished_at TEXT NOT NULL,
  exit_code INTEGER NOT NULL,          -- 0 ok / 1 failure / 2 quota
  status TEXT NOT NULL,                -- 'success' | 'failed'
  stage TEXT,                          -- 'scrape' | 'match' | 'publish' | 'done' (where the run died / finished)
  per_store TEXT,                      -- JSON: {slug: {pagesFound, newImages, itemsExtracted, …, error}}
  match_stats TEXT,                    -- JSON: {exact, embedding, ai, solo, reviewItems, embeddingsDegraded}
  publish_result TEXT,                 -- JSON: {mode, accepted, skipped, error}
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_price_runs_started ON price_runs(run_started_at DESC);
