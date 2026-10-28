// Brochure image domain logic (issue #293): key validation shared by the
// upload and serving routes, the ingest-piggybacked retention sweep, and the
// /prices brochures catalog. The sweep's referenced-set interpolates #292's
// LATEST_OBSERVATION_PREDICATE so retention and the view share one definition
// of "current" — the view can never link an object the backend knows is dead.

import { SCRAPE_STORE_SLUGS } from '@rumaq/contract'

import { LATEST_OBSERVATION_PREDICATE } from './prices.js'

/** Unreferenced objects younger than this grace period survive the sweep. */
export const BROCHURE_GRACE_DAYS = 14

/** The servable shape every stored brochure_url must match. */
export const BROCHURE_URL_PREFIX = '/api/brochures/'

/** Upload size cap (flyer pages are ≪ 1 MB; the cap is abuse protection). */
export const BROCHURE_MAX_BYTES = 10 * 1024 * 1024

/** Image types the scraper detects (state.ts's GEMINI_IMAGE_TYPES clamp set). */
export const BROCHURE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
])

// The real store fixtures carry parentheses in filenames (e.g. "HEMAT_E_20_
// (1)_DKI"), so the charset is the design's URL-safe set plus brackets-free
// parentheses — still no slashes, no '..' traversal, bounded length.
const FILENAME_PATTERN = /^[A-Za-z0-9._()-]{1,200}$/
const DATE_PATTERN = /^\d{8}$/

/**
 * Validate the three path segments and return the R2 key
 * `{storeSlug}/{YYYYMMDD}/{filename}` — or null when any segment is
 * malformed (both routes answer 404, never leaking shape details).
 */
export function parseBrochureKey(
  storeSlug: string,
  date: string,
  filename: string
): string | null {
  if (!(SCRAPE_STORE_SLUGS as readonly string[]).includes(storeSlug)) return null
  if (!DATE_PATTERN.test(date)) return null
  const month = Number(date.slice(4, 6))
  const day = Number(date.slice(6, 8))
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (!FILENAME_PATTERN.test(filename) || filename === '.' || filename === '..') return null
  return `${storeSlug}/${date}/${filename}`
}

// The sweep's referenced set: DISTINCT servable brochure URLs among CURRENT
// observations. The identical predicate string rides in the /prices
// brochures catalog (below) and the explorer — count parity by construction.
const BROCHURE_SERVABLE = `o.brochure_url LIKE '${BROCHURE_URL_PREFIX}%'`

export type SweepOptions = {
  /** Injectable clock (unit tests); defaults to the real now. */
  now?: Date
  log?: (message: string) => void
}

/**
 * Delete brochure objects that no current observation references and whose
 * key date is older than the grace period. Keys carry their scrape date
 * (segment 2), so no R2 metadata round-trip is needed; unparseable keys are
 * never deleted (safe default). Idempotent by construction — safe under
 * at-least-once ingest retries and multiple daily Scrape-Now triggers.
 * Best-effort by contract: callers wrap it so a sweep failure never fails
 * the ingest response.
 */
export async function sweepUnreferencedBrochures(
  db: D1Database,
  bucket: R2Bucket,
  opts: SweepOptions = {}
): Promise<{ deleted: number }> {
  const log = opts.log ?? (() => {})
  const now = opts.now ?? new Date()

  const { results } = await db
    .prepare(`SELECT DISTINCT o.brochure_url
FROM price_observations o
WHERE ${BROCHURE_SERVABLE}
  AND ${LATEST_OBSERVATION_PREDICATE}`)
    .all<{ brochure_url: string | null }>()

  const referenced = new Set(
    (results ?? [])
      .map((row) => row.brochure_url)
      .filter((url): url is string => typeof url === 'string')
  )

  const graceCutoff = now.getTime() - BROCHURE_GRACE_DAYS * 24 * 60 * 60 * 1000
  let deleted = 0

  // Paginate: R2 list truncates at 1,000 keys — the loop must follow the
  // cursor so a grown catalog is fully swept (pinned by a unit test).
  let cursor: string | undefined
  do {
    const page: R2Objects = await bucket.list(cursor ? { cursor } : {})
    for (const object of page.objects) {
      const segments = object.key.split('/')
      // {storeSlug}/{YYYYMMDD}/{filename} — anything else is never deleted.
      if (segments.length !== 3 || !DATE_PATTERN.test(segments[1]!)) continue
      const keyDate = Date.parse(
        `${segments[1]!.slice(0, 4)}-${segments[1]!.slice(4, 6)}-${segments[1]!.slice(6, 8)}T00:00:00Z`
      )
      if (Number.isNaN(keyDate)) continue
      const url = `${BROCHURE_URL_PREFIX}${object.key}`
      if (referenced.has(url)) continue
      if (keyDate >= graceCutoff) continue
      await bucket.delete(object.key)
      deleted++
      log(`[brochures] swept unreferenced ${object.key}`)
    }
    cursor = page.truncated ? page.truncatedPart : undefined
  } while (cursor)

  return { deleted }
}

// --- Brochures catalog (issue #293 design-arch §5) ---

export type BrochureExampleProduct = {
  product_key: string
  name: string
  brand: string | null
  unit: string | null
  price: number
  effective_unit_price: number | null
}

export type BrochureGroup = {
  source_slug: string
  source_name: string
  brochure_url: string
  observed_date: string
  product_count: number
  example_products: BrochureExampleProduct[]
}

export type BrochureCatalog = {
  groups: BrochureGroup[]
}

/**
 * Brochure catalog for the /prices Brochures view: current observations with
 * a servable brochure_url grouped by (source, brochure image), newest date
 * first, with up to five example products per group. One DB.batch of 2
 * statements per request; the same LATEST_OBSERVATION_PREDICATE as the
 * explorer and promo catalog keeps the views' counts reconciled.
 */
export async function getBrochureCatalog(db: D1Database): Promise<BrochureCatalog> {
  const [groups, examples] = await db.batch([
    db.prepare(`-- brochures: groups
SELECT s.slug AS source_slug,
       s.name AS source_name,
       o.brochure_url,
       MAX(o.observed_date) AS observed_date,
       COUNT(DISTINCT p.product_key) AS product_count
FROM price_observations o
JOIN price_products p ON p.id = o.product_id
JOIN price_sources s ON s.id = o.source_id
WHERE ${LATEST_OBSERVATION_PREDICATE}
  AND ${BROCHURE_SERVABLE}
GROUP BY s.id, o.brochure_url
ORDER BY s.name COLLATE NOCASE ASC, observed_date DESC, o.brochure_url ASC`),
    db.prepare(`-- brochures: examples
WITH base AS (
  SELECT p.product_key, p.name, p.brand, p.unit,
         o.brochure_url, o.price, o.effective_unit_price
  FROM price_observations o
  JOIN price_products p ON p.id = o.product_id
  JOIN price_sources s ON s.id = o.source_id
  WHERE ${LATEST_OBSERVATION_PREDICATE}
    AND ${BROCHURE_SERVABLE}
),
best AS (
  -- one display row per product per brochure: its cheapest offer
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY brochure_url, product_key
    ORDER BY COALESCE(effective_unit_price, price) ASC
  ) AS offer_rn
  FROM base
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY brochure_url
    ORDER BY name COLLATE NOCASE ASC, product_key ASC
  ) AS group_rn
  FROM best WHERE offer_rn = 1
)
SELECT brochure_url, product_key, name, brand, unit, price, effective_unit_price
FROM ranked WHERE group_rn <= 5
ORDER BY brochure_url ASC, group_rn ASC`),
  ])

  const groupRows =
    (
      groups as {
        results?: Array<{
          source_slug: string
          source_name: string
          brochure_url: string
          observed_date: string
          product_count: number
        }>
      }
    ).results ?? []
  const exampleRows =
    (examples as { results?: Array<BrochureExampleProduct & { brochure_url: string }> }).results ??
    []

  const examplesByUrl = new Map<string, BrochureExampleProduct[]>()
  for (const { brochure_url, ...product } of exampleRows) {
    const list = examplesByUrl.get(brochure_url) ?? []
    list.push(product)
    examplesByUrl.set(brochure_url, list)
  }

  return {
    groups: groupRows.map((row) => ({
      source_slug: row.source_slug,
      source_name: row.source_name,
      brochure_url: row.brochure_url,
      observed_date: row.observed_date,
      product_count: Number(row.product_count),
      example_products: examplesByUrl.get(row.brochure_url) ?? [],
    })),
  }
}
