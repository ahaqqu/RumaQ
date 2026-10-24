-- Global (non-household) price data pushed by the rumaq-scraper pipeline
-- (haqita integration, docs/plan/haqita-integration.md §5.1).

CREATE TABLE IF NOT EXISTS price_sources (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,          -- 'lotte-mart', 'superindo', 'alfamart', ...
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'supermarket',
  region TEXT NOT NULL DEFAULT 'jakarta',
  website TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS price_products (
  id TEXT PRIMARY KEY,
  product_key TEXT UNIQUE NOT NULL,   -- slug '{name}--{brand}--{unit}' (haqita convention)
  name TEXT NOT NULL,
  brand TEXT,
  unit TEXT,
  category TEXT,
  first_seen_at TEXT,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS price_observations (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES price_products(id),
  source_id TEXT NOT NULL REFERENCES price_sources(id),
  observed_date TEXT NOT NULL,        -- YYYY-MM-DD
  price INTEGER NOT NULL,             -- IDR
  effective_unit_price REAL,
  promo_type TEXT,                    -- bundle_buy|get_free|discount_pct|...
  promo_label TEXT,
  valid_from TEXT,
  valid_until TEXT,
  match_method TEXT,                  -- exact|embedding|ai|solo
  match_confidence REAL NOT NULL,
  brochure_url TEXT,                  -- deep-link to store's original brochure page
  scraped_at TEXT NOT NULL,
  UNIQUE (product_id, source_id, observed_date)
);
CREATE INDEX IF NOT EXISTS idx_obs_product ON price_observations(product_id);
CREATE INDEX IF NOT EXISTS idx_obs_valid ON price_observations(valid_until);

-- Grounded price estimates on plan items reference the observation they came from.
ALTER TABLE plan_items ADD COLUMN price_observation_id TEXT REFERENCES price_observations(id);
