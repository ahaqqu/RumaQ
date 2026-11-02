-- Taxonomy stamp on price observations (issue #373): the frozen taxonomy
-- version that classified the product's name ("v0.2", …). Category itself
-- already lives on price_products (0007); the version stamp rides the
-- observation so a future taxonomy bump (v0.3+) can replay-backfill without
-- drift — every observation records exactly which taxonomy answered for it.
-- Nullable + append-only: rows ingested before this column exist keep NULL
-- until the backfill job stamps them, and old payloads (field absent) stay
-- ingestable (COALESCE on the ingest upsert preserves existing stamps).
ALTER TABLE price_observations ADD COLUMN taxo_version TEXT;
