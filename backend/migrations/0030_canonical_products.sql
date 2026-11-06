-- Canonical product boundary for pipeline contract v2
-- (docs/plan/pipeline-contract.md). RumaQ owns the canonical fields, status,
-- stable UUID, and aliases; the pipeline's raw observation fields stay on the
-- observation. Existing price_products rows become provisional until the
-- operator's one-time price-domain reset; no data is migrated.
--
-- NUMBERING NOTE (PR #454): open PR #452 also adds a 0030_* migration
-- (0030_user_settings_ai_vision_model.sql). Whichever PR lands second must
-- renumber to 0031_* BEFORE the file is applied anywhere: wrangler keys its
-- migration table on the filename, so renaming an applied migration re-runs
-- these ALTER TABLEs ("duplicate column name").

ALTER TABLE price_products ADD COLUMN product_type TEXT;
ALTER TABLE price_products ADD COLUMN variant TEXT;
ALTER TABLE price_products ADD COLUMN size_quantity REAL;
ALTER TABLE price_products ADD COLUMN size_unit TEXT CHECK (size_unit IN ('g', 'ml', 'pcs'));
ALTER TABLE price_products ADD COLUMN pack_count INTEGER;
ALTER TABLE price_products ADD COLUMN total_quantity REAL;
ALTER TABLE price_products ADD COLUMN packaging TEXT;
ALTER TABLE price_products ADD COLUMN quantity_min REAL;
ALTER TABLE price_products ADD COLUMN quantity_max REAL;
ALTER TABLE price_products ADD COLUMN description TEXT;
ALTER TABLE price_products ADD COLUMN category_version TEXT;
ALTER TABLE price_products ADD COLUMN status TEXT NOT NULL DEFAULT 'provisional'
  CHECK (status IN ('canonical', 'provisional', 'needs_review'));
ALTER TABLE price_products ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE price_products ADD COLUMN updated_at TEXT;

UPDATE price_products
SET updated_at = COALESCE(last_seen_at, first_seen_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

CREATE INDEX IF NOT EXISTS idx_products_status ON price_products(status);

-- Aliases are internal until an admin approves them. Candidate aliases are
-- written by ingest; only approved rows enter the canonical index. The FK
-- cascades: an alias has no meaning without its product, and D1 enforces
-- foreign keys, so a plain REFERENCES would make every product delete (the
-- operator reset, the test reset fixture, a future admin delete) fail while
-- an alias still points at the row.
CREATE TABLE IF NOT EXISTS price_product_aliases (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES price_products(id) ON DELETE CASCADE,
  store_slug TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'approved')),
  source TEXT NOT NULL DEFAULT 'ocr'
    CHECK (source IN ('ocr', 'catalog', 'admin')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (product_id, store_slug, name)
);
CREATE INDEX IF NOT EXISTS idx_aliases_product_status
  ON price_product_aliases(product_id, status);
CREATE INDEX IF NOT EXISTS idx_aliases_store_name
  ON price_product_aliases(store_slug, name);

-- Monotonic canonical-index version. One row; every product create/update
-- and approved-alias change bumps it.
CREATE TABLE IF NOT EXISTS canonical_index_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO canonical_index_state (id, version) VALUES (1, 0);

-- Raw provenance belongs to the observation, not the canonical product.
ALTER TABLE price_observations ADD COLUMN raw_name TEXT;
ALTER TABLE price_observations ADD COLUMN raw_brand TEXT;
ALTER TABLE price_observations ADD COLUMN raw_unit TEXT;
ALTER TABLE price_observations ADD COLUMN page INTEGER;
ALTER TABLE price_observations ADD COLUMN ocr_model TEXT;
