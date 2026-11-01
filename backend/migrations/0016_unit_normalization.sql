-- Canonical unit normalization columns for price observations (issue #368
-- phase A). The scraper derives them from each item's unit field / name
-- tokens via its pure unit parser: unit_qty is the quantity in the canonical
-- base unit (grams / milliliters / pieces), unit_qty_unit picks that base,
-- and unit_price is the LISTED price per display unit (per kg / per liter /
-- per piece, rounded integer) — distinct from effective_unit_price, which
-- stays the promo-effective PACK price. All three are NULL when the item
-- was not normalizable, and the migration is append-only: old rows keep
-- validating and old payloads (fields absent) stay ingestable.
ALTER TABLE price_observations ADD COLUMN unit_qty REAL;
ALTER TABLE price_observations ADD COLUMN unit_qty_unit TEXT;
ALTER TABLE price_observations ADD COLUMN unit_price INTEGER;
