// Shared SQL building blocks for the prices read endpoints (issue #292
// design-arch §1.1). Interpolating the identical strings into the explorer
// list, the product detail, and the promo catalog pins count parity between
// the views by construction — the two endpoints cannot drift apart on which
// observations count as "current".

// Observations below the ingest confidence floor are hidden from the
// explorer and the catalog; 0.55–0.85 rows are returned flagged.
export const PRICE_MIN_CONFIDENCE = 0.55

// The correlated latest-observation subquery: only the newest observation
// per (product, source) — by observed date, then scrape time. Used alone by
// the detail endpoint, which deliberately shows below-floor rows flagged
// instead of hiding them.
export const LATEST_OBSERVATION_SUBQUERY = `o.id = (
  SELECT o2.id FROM price_observations o2
  WHERE o2.product_id = o.product_id AND o2.source_id = o.source_id
  ORDER BY o2.observed_date DESC, o2.scraped_at DESC
  LIMIT 1
)`

// The explorer's "current observations" base: the latest observation per
// (product, source) at or above the confidence floor. The promo catalog
// (getPromoCatalog below) shares this exact string so its group counts
// always reconcile with what the unfiltered explorer shows.
export const LATEST_OBSERVATION_PREDICATE = `${LATEST_OBSERVATION_SUBQUERY}
AND o.match_confidence >= ${PRICE_MIN_CONFIDENCE}`
