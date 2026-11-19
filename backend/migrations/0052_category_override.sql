-- Human category override (ahaqqu/RumaQ#728): the provenance column and the
-- append-only receipt for an admin setting price_products.category from the
-- taxonomy review surface.
--
-- The "nightly republish overwrites the category" fear is FALSE for the v2
-- contract: ingest fills `category` on existing rows only
-- `WHERE product_key = ? AND category IS NULL` (ingest-v2.ts, the
-- taxonomy-backfill keeps the same discipline), so a human write to the
-- column SURVIVES the nightly publish by construction. The override therefore
-- writes the canonical column directly — no shadow store, no read-path
-- precedence — and this migration carries the two things the write must add:
-- the provenance stamp and the receipt.
--
-- NUMBERING NOTE: this file takes 0052, the next free number after 0051.
-- NEVER rename an applied migration: wrangler keys its d1_migrations table by
-- filename, so a rename re-runs the file (the 0030 warning).

-- ---------------------------------------------------------------------------
-- 1. Provenance on the canonical row.
-- ---------------------------------------------------------------------------
-- NULL = pipeline-assigned (every existing row; the ingest, the backfill and
-- the revert-to-pipeline state never set it — the ingest upsert's column list
-- never mentions this column, so the nightly stays null-fill-only). The only
-- writer of 'human' is the category override / its revert's recompute. The
-- one consumer this issue needs it for is the review card's provenance chip;
-- the canonical index does NOT carry it (no contract change — the pipeline
-- never re-proposes over a non-null category anyway).
--
-- ALTER TABLE ADD COLUMN with a CHECK is valid SQLite (a CHECK on an added
-- column is allowed; only a non-constant DEFAULT or a NOT NULL without one is
-- not). The closed vocabulary is case-sensitive, like every 0001/0027-style
-- CHECK.
ALTER TABLE price_products ADD COLUMN category_source TEXT
  CHECK (category_source IN ('pipeline', 'human'));

-- ---------------------------------------------------------------------------
-- 2. The receipt.
-- ---------------------------------------------------------------------------
-- An audit row is a RECEIPT, not a child of the product (the 0032/0037/0039
-- pattern): product_id and actor_user_id are PLAIN TEXT handles with no FK,
-- so "an admin set this category, and from what" survives the product row it
-- names and the account that made the change. `product_key` is denormalized
-- for readability across a re-key (#21): product keys derive from raw names
-- and a re-derived key must never orphan the fact — the override binds to the
-- ROW (price_products.id, the UUID), and the receipt carries the key frozen
-- at mutation time.
CREATE TABLE IF NOT EXISTS price_product_category_audit (
  -- Dashed UUID at runtime; TEXT PK NOT NULL per the 0021 note — on rowid
  -- tables a TEXT PRIMARY KEY does NOT imply NOT NULL.
  id TEXT PRIMARY KEY NOT NULL,
  -- Plain handle, no FK: the product may be gone and the receipt must not be.
  product_id TEXT NOT NULL,
  -- The slug frozen at mutation time. Denormalized on purpose (0037's
  -- rationale): it survives a product delete and a #21 re-key, so the trail
  -- never needs a join to say which catalog row was fixed.
  product_key TEXT NOT NULL,
  -- Plain handle, no FK (0032's rationale): an account cleanup must not take
  -- the receipt with it.
  actor_user_id TEXT NOT NULL,
  -- Closed vocabulary: 'set' is the forward override; 'revert' is the
  -- compensating row that restores the previous category (old/new swapped).
  -- Both are appended, never updated — there is no 'delete'.
  action TEXT NOT NULL CHECK (action IN ('set', 'revert')),
  -- The category either side of the mutation. old_category is NULL when the
  -- row had none (an override onto an uncategorized product is a first-class
  -- path). new_category is nullable ONLY for the compensating row: a 'revert'
  -- swaps old/new with the 'set' it compensates, so reverting a set whose
  -- from-value was NULL must write a NULL new_category (the row goes back to
  -- "no category" — the next publish's WHERE category IS NULL fill then
  -- re-proposes, by design). The CHECK pins the invariant at the storage
  -- level: only a 'revert' may leave it empty; a 'set' must name a slug.
  old_category TEXT,
  old_category_version TEXT,
  new_category TEXT CHECK (action = 'revert' OR new_category IS NOT NULL),
  new_category_version TEXT,
  -- Why the admin set it — optional free text from the override form; an
  -- override with no stated reason is still a valid, complete receipt.
  reason TEXT,
  -- The taxonomy flag this override settled; NULL on a product-surface edit.
  -- Plain handle, no FK: the flag row can be pruned/undone and the receipt
  -- stays the audit fact. When both facts happened together, this link is
  -- what lets a reader join "the admin set X" to "the flag it settled".
  review_item_id TEXT,
  -- price_products.metadata_version either side of the mutation: the
  -- linear-history rule reads it (a revert is offered only when the latest
  -- 'set' produced the CURRENT version), so the trail records exactly which
  -- write produced which version — the 0037 column pair.
  metadata_version_before INTEGER NOT NULL,
  metadata_version_after INTEGER NOT NULL,
  -- The audit row a 'revert' compensates; NULL on a 'set'. Deliberately not
  -- a self-FK (0037's rationale): the target is another receipt in this same
  -- append-only table.
  reverts_audit_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The product detail surface's history read (GET /api/admin/products/
-- :productKey carries the newest receipts) and the override panel's revert
-- derivation. Matches the 0022/0027/0032/0037/0039 audit-feed index pair;
-- pinned by an EXPLAIN in migrations.test.ts.
CREATE INDEX IF NOT EXISTS idx_ppcat_audit_product
  ON price_product_category_audit(product_id, created_at);

-- One compensation per set, structurally (the 0037 revert-once backstop):
-- partial, so the NULL reverts_audit_id of every 'set' never collides — two
-- rows only conflict when they compensate the SAME set. The revert route's
-- expectedMetadataVersion CAS stays the primary guard (it 409s a stale second
-- request before the write); this index is the storage-level backstop for any
-- writer that forgets it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ppcat_audit_revert_once
  ON price_product_category_audit(reverts_audit_id) WHERE reverts_audit_id IS NOT NULL;
