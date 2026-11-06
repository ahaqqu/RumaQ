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

import { runBatch, selectIn } from './d1.js'

export type IngestResult = {
  accepted: number
  productsCreated: number
  observationsUpserted: number
  skipped: number
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
  // One lookup serves three purposes: its rows decide which products need an
  // insert, their ids seed the observation pass, and their current category
  // gates the issue-#373 fill below. New products get their ids here (bound
  // in the INSERT below), so a second IN-list round trip is never needed —
  // at catalog scale the per-invocation query budget (50 on the free plan)
  // is D1's tightest limit, and each extra chunked pass is ceil(N/90)
  // queries.
  const existingRows = keys.length
    ? await selectIn<{ id: string; product_key: string; category: string | null }>(
        db,
        'SELECT id, product_key, category FROM price_products WHERE product_key IN',
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

  // Issue #373: an already-known product whose payload now carries a
  // category (the gate=on classifier) fills its NULL category — the
  // backfill/live classification owns the column, so a present value is
  // never clobbered and old payloads (category null) change nothing. Only
  // products the lookup above says are STILL NULL-categorized produce a
  // statement (deduped per product — the same product seen at N stores is
  // one UPDATE), so today's uncategorized payloads add zero statements AND
  // the gate=on steady state (everything already classified) adds zero too —
  // without that second zero the per-invocation D1 query budget (50 on the
  // free plan) would sit at ~49-50 every categorized run at catalog scale,
  // one new product past ~950 items failing the whole publish.
  const existingUncategorizedKeys = new Set(
    existingRows.filter((row) => row.category === null).map((row) => row.product_key)
  )
  const categorizedExistingKeys = [
    ...new Set(
      usable
        .filter((item) => item.category && existingUncategorizedKeys.has(item.productKey))
        .map((item) => item.productKey)
    ),
  ]

  const observedDefault = payload.scrapedAt.slice(0, 10)
  await runBatch(
    db,
    usable.map((item) =>
      db
        .prepare(
          `INSERT INTO price_observations
             (id, product_id, source_id, observed_date, price, effective_unit_price,
              unit_qty, unit_qty_unit, unit_price,
              promo_type, promo_label, valid_from, valid_until, match_method,
              match_confidence, brochure_url, source_url, taxo_version, scraped_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(product_id, source_id, observed_date) DO UPDATE SET
             price = excluded.price,
             effective_unit_price = excluded.effective_unit_price,
             unit_qty = excluded.unit_qty,
             unit_qty_unit = excluded.unit_qty_unit,
             unit_price = excluded.unit_price,
             promo_type = excluded.promo_type,
             promo_label = excluded.promo_label,
             valid_from = excluded.valid_from,
             valid_until = excluded.valid_until,
             match_method = excluded.match_method,
             match_confidence = excluded.match_confidence,
             brochure_url = excluded.brochure_url,
             source_url = excluded.source_url,
             -- COALESCE (issue #373): an old scraper's replay (no
             -- taxoVersion) must never erase a stamp the backfill or a
             -- categorized run already left on the row.
             taxo_version = COALESCE(excluded.taxo_version, price_observations.taxo_version),
             scraped_at = excluded.scraped_at`
        )
        .bind(
          crypto.randomUUID(),
          productIdByKey.get(item.productKey)!,
          sourceIdBySlug.get(item.storeSlug)!,
          item.observedDate ?? observedDefault,
          item.price,
          item.effectiveUnitPrice ?? null,
          // Canonical unit normalization (issue #368 phase A) — null when
          // the producer could not normalize the item.
          item.unitQty ?? null,
          item.unitQtyUnit ?? null,
          item.unitPrice ?? null,
          item.promoType ?? null,
          item.promoLabel ?? null,
          item.validFrom ?? null,
          item.validUntil ?? null,
          item.matchMethod ?? null,
          item.matchConfidence,
          item.brochureUrl ?? null,
          // The retailer campaign/listing page (issue #380) — the evidence
          // link the review card's entry side enriches from. Null for old
          // scrapers' payloads (additive field, no backfill).
          item.sourceUrl ?? null,
          // The classifying taxonomy version (issue #373) — null for old
          // scrapers' payloads (additive field, no backfill).
          item.taxoVersion ?? null,
          payload.scrapedAt
        )
    )
  )

  if (categorizedExistingKeys.length > 0) {
    await runBatch(
      db,
      categorizedExistingKeys.map((key) =>
        db
          .prepare(
            'UPDATE price_products SET category = ? WHERE product_key = ? AND category IS NULL'
          )
          .bind(itemByKey.get(key)!.category, key)
      )
    )
  }

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
