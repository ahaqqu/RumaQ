-- Admin candidate-alias decisions (ahaqqu/RumaQ#489, PR 1 of 2): the
-- append-only receipt for approving or rejecting a candidate alias, plus the
-- status-vocabulary widening that makes a rejection a real, terminal state.
--
-- The backend owns candidate aliases (0030): ingest writes them and only
-- APPROVED rows enter the canonical index, so an admin decision is what turns
-- a raw spelling into a matching key for the pipeline. Before this file the
-- schema had no way to record "an admin looked at this and said no" — status
-- only knew candidate/approved — and no receipt for who decided what.
--
-- NUMBERING NOTE: 0038 is applied (review AI); this file takes the next free
-- number, 0039. NEVER rename an applied migration — wrangler keys its
-- d1_migrations table by filename, so a rename re-runs the file.

-- ---------------------------------------------------------------------------
-- 1. Widen the alias status vocabulary: candidate -> approved | rejected.
-- ---------------------------------------------------------------------------
-- A rejection must be terminal and visible: the admin list has to show the
-- decision instead of resurfacing the same candidate forever, and the CAS on
-- the alias's own status is the only concurrency guard these endpoints have
-- (no product metadata_version race — see lib/canonical-products.ts).
--
-- SQLite cannot ALTER a CHECK, so the table rebuilds around the widened one
-- (the 0034 precedent); every existing row copies over verbatim and every
-- index is recreated. The FK to price_products is unchanged: an alias is data
-- ABOUT a product and still dies with it. The UNIQUE(product_id, store_slug,
-- name) constraint is retained, so ingest's upsert keeps refreshing
-- last_seen_at only — a rejected alias is never silently resurrected as a
-- candidate.
--
-- 'rejected' stays OUT of the canonical index by construction: getCanonicalIndex
-- selects `status = 'approved'` only (0030's rule), and the rename path
-- approves only `status = 'candidate'` rows, so a rejected spelling cannot be
-- promoted by a later rename either.
CREATE TABLE price_product_aliases_new (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES price_products(id) ON DELETE CASCADE,
  store_slug TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'approved', 'rejected')),
  source TEXT NOT NULL DEFAULT 'ocr'
    CHECK (source IN ('ocr', 'catalog', 'admin')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (product_id, store_slug, name)
);

INSERT INTO price_product_aliases_new
  (id, product_id, store_slug, name, status, source, first_seen_at, last_seen_at)
  SELECT id, product_id, store_slug, name, status, source, first_seen_at, last_seen_at
    FROM price_product_aliases;

DROP TABLE price_product_aliases;
ALTER TABLE price_product_aliases_new RENAME TO price_product_aliases;

-- Recreated verbatim from 0030 (both) and 0037 (the NOCASE expression index).
-- DROP TABLE dropped them with the old table; a missing one would silently
-- turn the detail read, the store/name lookup, or the duplicate-name guard
-- into a scan.
CREATE INDEX IF NOT EXISTS idx_aliases_product_status
  ON price_product_aliases(product_id, status);
CREATE INDEX IF NOT EXISTS idx_aliases_store_name
  ON price_product_aliases(store_slug, name);
CREATE INDEX IF NOT EXISTS idx_aliases_name_nocase
  ON price_product_aliases(name COLLATE NOCASE);

-- ---------------------------------------------------------------------------
-- 2. The decision receipt.
-- ---------------------------------------------------------------------------
-- An audit row is a RECEIPT, not a child of the alias (the 0032/0037
-- pattern): alias_id, product_id and actor_user_id are PLAIN TEXT handles
-- with no FK, so "an admin approved/rejected this spelling" survives the
-- alias row (which cascades with its product), the product row, and the
-- account that made the decision. The decision trail outlives the catalog it
-- describes. Contrast price_product_aliases itself (0030), whose ON DELETE
-- CASCADE is deliberate: an alias is data about a product; a receipt is a
-- fact about the catalog.
CREATE TABLE IF NOT EXISTS price_product_alias_audit (
  -- Dashed UUID at runtime; TEXT PK NOT NULL per the 0021 note — on rowid
  -- tables a TEXT PRIMARY KEY does NOT imply NOT NULL.
  id TEXT PRIMARY KEY NOT NULL,
  -- Plain handle, no FK: the alias may be gone and the receipt must not be.
  alias_id TEXT NOT NULL,
  -- Plain handles, no FK (0032's rationale).
  product_id TEXT NOT NULL,
  -- The slug frozen at decision time. Denormalized on purpose: it survives a
  -- product delete and keeps the receipt readable if the key is ever
  -- re-derived, so the trail never needs a join to say what was decided.
  product_key TEXT NOT NULL,
  -- The store and spelling frozen at decision time — the receipt names the
  -- exact alias candidate the admin saw, not whatever the row says later.
  store_slug TEXT NOT NULL,
  alias_name TEXT NOT NULL,
  -- Closed vocabulary: 'approve' admits the spelling to the canonical index,
  -- 'reject' keeps it out. Both are appended, never updated — there is no
  -- 'undo' (a decided alias is terminal; re-including a rejected spelling
  -- would be a new candidate, not an edit to this receipt).
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject')),
  -- Plain handle, no FK (0032's rationale): an account cleanup must not take
  -- the receipt with it.
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The product detail surface's decision history read (and the future alias
-- admin UI): one product's receipts newest-first. Matches the
-- 0022/0027/0032/0037 audit-feed index pair; pinned by an EXPLAIN in
-- migrations.test.ts.
CREATE INDEX IF NOT EXISTS idx_price_product_alias_audit_product
  ON price_product_alias_audit(product_id, created_at);
