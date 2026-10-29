// The payload schema lives in the @rumaq/contract workspace package
// (runtime-agnostic) so the scraper imports it as a real dependency;
// re-exported here for existing callers.
export {
  ingestStoreSchema,
  ingestItemSchema,
  ingestPayloadSchema,
  runReportSchema,
  reviewItemPairSchema,
  type IngestPayload,
  type IngestStore,
  type IngestItem,
  type RunReport,
  type ReviewItemPair,
} from '@rumaq/contract'
import type { IngestPayload } from '@rumaq/contract'

export type IngestResult = {
  accepted: number
  productsCreated: number
  observationsUpserted: number
  skipped: number
}

// A db.batch() call counts as ONE query against D1's per-invocation budget
// (50 on the free plan); within it, the per-query limits (100 bound
// parameters) apply to each statement — an observation binds 14. 50
// statements per batch keeps both limits comfortable.
const BATCH_CHUNK = 50
// D1 also caps bound parameters per QUERY at 100 — an IN list must ride
// under that ceiling, or a catalog of ≥100 products fails the whole ingest
// with "too many SQL variables at offset …" (observed on the first 382-item
// live publish). 90 leaves headroom for any fixed parameters a caller adds.
const SELECT_IN_CHUNK = 90

type Statement = ReturnType<D1Database['prepare']>

async function runBatch(db: D1Database, statements: Statement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK))
  }
}

async function selectIn<Row>(db: D1Database, sql: string, values: string[]): Promise<Row[]> {
  const rows: Row[] = []
  for (let i = 0; i < values.length; i += SELECT_IN_CHUNK) {
    const chunk = values.slice(i, i + SELECT_IN_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await db
      .prepare(`${sql} (${placeholders})`)
      .bind(...chunk)
      .all<Row>()
    rows.push(...(results ?? []))
  }
  return rows
}

export async function ingestPrices(db: D1Database, payload: IngestPayload): Promise<IngestResult> {
  // Upsert declared stores, then resolve slug → id for the item pass.
  await runBatch(
    db,
    payload.stores.map((store) =>
      db
        .prepare(
          `INSERT INTO price_sources (id, slug, name, kind, region, website, created_at)
           VALUES (?, ?, ?, 'supermarket', ?, ?, datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             name = excluded.name,
             region = excluded.region,
             website = excluded.website`
        )
        .bind(
          crypto.randomUUID(),
          store.slug,
          store.name,
          store.region ?? 'jakarta',
          store.website ?? null
        )
    )
  )

  const slugs = [...new Set(payload.stores.map((s) => s.slug))]
  const sourceRows = slugs.length
    ? await selectIn<{ id: string; slug: string }>(
        db,
        'SELECT id, slug FROM price_sources WHERE slug IN',
        slugs
      )
    : []
  const sourceIdBySlug = new Map(sourceRows.map((row) => [row.slug, row.id]))

  // Items referencing an undeclared store slug are skipped, not fatal, so one
  // bad item never blocks a whole daily snapshot.
  const usable = payload.items.filter((item) => sourceIdBySlug.has(item.storeSlug))
  const skipped = payload.items.length - usable.length

  const keys = [...new Set(usable.map((item) => item.productKey))]
  const itemByKey = new Map(usable.map((item) => [item.productKey, item]))
  // One lookup serves both purposes: its rows decide which products need an
  // insert, and their ids seed the observation pass. New products get their
  // ids here (bound in the INSERT below), so a second IN-list round trip is
  // never needed — at catalog scale the per-invocation query budget (50 on
  // the free plan) is D1's tightest limit, and each extra chunked pass is
  // ceil(N/90) queries.
  const existingRows = keys.length
    ? await selectIn<{ id: string; product_key: string }>(
        db,
        'SELECT id, product_key FROM price_products WHERE product_key IN',
        keys
      )
    : []
  const existingKeys = new Set(existingRows.map((row) => row.product_key))
  const newKeys = keys.filter((key) => !existingKeys.has(key))
  const newIdByKey = new Map(newKeys.map((key) => [key, crypto.randomUUID()]))
  const now = new Date().toISOString()

  if (newKeys.length > 0) {
    await runBatch(
      db,
      newKeys.map((key) => {
        const item = itemByKey.get(key)!
        return db
          .prepare(
            `INSERT INTO price_products
               (id, product_key, name, brand, unit, category, first_seen_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            newIdByKey.get(key)!,
            key,
            item.name,
            item.brand ?? null,
            item.unit ?? null,
            item.category ?? null,
            now,
            now
          )
      })
    )
  }

  const productIdByKey = new Map([
    ...existingRows.map((row) => [row.product_key, row.id] as const),
    ...newIdByKey,
  ])

  const observedDefault = payload.scrapedAt.slice(0, 10)
  await runBatch(
    db,
    usable.map((item) =>
      db
        .prepare(
          `INSERT INTO price_observations
             (id, product_id, source_id, observed_date, price, effective_unit_price,
              promo_type, promo_label, valid_from, valid_until, match_method,
              match_confidence, brochure_url, scraped_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(product_id, source_id, observed_date) DO UPDATE SET
             price = excluded.price,
             effective_unit_price = excluded.effective_unit_price,
             promo_type = excluded.promo_type,
             promo_label = excluded.promo_label,
             valid_from = excluded.valid_from,
             valid_until = excluded.valid_until,
             match_method = excluded.match_method,
             match_confidence = excluded.match_confidence,
             brochure_url = excluded.brochure_url,
             scraped_at = excluded.scraped_at`
        )
        .bind(
          crypto.randomUUID(),
          productIdByKey.get(item.productKey)!,
          sourceIdBySlug.get(item.storeSlug)!,
          item.observedDate ?? observedDefault,
          item.price,
          item.effectiveUnitPrice ?? null,
          item.promoType ?? null,
          item.promoLabel ?? null,
          item.validFrom ?? null,
          item.validUntil ?? null,
          item.matchMethod ?? null,
          item.matchConfidence,
          item.brochureUrl ?? null,
          payload.scrapedAt
        )
    )
  )

  return {
    accepted: usable.length,
    productsCreated: newKeys.length,
    observationsUpserted: usable.length,
    skipped,
  }
}

export type PricesStatus = {
  latestObservedDate: string | null
  latestScrapedAt: string | null
  observationCount: number
}

// Freshness summary for the CI smoke staleness check (§7.1): the smoke
// workflow alerts when the nightly pipeline stops landing observations.
// latestObservedDate is the publish signal (a run that scrapes but never
// publishes leaves it behind); count=0 means go-live has not happened yet.
export async function getPricesStatus(db: D1Database): Promise<PricesStatus> {
  const row = await db
    .prepare(
      `SELECT MAX(observed_date) AS latest_observed_date,
              MAX(scraped_at) AS latest_scraped_at,
              COUNT(*) AS observation_count
       FROM price_observations`
    )
    .first<{
      latest_observed_date: string | null
      latest_scraped_at: string | null
      observation_count: number
    }>()

  return {
    latestObservedDate: row?.latest_observed_date ?? null,
    latestScrapedAt: row?.latest_scraped_at ?? null,
    observationCount: row?.observation_count ?? 0,
  }
}
