-- Match review evidence (issue #380): the retailer campaign/listing page an
-- item was extracted from, distinct from brochure_url — which holds the R2
-- page-image object URL for brochure stores (/api/brochures/…) and doubles
-- as the listing page for catalog stores. The review card links both: the
-- page image to verify the extraction against, and the retailer page the
-- item came from. Nullable + additive: rows ingested before this column
-- exist keep NULL (no backfill — the scraper simply never captured it).
ALTER TABLE price_observations ADD COLUMN source_url TEXT;
