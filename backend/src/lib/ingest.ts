// The payload schema lives in the @rumaq/contract workspace package
// (runtime-agnostic) so the scraper imports it as a real dependency;
// re-exported here for existing callers.
export {
  ingestStoreSchema,
  ingestItemSchema,
  ingestPayloadSchema,
  type IngestPayload,
  type IngestStore,
  type IngestItem,
} from '@rumaq/contract'
import type { IngestPayload } from '@rumaq/contract'

export type IngestResult = {
  accepted: number
  productsCreated: number
  observationsUpserted: number
  skipped: number
}

// D1 caps a batch's total bound parameters; keep chunks well under it.
const BATCH_CHUNK = 50

type Statement = ReturnType<D1Database['prepare']>

async function runBatch(db: D1Database, statements: Statement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK))
  }
}

async function selectIn<Row>(db: D1Database, sql: string, values: string[]): Promise<Row[]> {
  const placeholders = values.map(() => '?').join(',')
  const { results } = await db
    .prepare(`${sql} (${placeholders})`)
    .bind(...values)
    .all<Row>()
  return results ?? []
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
  const existingRows = keys.length
    ? await selectIn<{ product_key: string }>(
        db,
        'SELECT product_key FROM price_products WHERE product_key IN',
        keys
      )
    : []
  const existingKeys = new Set(existingRows.map((row) => row.product_key))
  const newKeys = keys.filter((key) => !existingKeys.has(key))
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
            crypto.randomUUID(),
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

  const productRows = keys.length
    ? await selectIn<{ id: string; product_key: string }>(
        db,
        'SELECT id, product_key FROM price_products WHERE product_key IN',
        keys
      )
    : []
  const productIdByKey = new Map(productRows.map((row) => [row.product_key, row.id]))

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
