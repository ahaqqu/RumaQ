-- Canonical product rename audit (ahaqqu/RumaQ#423): the append-only receipt
-- for admin renames of price_products.name, and the compensating 'revert'
-- rows that undo one. The canonical name is backend-owned (v2,
-- docs/plan/pipeline-contract.md): a rename is a label fix on the canonical
-- row — it never touches product_key/UUID and never needs a pipeline PR, so
-- the pipeline picks up the new name on its next run from the bumped
-- canonical_index_state. Merge/split of wrongly-merged identities is a
-- separate action (the issue's inventory finding), not this table's job.
--
-- NUMBERING NOTE: 0033 and 0034 are RESERVED for the open owner-gated PR
-- #452, which renumbers the 0031+0032 migrations on its branch to 0033+0034
-- at its merge (the 0032/0035/0036 notes). This file takes 0037, the next
-- free number after 0036, so both branches land without a renumber. NEVER
-- rename an applied migration: wrangler keys its d1_migrations table by
-- filename, so a rename re-runs the file (the 0030 warning).
--
-- An audit row is a RECEIPT, not a child of the product (the 0032 pattern):
-- product_id and actor_user_id are PLAIN TEXT handles with no FK, so the
-- record "an admin renamed this, and to what" survives the product row it
-- names and the account that made the change. 0022/0027 keep only the NAMED
-- handle (document_id/task_id) plain so the trail outlives that row — they
-- still FK the household and the actor; 0032 is the one that drops both.
-- That is the deliberate opposite of price_product_aliases (0030), whose
-- ON DELETE CASCADE FK dies with its product — an alias is data about a
-- product, a receipt is a fact about the catalog.
CREATE TABLE IF NOT EXISTS price_product_audit (
  -- Dashed UUID at runtime; TEXT PK NOT NULL per the 0021 note — on rowid
  -- tables a TEXT PRIMARY KEY does NOT imply NOT NULL.
  id TEXT PRIMARY KEY NOT NULL,
  -- Plain handle, no FK: the product may be gone and the receipt must not be.
  product_id TEXT NOT NULL,
  -- The slug frozen at mutation time. Denormalized on purpose: it survives a
  -- product delete and keeps the receipt readable if the key is ever
  -- re-derived, so the trail never needs a join to say what changed.
  product_key TEXT NOT NULL,
  -- Plain handle, no FK (0032's rationale): an account cleanup must not take
  -- the receipt with it.
  actor_user_id TEXT NOT NULL,
  -- Closed vocabulary: 'rename' is the forward edit; 'revert' is the
  -- compensating row that restores the previous name (old_name/new_name
  -- swapped). Both are appended, never updated — there is no 'delete'.
  action TEXT NOT NULL CHECK (action IN ('rename', 'revert')),
  old_name TEXT NOT NULL,
  new_name TEXT NOT NULL,
  -- Why the admin renamed — optional free text from the rename form; a
  -- rename with no stated reason is still a valid, complete receipt.
  reason TEXT,
  -- price_products.metadata_version either side of the mutation: the
  -- optimistic-concurrency guard reads it (a mismatched expectation is a
  -- 409 stale_product), so the trail records exactly which write produced
  -- which version.
  metadata_version_before INTEGER NOT NULL,
  metadata_version_after INTEGER NOT NULL,
  -- The audit row a 'revert' compensates; NULL on a 'rename'. Deliberately
  -- not a self-FK: the target is another receipt in this same append-only
  -- table, and FK enforcement there would either block pruning an old rename
  -- or cascade its revert away with it.
  reverts_audit_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The admin detail surface's history read: one product's receipts
-- newest-first (GET /api/admin/products/:productKey). Matches the
-- 0022/0027/0032 audit-feed index pair; pinned by an EXPLAIN in
-- migrations.test.ts.
--
-- created_at is datetime('now') — SECOND resolution — so same-second rows
-- tie, and this feed's tie order is whatever the plan returns. That is fine
-- for a display read; anything that must decide THE latest rename (the revert
-- route's "latest rename only" rule) orders by metadata_version_after
-- instead, which is strictly increasing per product because every audited
-- write bumps it. Nothing here forbids two 'revert' rows naming one rename:
-- the route's expectedMetadataVersion CAS owns that rule.
CREATE INDEX IF NOT EXISTS idx_price_product_audit_product
  ON price_product_audit(product_id, created_at);

-- Duplicate-name detection for the rename guard (409 duplicate_name): before
-- writing, the rename route asks whether a product or an approved alias
-- already carries the candidate name case-insensitively.
--
-- Collation is part of an index, so SQLite uses these ONLY for a NOCASE
-- comparison: bind the lookup as `WHERE name = ? COLLATE NOCASE`. The plain
-- `name = ?` form compares BINARY and scans — pinned by an EXPLAIN in
-- migrations.test.ts so the guard cannot silently lose its seek. An
-- expression index on COLLATE NOCASE rather than a second stored column:
-- the canonical name stays in `name`, the index just normalizes the lookup.
CREATE INDEX IF NOT EXISTS idx_products_name_nocase
  ON price_products(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_aliases_name_nocase
  ON price_product_aliases(name COLLATE NOCASE);
