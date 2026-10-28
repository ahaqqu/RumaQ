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

// --- Promo catalog (issue #292 design-arch §1.2) ---

// The closed 5-value promo_type enum the brochure parser produces. The CASE
// below is the ONLY place these values live: unknown future enum values and
// NULL-type-with-label rows fall into 'other' by construction (NULL never
// matches IN).
const PROMO_GROUP_CASE = `CASE WHEN o.promo_type IN ('discount_pct','discount_fixed','get_free','bundle_buy','multi_price')
       THEN o.promo_type ELSE 'other' END`

// Rows carry promo evidence when the type is set, or a label rides along
// with an unclassified type. Interpolated into ALL FOUR statements: without
// it, plain non-promo rows fall into 'other' via the CASE and the group
// counts would not reconcile with the explorer (caught by the automation
// count-parity fixture against real D1).
const PROMO_EVIDENCE = `(o.promo_type IS NOT NULL OR (o.promo_label IS NOT NULL AND o.promo_label <> ''))`

// Fixed response order (PM §2); groups absent from the totals result are
// omitted during assembly. 'other' sorts last.
const PROMO_GROUP_ORDER = [
  'discount_pct',
  'discount_fixed',
  'get_free',
  'bundle_buy',
  'multi_price',
  'other',
] as const

// The unfiltered explorer base — no q/source filters. Count parity with the
// explorer is the binding requirement, and the explorer with no filters is
// exactly this set of rows.
const PROMO_LATEST_BASE = `FROM price_observations o
JOIN price_products p ON p.id = o.product_id
JOIN price_sources s ON s.id = o.source_id
WHERE ${LATEST_OBSERVATION_PREDICATE}`

export type PromoExampleProduct = {
  product_key: string
  name: string
  brand: string | null
  unit: string | null
  source_slug: string
  source_name: string
  price: number
  effective_unit_price: number | null
}

export type PromoTypeGroup = {
  promo_type: string
  product_count: number
  stores: Record<string, number>
  example_products: PromoExampleProduct[]
}

export type PromoCatalog = {
  types: PromoTypeGroup[]
  total: number
}

// Promo catalog for the /prices Promos view: current observations grouped by
// promo type, with per-source distinct counts and up to five example
// products per group. One DB.batch of 4 statements per request.
export async function getPromoCatalog(db: D1Database): Promise<PromoCatalog> {
  // Unique SQL markers route fake-DB results in the unit tests. Per-group
  // DISTINCT across sources cannot be summed into the group total (one
  // product can be on promo at 2 stores), so totals and per-source counts
  // are separate statements. SQLite (D1) has no QUALIFY and disallows
  // DISTINCT inside window aggregates, hence the extra `ranked` nesting and
  // the two-level window.
  const [totals, perSource, examples, totalRow] = await db.batch([
    db.prepare(`-- promos: totals
SELECT ${PROMO_GROUP_CASE} AS group_key,
       COUNT(DISTINCT p.product_key) AS product_count
${PROMO_LATEST_BASE}
  AND ${PROMO_EVIDENCE}
GROUP BY group_key`),
    db.prepare(`-- promos: sources
SELECT ${PROMO_GROUP_CASE} AS group_key,
       s.slug AS source_slug,
       COUNT(DISTINCT p.product_key) AS product_count
${PROMO_LATEST_BASE}
  AND ${PROMO_EVIDENCE}
GROUP BY group_key, source_slug
ORDER BY source_slug ASC`),
    db.prepare(`-- promos: examples
WITH base AS (
  SELECT ${PROMO_GROUP_CASE} AS group_key,
         p.product_key, p.name, p.brand, p.unit,
         s.slug AS source_slug, s.name AS source_name,
         o.price, o.effective_unit_price
  ${PROMO_LATEST_BASE}
    AND ${PROMO_EVIDENCE}
),
best AS (
  -- one display row per product per group: its cheapest promo offer
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY group_key, product_key
    ORDER BY COALESCE(effective_unit_price, price) ASC, source_slug ASC
  ) AS offer_rn
  FROM base
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY group_key
    ORDER BY name COLLATE NOCASE ASC, product_key ASC
  ) AS group_rn
  FROM best WHERE offer_rn = 1
)
SELECT group_key, product_key, name, brand, unit, source_slug, source_name,
       price, effective_unit_price
FROM ranked WHERE group_rn <= 5
ORDER BY group_key ASC, group_rn ASC`),
    db.prepare(`-- promos: total
SELECT COUNT(DISTINCT p.product_key) AS total
${PROMO_LATEST_BASE}
  AND ${PROMO_EVIDENCE}`),
  ])

  const totalsRows =
    (totals as { results?: Array<{ group_key: string; product_count: number }> }).results ?? []
  const sourceRows =
    (
      perSource as {
        results?: Array<{ group_key: string; source_slug: string; product_count: number }>
      }
    ).results ?? []
  const exampleRows =
    (examples as { results?: Array<PromoExampleProduct & { group_key: string }> }).results ?? []
  const total = Number(
    (totalRow as { results?: Array<{ total: number }> }).results?.[0]?.total ?? 0
  )

  const storesByGroup = new Map<string, Record<string, number>>()
  for (const row of sourceRows) {
    const stores = storesByGroup.get(row.group_key) ?? {}
    stores[row.source_slug] = Number(row.product_count)
    storesByGroup.set(row.group_key, stores)
  }

  const examplesByGroup = new Map<string, PromoExampleProduct[]>()
  for (const { group_key, ...product } of exampleRows) {
    const list = examplesByGroup.get(group_key) ?? []
    list.push(product)
    examplesByGroup.set(group_key, list)
  }

  const byKey = new Map(totalsRows.map((row) => [row.group_key, row]))
  const types: PromoTypeGroup[] = PROMO_GROUP_ORDER.filter((key) => byKey.has(key)).map((key) => ({
    promo_type: key,
    product_count: Number(byKey.get(key)!.product_count),
    stores: storesByGroup.get(key) ?? {},
    example_products: examplesByGroup.get(key) ?? [],
  }))

  return { types, total }
}
