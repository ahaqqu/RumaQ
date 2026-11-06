import { parse } from 'valibot'

import {
  PIPELINE_CONTRACT_VERSION,
  canonicalIndexSchema,
  type CanonicalIndex,
  type CanonicalProduct,
  type IngestPayloadV2,
  type IngestReceipt,
  type ProductSize,
} from '@rumaq/contract'

const BATCH_CHUNK = 50
const SELECT_IN_CHUNK = 90

type Statement = ReturnType<D1Database['prepare']>

type ExistingProduct = {
  id: string
  product_key: string
  category: string | null
  category_version: string | null
}

type ProductRow = {
  id: string
  product_key: string
  name: string
  brand: string | null
  product_type: string | null
  variant: string | null
  size_quantity: number | null
  size_unit: string | null
  pack_count: number | null
  total_quantity: number | null
  packaging: string | null
  quantity_min: number | null
  quantity_max: number | null
  description: string | null
  category: string | null
  category_version: string | null
  status: string
  metadata_version: number | null
  first_seen_at: string | null
  last_seen_at: string | null
  updated_at: string | null
}

type AliasRow = {
  product_id: string
  name: string
  store_slug: string
  first_seen_at: string
  last_seen_at: string
  source: string
}

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

function provisionalName(rawName: string): string {
  return rawName.trim() || rawName
}

export async function ingestPricesV2(
  db: D1Database,
  payload: IngestPayloadV2
): Promise<IngestReceipt> {
  // Upsert declared stores, then resolve slug -> id for the observation pass.
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

  const slugs = [...new Set(payload.stores.map((store) => store.slug))]
  const sourceRows = slugs.length
    ? await selectIn<{ id: string; slug: string }>(
        db,
        'SELECT id, slug FROM price_sources WHERE slug IN',
        slugs
      )
    : []
  const sourceIdBySlug = new Map(sourceRows.map((row) => [row.slug, row.id]))
  for (const item of payload.items) {
    if (!sourceIdBySlug.has(item.storeSlug)) {
      throw new Error(`Store '${item.storeSlug}' was not persisted.`)
    }
  }

  const keys = [...new Set(payload.items.map((item) => item.productKey))]
  const itemByKey = new Map(payload.items.map((item) => [item.productKey, item]))
  const existingRows = keys.length
    ? await selectIn<ExistingProduct>(
        db,
        'SELECT id, product_key, category, category_version FROM price_products WHERE product_key IN',
        keys
      )
    : []
  const existingKeys = new Set(existingRows.map((row) => row.product_key))
  const newKeys = keys.filter((key) => !existingKeys.has(key))
  const newIdByKey = new Map(newKeys.map((key) => [key, crypto.randomUUID()]))
  const productIdByKey = new Map([
    ...existingRows.map((row) => [row.product_key, row.id] as const),
    ...newIdByKey,
  ])
  const now = new Date().toISOString()
  const observedDefault = payload.scrapedAt.slice(0, 10)
  const statements: Statement[] = []

  for (const key of newKeys) {
    const item = itemByKey.get(key)!
    statements.push(
      db
        .prepare(
          `INSERT INTO price_products
             (id, product_key, name, brand, unit, category, category_version,
              status, metadata_version, first_seen_at, last_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'provisional', 1, ?, ?, ?)`
        )
        .bind(
          newIdByKey.get(key)!,
          key,
          provisionalName(item.rawName),
          item.rawBrand?.trim() || null,
          item.rawUnit?.trim() || null,
          item.category ?? null,
          item.taxoVersion ?? null,
          now,
          now,
          now
        )
    )
  }

  for (const row of existingRows) {
    const item = itemByKey.get(row.product_key)
    statements.push(
      db
        .prepare(
          `UPDATE price_products
           SET last_seen_at = ?, updated_at = ?,
               category = COALESCE(category, ?),
               category_version = COALESCE(category_version, ?)
           WHERE product_key = ?`
        )
        .bind(now, now, item?.category ?? null, item?.taxoVersion ?? null, row.product_key)
    )
  }

  // Candidate aliases: one per (product, store, raw name). An existing
  // approved alias keeps its status; ingest only refreshes last_seen_at.
  const aliasSeen = new Set<string>()
  for (const item of payload.items) {
    const productId = productIdByKey.get(item.productKey)!
    const aliasKey = `${productId}\u0000${item.storeSlug}\u0000${item.rawName}`
    if (aliasSeen.has(aliasKey)) continue
    aliasSeen.add(aliasKey)
    statements.push(
      db
        .prepare(
          `INSERT INTO price_product_aliases
             (id, product_id, store_slug, name, status, source, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, 'candidate', 'ocr', ?, ?)
           ON CONFLICT(product_id, store_slug, name) DO UPDATE SET
             last_seen_at = excluded.last_seen_at`
        )
        .bind(crypto.randomUUID(), productId, item.storeSlug, item.rawName, now, now)
    )
  }

  for (const item of payload.items) {
    statements.push(
      db
        .prepare(
          `INSERT INTO price_observations
             (id, product_id, source_id, observed_date, price, effective_unit_price,
              unit_qty, unit_qty_unit, unit_price,
              promo_type, promo_label, valid_from, valid_until, match_method,
              match_confidence, brochure_url, source_url, taxo_version,
              raw_name, raw_brand, raw_unit, page, ocr_model, scraped_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
             taxo_version = COALESCE(excluded.taxo_version, price_observations.taxo_version),
             raw_name = excluded.raw_name,
             raw_brand = excluded.raw_brand,
             raw_unit = excluded.raw_unit,
             page = excluded.page,
             ocr_model = excluded.ocr_model,
             scraped_at = excluded.scraped_at`
        )
        .bind(
          crypto.randomUUID(),
          productIdByKey.get(item.productKey)!,
          sourceIdBySlug.get(item.storeSlug)!,
          item.observedDate ?? observedDefault,
          item.price,
          item.effectiveUnitPrice ?? null,
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
          item.sourceUrl ?? null,
          item.taxoVersion ?? null,
          item.rawName,
          item.rawBrand ?? null,
          item.rawUnit ?? null,
          item.page ?? null,
          item.ocrModel ?? null,
          payload.scrapedAt
        )
    )
  }

  if (payload.items.length > 0) {
    statements.push(
      db.prepare('UPDATE canonical_index_state SET version = version + 1 WHERE id = 1')
    )
  }

  await runBatch(db, statements)

  const state = await db
    .prepare('SELECT version FROM canonical_index_state WHERE id = 1')
    .first<{ version: number }>()
  const indexVersion = state?.version ?? 0

  return {
    schemaVersion: PIPELINE_CONTRACT_VERSION,
    scrapedAt: payload.scrapedAt,
    indexVersion,
    accepted: payload.items.length,
    skipped: 0,
    productsCreated: newKeys.length,
    observationsUpserted: payload.items.length,
    products: keys.map((key) => ({
      productKey: key,
      productId: productIdByKey.get(key)!,
      status: existingKeys.has(key) ? 'existing' : 'created',
    })),
  }
}

function asIsoTimestamp(value: string | null, fallback: string): string {
  if (!value) return fallback
  return value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
}

function sizeFromRow(row: ProductRow): ProductSize | null {
  const size = {
    quantity: row.size_quantity,
    unit: row.size_unit as ProductSize['unit'],
    packCount: row.pack_count,
    totalQuantity: row.total_quantity,
    packaging: row.packaging,
    quantityMin: row.quantity_min,
    quantityMax: row.quantity_max,
  }
  return Object.values(size).some((value) => value !== null) ? size : null
}

export async function getCanonicalIndex(db: D1Database): Promise<CanonicalIndex> {
  const state = await db
    .prepare('SELECT version FROM canonical_index_state WHERE id = 1')
    .first<{ version: number }>()
  const products = await db
    .prepare(
      `SELECT id, product_key, name, brand, product_type, variant, size_quantity,
              size_unit, pack_count, total_quantity, packaging, quantity_min,
              quantity_max, description, category, category_version, status,
              metadata_version, first_seen_at, last_seen_at, updated_at
       FROM price_products
       ORDER BY product_key`
    )
    .all<ProductRow>()
  const aliases = await db
    .prepare(
      `SELECT product_id, name, store_slug, first_seen_at, last_seen_at, source
       FROM price_product_aliases
       WHERE status = 'approved'
       ORDER BY product_id, name`
    )
    .all<AliasRow>()

  const aliasesByProduct = new Map<string, CanonicalProduct['aliases']>()
  for (const alias of aliases.results ?? []) {
    const list = aliasesByProduct.get(alias.product_id) ?? []
    list.push({
      name: alias.name,
      storeSlug: alias.store_slug,
      firstSeenAt: alias.first_seen_at,
      lastSeenAt: alias.last_seen_at,
      source: alias.source as 'ocr' | 'catalog' | 'admin',
    })
    aliasesByProduct.set(alias.product_id, list)
  }

  const now = new Date().toISOString()
  const index = {
    schemaVersion: PIPELINE_CONTRACT_VERSION,
    indexVersion: state?.version ?? 0,
    generatedAt: now,
    products: (products.results ?? []).map((row) => ({
      id: row.id,
      productKey: row.product_key,
      canonicalName: row.name,
      brand: row.brand,
      productType: row.product_type,
      variant: row.variant,
      size: sizeFromRow(row),
      description: row.description,
      category: row.category,
      categoryVersion: row.category_version,
      status: row.status as CanonicalProduct['status'],
      metadataVersion: row.metadata_version ?? 1,
      firstSeenAt: asIsoTimestamp(row.first_seen_at, now),
      lastSeenAt: asIsoTimestamp(row.last_seen_at, now),
      updatedAt: asIsoTimestamp(row.updated_at ?? row.last_seen_at, now),
      aliases: aliasesByProduct.get(row.id) ?? [],
    })),
  }

  return parse(canonicalIndexSchema, index)
}
