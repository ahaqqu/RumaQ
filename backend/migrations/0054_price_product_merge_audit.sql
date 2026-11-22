-- Observation registry merge receipts (ahaqqu/RumaQ#744, owner decision OQ8
-- 2026-11-22: option 1 — re-point price observations at merge-approval time).
-- When a match-review pair is approved, the entry-side product identity is
-- ABSORBED into the item-side survivor: its observations re-point
-- (product_id only), its alias spellings move with status preserved, its
-- price_products row is DELETEd (owner decision: no 'superseded' status — the
-- 3-value contract picklist and every price read path stay untouched), and
-- this table appends the receipt.
--
-- An audit row is a RECEIPT, not a child of either product (the 0032/0037/
-- 0039 pattern): every handle is PLAIN TEXT with no FK, so the record "this
-- merge decision absorbed that identity into this survivor" survives the
-- absorbed row it deleted, both product rows, and the acting account. The
-- absorbed key survives ONLY here (and in match_review_items.pair_data);
-- to_product_key is the union-find edge the chain resolution walks when a
-- later merge names an already-absorbed key.
--
-- NUMBERING NOTE: 0052/0053 are applied; this file takes the next free
-- number, 0054. NEVER rename an applied migration — wrangler keys its
-- d1_migrations table by filename, so a rename re-runs the file (the 0030
-- warning).
CREATE TABLE IF NOT EXISTS price_product_merge_audit (
  -- Dashed UUID at runtime; TEXT PK NOT NULL per the 0021 note — on rowid
  -- tables a TEXT PRIMARY KEY does NOT imply NOT NULL.
  id TEXT PRIMARY KEY NOT NULL,
  -- The review decision that caused the merge. Plain handle, no FK (0037's
  -- rationale): the receipt outlives everything it names. One decision can
  -- produce more than one receipt over time (a zombie re-create absorbed by a
  -- re-approval), so this is deliberately not UNIQUE.
  review_item_id TEXT NOT NULL,
  -- The absorbed identity, frozen at delete time. After the merge the row is
  -- gone and these columns are the only catalog-level record of it (0037's
  -- denormalization rule: the trail never needs a join to say what changed).
  from_product_id TEXT NOT NULL,
  from_product_key TEXT NOT NULL,
  from_product_name TEXT,
  -- The surviving identity at receipt time.
  to_product_id TEXT NOT NULL,
  to_product_key TEXT NOT NULL,
  -- Who the decision was attributed to: the acting admin, or the auto sweep's
  -- stored review_ai_user_id (the usage-attribution precedent); 'ai' when no
  -- admin is attributable. Plain handle, no FK (0032's rationale).
  actor_user_id TEXT NOT NULL,
  -- Who produced the decision, same vocabulary as
  -- match_review_items.decided_source (0013/0038).
  decided_source TEXT NOT NULL CHECK (decided_source IN ('human', 'ai_assist', 'ai_auto')),
  -- The batch's numbers: repointed = observations moved to the survivor,
  -- dropped = same-(source, date) collisions deleted (the survivor's row
  -- wins), moved_aliases = spellings transferred with status preserved. Zero
  -- counts are valid receipts — a key-only absorption still collapses an
  -- identity.
  repointed_observations INTEGER NOT NULL,
  dropped_observations INTEGER NOT NULL,
  moved_aliases INTEGER NOT NULL,
  -- WHICH observation ids moved / were dropped (the ticket's audit
  -- requirement, and what a future split operation would replay). JSON arrays
  -- ('[]' minimum) — a table-local blob, the match_review_items.pair_data
  -- precedent (0013); the scalar-only 0037 shape does not fit id lists.
  observation_ids TEXT NOT NULL,
  dropped_observation_ids TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The audit-feed index pair (0022/0027/0032/0037 convention), for both
-- endpoints of a merge. Pinned by EXPLAIN in migrations.test.ts.
CREATE INDEX IF NOT EXISTS idx_merge_audit_to
  ON price_product_merge_audit(to_product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_merge_audit_from
  ON price_product_merge_audit(from_product_key, created_at);

-- The (deferred) bulk pass's skip predicate + the export join: which review
-- decisions already have their registry receipt.
CREATE INDEX IF NOT EXISTS idx_merge_audit_review
  ON price_product_merge_audit(review_item_id);
