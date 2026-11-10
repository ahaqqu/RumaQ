-- One stock row per (household_id, item_id) — #551 items (b)+(c).
--
-- (b) Cleanup first. Pre-fix, the purchase loop's per-line stock SELECT ran
-- before the batch, so it could not see writes the same receipt had already
-- queued: a multi-line receipt naming one item wrote duplicate stock rows (two
-- INSERT branches) and recomputed each UPDATE from the same stale qty
-- (last-write-wins dropped every earlier line's quantity). #551(a) closes the
-- write side; this pass collapses what the old loop already wrote.
--
-- Merge rule (disclosed per the ticket): quantities SUM across each duplicate
-- pair — every duplicate row is a real delivered quantity the last-write-wins
-- bug dropped or double-counted; every OTHER field (location_id, unit,
-- expiry_date, run_out_days, basis) keeps the row with the latest updated_at.
-- The survivor is the latest updated_at row; exact timestamp ties break on the
-- larger id so the outcome is deterministic. Pairs with a single row are
-- untouched.
--
-- (c) Then the plain index from 0003 becomes UNIQUE under the same name — the
-- duplicate class stays closed permanently. The write paths aggregate per item
-- id before writing (#551a), so the constraint is never hit in normal flow; it
-- is the safety net behind the map.

DROP INDEX IF EXISTS idx_stock_household_item;

-- Fold the pair's total quantity into each survivor (a row that is the latest
-- of its pair AND shares the pair with at least one other row). Rows in
-- single-row pairs keep their exact qty — a full-table SUM rewrite is a
-- pointless write on production data.
UPDATE stock
SET qty = (
  SELECT SUM(s2.qty)
  FROM stock s2
  WHERE s2.household_id = stock.household_id AND s2.item_id = stock.item_id
)
WHERE NOT EXISTS (
  SELECT 1
  FROM stock s3
  WHERE s3.household_id = stock.household_id
    AND s3.item_id = stock.item_id
    AND (s3.updated_at > stock.updated_at
         OR (s3.updated_at = stock.updated_at AND s3.id > stock.id))
)
AND EXISTS (
  SELECT 1
  FROM stock s4
  WHERE s4.household_id = stock.household_id
    AND s4.item_id = stock.item_id
    AND s4.id != stock.id
);

-- Delete every non-survivor: any row whose pair has a strictly newer row.
DELETE FROM stock
WHERE EXISTS (
  SELECT 1
  FROM stock s2
  WHERE s2.household_id = stock.household_id
    AND s2.item_id = stock.item_id
    AND (s2.updated_at > stock.updated_at
         OR (s2.updated_at = stock.updated_at AND s2.id > stock.id))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_household_item ON stock(household_id, item_id);
