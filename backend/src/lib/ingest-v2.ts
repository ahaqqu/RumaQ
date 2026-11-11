import { parse, safeParse } from 'valibot'

import {
  PIPELINE_CONTRACT_VERSION,
  canonicalIndexSchema,
  ingestReceiptSchema,
  type CanonicalIndex,
  type CanonicalProduct,
  type IngestPayloadV2,
  type IngestReceipt,
  type ProductSize,
} from '@rumaq/contract'

import type { Statement } from './d1.js'
import { BATCH_CHUNK, SELECT_IN_CHUNK, assertQueryBudget, runBatch, selectIn } from './d1.js'

type ExistingProduct = {
  id: string
  product_key: string
  category: string | null
  category_version: string | null
  size_quantity: number | null
  size_unit: string | null
  pack_count: number | null
  total_quantity: number | null
  quantity_min: number | null
  quantity_max: number | null
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

/**
 * The canonical index exists for one consumer and one contract: the pipeline
 * validates it with `canonicalIndexSchema` and fails the run when it does not
 * match (§6.3). A stored row that cannot satisfy the schema is therefore an
 * integrity fault, not a transient one — the route answers with a stable,
 * data-free body and the offending product goes to the log. Carrying the ids
 * makes that log actionable instead of a stack trace.
 */
export class CanonicalIndexIntegrityError extends Error {
  constructor(
    readonly productId: string,
    readonly issues: string[]
  ) {
    super(`Canonical index row '${productId}' does not match the contract`)
    this.name = 'CanonicalIndexIntegrityError'
  }
}

// The schema enforces a non-empty rawName but not a non-blank one ("   " is
// valid), and a blank canonical name would ship in the index for the pipeline
// to match on. Fall back to the frozen key, which is always present.
function provisionalName(rawName: string, productKey: string): string {
  return rawName.trim() || productKey
}

// Contract §4.3 (pipeline #116): the per-pack size tuple an observation carries.
// `quantity` is one pack in the base unit; `packCount` is part of the identity
// and defaults to 1 (the backend derives `total_quantity` from the two).
type SizeTuple = {
  quantity: number
  unit: 'g' | 'ml' | 'pcs'
  packCount: number
}

// Contract §4.3 (design §2.3): a key is `name--brand--unit`; an empty unit
// segment is the sizeless spelling (`name----`). Such a product is sizeless by
// identity, so ingest refuses to write a size onto it even when the payload
// carries one — the pipeline is the enforcement point, the backend is the
// alarm. The rule is defined on the unclamped key format: `clampProductKey`
// truncation can hide the trailing empty segment, a rare pre-existing edge.
function isSizedKey(productKey: string): boolean {
  return !productKey.endsWith('--')
}

function sizeTupleOf(item: IngestPayloadV2['items'][number]): SizeTuple | null {
  if (!item.size) return null
  return {
    quantity: item.size.quantity,
    unit: item.size.unit,
    packCount: item.size.packCount ?? 1,
  }
}

function logSizeEvent(
  event: 'size_conflict' | 'size_with_sizeless_key',
  details: Record<string, unknown>
): void {
  // Server-side only: these are the identity writes the backend refuses or
  // keeps. Never a 400 — one bad item must not lose a night.
  console.warn(`[ingest-v2] ${event}`, JSON.stringify(details))
}

// Contract §4.3: "all size columns are null" is the fill gate — the six
// identity/range columns ingest owns. `packaging` is display-only and does not
// block the fill.
function hasNoSizeEvidence(row: ExistingProduct): boolean {
  return (
    row.size_quantity === null &&
    row.size_unit === null &&
    row.pack_count === null &&
    row.total_quantity === null &&
    row.quantity_min === null &&
    row.quantity_max === null
  )
}

// A stored tuple without `pack_count` predates the writer (or came from an
// admin form); the payload's default of 1 is the same identity.
function sameStoredSize(row: ExistingProduct, size: SizeTuple): boolean {
  return (
    row.size_quantity === size.quantity &&
    row.size_unit === size.unit &&
    (row.pack_count ?? 1) === size.packCount
  )
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
  // First item per key, so a payload carrying the same productKey twice names
  // the product deterministically instead of last-wins by array order.
  const itemByKey = new Map<string, IngestPayloadV2['items'][number]>()
  for (const item of payload.items) {
    if (!itemByKey.has(item.productKey)) itemByKey.set(item.productKey, item)
  }
  // Contract §4.3: the first item WITH a size per key supplies the tuple — not
  // the first item by array order, which can be the unit-less spelling (the
  // product would otherwise be born sizeless). A later disagreement is the
  // matcher/identity bug signal; the backend cannot choose, so it keeps the
  // first and logs.
  const sizeByKey = new Map<string, SizeTuple>()
  const payloadSizeConflictLogged = new Set<string>()
  const sizelessKeyLogged = new Set<string>()
  for (const item of payload.items) {
    const size = sizeTupleOf(item)
    if (!size) continue
    if (!isSizedKey(item.productKey)) {
      if (!sizelessKeyLogged.has(item.productKey)) {
        sizelessKeyLogged.add(item.productKey)
        logSizeEvent('size_with_sizeless_key', { productKey: item.productKey, size })
      }
      continue
    }
    const kept = sizeByKey.get(item.productKey)
    if (!kept) {
      sizeByKey.set(item.productKey, size)
      continue
    }
    if (
      kept.quantity !== size.quantity ||
      kept.unit !== size.unit ||
      kept.packCount !== size.packCount
    ) {
      if (!payloadSizeConflictLogged.has(item.productKey)) {
        payloadSizeConflictLogged.add(item.productKey)
        logSizeEvent('size_conflict', {
          productKey: item.productKey,
          against: 'payload',
          kept,
          ignored: size,
        })
      }
    }
  }
  const existingRows = keys.length
    ? await selectIn<ExistingProduct>(
        db,
        `SELECT id, product_key, category, category_version, size_quantity, size_unit,
                pack_count, total_quantity, quantity_min, quantity_max
         FROM price_products WHERE product_key IN`,
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
  // Contract §4.2: the UTC date of scrapedAt. The schema only checks the
  // timestamp prefix, so an offset-carrying value validates too — parsing
  // (not slicing) is what makes the date UTC; an unparseable suffix falls
  // back to the literal prefix.
  const scrapedAtMs = Date.parse(payload.scrapedAt)
  const observedDefault = Number.isNaN(scrapedAtMs)
    ? payload.scrapedAt.slice(0, 10)
    : new Date(scrapedAtMs).toISOString().slice(0, 10)
  const statements: Statement[] = []

  for (const key of newKeys) {
    const item = itemByKey.get(key)!
    // Contract §4.3: creation is the only moment the backend sees the key and
    // the size together, so the tuple is written here. `total_quantity` is
    // derived (one pack × packCount); packaging and the range bounds stay null
    // from ingest.
    const size = sizeByKey.get(key) ?? null
    statements.push(
      db
        .prepare(
          `INSERT INTO price_products
             (id, product_key, name, brand, unit, category, category_version,
              size_quantity, size_unit, pack_count, total_quantity,
              status, metadata_version, first_seen_at, last_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisional', 1, ?, ?, ?)`
        )
        .bind(
          newIdByKey.get(key)!,
          key,
          provisionalName(item.rawName, key),
          item.rawBrand?.trim() || null,
          item.rawUnit?.trim() || null,
          item.category ?? null,
          item.taxoVersion ?? null,
          size?.quantity ?? null,
          size?.unit ?? null,
          size?.packCount ?? null,
          size ? size.quantity * size.packCount : null,
          now,
          now,
          now
        )
    )
  }

  // Existing products: one statement per 90 keys for the shared timestamps
  // (every row gets the same `now`), instead of one statement per product —
  // the per-invocation D1 query budget is the tightest limit at catalog
  // scale (lib/d1.ts). The category proposal is a per-key value, so it stays
  // one statement per affected product, and only for the rows this SELECT
  // proved are still unclassified: the steady state is zero, exactly the
  // #373 fill discipline.
  for (let i = 0; i < existingRows.length; i += SELECT_IN_CHUNK) {
    const chunk = existingRows.slice(i, i + SELECT_IN_CHUNK).map((row) => row.product_key)
    statements.push(
      db
        .prepare(
          `UPDATE price_products
           SET last_seen_at = ?, updated_at = ?
           WHERE product_key IN (${chunk.map(() => '?').join(',')})`
        )
        .bind(now, now, ...chunk)
    )
  }

  for (const row of existingRows) {
    if (row.category !== null) continue
    const item = itemByKey.get(row.product_key)
    if (!item?.category) continue
    // category and categoryVersion move together: an existing category was
    // not produced by this taxonomy version, so it keeps both of its values.
    statements.push(
      db
        .prepare(
          `UPDATE price_products
           SET category = ?, category_version = ?
           WHERE product_key = ? AND category IS NULL`
        )
        .bind(item.category, item.taxoVersion ?? null, row.product_key)
    )
  }

  // Contract §4.3 (pipeline #116): fill the size tuple once, when the stored row
  // has no size evidence at all. Never overwrite — a product created before
  // this writer becomes sized without a separate backfill, and a disagreeing
  // stored tuple is a logged conflict, not a failure. The UPDATE re-checks the
  // all-null guard so a retry (or a concurrent chunk) is a no-op instead of a
  // second write; the bump keeps an admin form opened before the fill from
  // overwriting the identity. One statement per filled product rides in the
  // existing statement batches — the 400-item budget test in
  // ingest-v2.test.ts pins that this stays under D1_QUERY_BUDGET.
  const storedSizeConflictLogged = new Set<string>()
  for (const row of existingRows) {
    const size = sizeByKey.get(row.product_key)
    if (!size) continue
    if (!hasNoSizeEvidence(row)) {
      if (!sameStoredSize(row, size) && !storedSizeConflictLogged.has(row.product_key)) {
        storedSizeConflictLogged.add(row.product_key)
        logSizeEvent('size_conflict', {
          productKey: row.product_key,
          against: 'stored',
          kept: {
            quantity: row.size_quantity,
            unit: row.size_unit,
            packCount: row.pack_count,
            totalQuantity: row.total_quantity,
            quantityMin: row.quantity_min,
            quantityMax: row.quantity_max,
          },
          ignored: size,
        })
      }
      continue
    }
    statements.push(
      db
        .prepare(
          `UPDATE price_products
           SET size_quantity = ?, size_unit = ?, pack_count = ?, total_quantity = ?,
               metadata_version = metadata_version + 1
           WHERE product_key = ?
             AND size_quantity IS NULL AND size_unit IS NULL AND pack_count IS NULL
             AND total_quantity IS NULL AND quantity_min IS NULL AND quantity_max IS NULL`
        )
        .bind(
          size.quantity,
          size.unit,
          size.packCount,
          size.quantity * size.packCount,
          row.product_key
        )
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

  // One statement per observation key: a payload repeating
  // (productKey, storeSlug, observedDate) upserts the same row, so emitting
  // both statements would inflate the receipt and spend query budget on a
  // no-op. The last item for a key wins, matching the statement order this
  // loop replaces.
  const observationByKey = new Map<string, IngestPayloadV2['items'][number]>()
  for (const item of payload.items) {
    const observationKey = [
      productIdByKey.get(item.productKey),
      sourceIdBySlug.get(item.storeSlug),
      item.observedDate ?? observedDefault,
    ].join('\u0000')
    observationByKey.set(observationKey, item)
  }

  for (const item of observationByKey.values()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO price_observations
             (id, product_id, source_id, observed_date, price, member_price, effective_unit_price,
              unit_qty, unit_qty_unit, unit_price,
              promo_type, promo_label, valid_from, valid_until, match_method,
              match_confidence, brochure_url, source_url, taxo_version,
              raw_name, raw_brand, raw_unit, page, ocr_model, scraped_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(product_id, source_id, observed_date) DO UPDATE SET
             price = excluded.price,
             member_price = excluded.member_price,
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
          // Issue #627: null when the payload predates the field or the
          // retailer prints no member price — never a zero.
          item.memberPrice ?? null,
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

  // One invocation, one D1 query budget: the reads above, one batch per 50
  // statements below, and the version read after them. Over the budget D1
  // stops the invocation part-way through the chunks — the earlier ones
  // committed, the bump (the last statement) never applied — so refuse here,
  // before the canonical write, instead of shipping content stamped with an
  // older indexVersion. The store upsert above is the only write that precedes
  // this check: idempotent price_sources metadata, outside the canonical index.
  // pipeline #116: a size/total fill is one more statement in the same list, so
  // `statements.length` already counts it; a 400-item warm payload that fills
  // every stored size is 25 statement batches and 33 queries in total, which
  // the mandatory budget test pins.
  assertQueryBudget(
    Math.ceil(payload.stores.length / BATCH_CHUNK) +
      (slugs.length ? Math.ceil(slugs.length / SELECT_IN_CHUNK) : 0) +
      (keys.length ? Math.ceil(keys.length / SELECT_IN_CHUNK) : 0) +
      Math.ceil(statements.length / BATCH_CHUNK) +
      1
  )

  await runBatch(db, statements)

  const state = await db
    .prepare('SELECT version FROM canonical_index_state WHERE id = 1')
    .first<{ version: number }>()
  const indexVersion = state?.version ?? 0

  // Parsed like the index: the pipeline validates the receipt and fails the
  // run on a mismatch (§5), so the backend must not be the one shipping a
  // shape it never checked — `skipped: literal(0)` included.
  return parse(ingestReceiptSchema, {
    schemaVersion: PIPELINE_CONTRACT_VERSION,
    scrapedAt: payload.scrapedAt,
    indexVersion,
    accepted: payload.items.length,
    skipped: 0,
    productsCreated: newKeys.length,
    observationsUpserted: observationByKey.size,
    products: keys.map((key) => ({
      productKey: key,
      productId: productIdByKey.get(key)!,
      status: existingKeys.has(key) ? 'existing' : 'created',
    })),
  })
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

// first_seen_at/last_seen_at/updated_at are nullable TEXT with no format
// constraint, so the index normalizes what it reads instead of trusting a
// writer: a bare date is midnight UTC, SQLite's `datetime('now')` form
// ('YYYY-MM-DD HH:MM:SS') takes the T/Z, an ISO value passes through, and an
// unparseable value falls back rather than failing the whole snapshot.
function asIsoTimestamp(value: string | null, fallback: string): string {
  if (!value) return fallback
  if (DATE_ONLY_RE.test(value)) return `${value}T00:00:00Z`
  if (value.includes('T')) return value
  const withT = `${value.replace(' ', 'T')}Z`
  return Number.isNaN(Date.parse(withT)) ? fallback : withT
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
  // One batch, one transaction: the version and the rows it stamps are read
  // from the same snapshot. Read separately, a concurrent ingest committing
  // between the two statements ships newer rows under an older version, and
  // the pipeline (§6.3) treats an equal version as "my cached copy is still
  // valid" — so it would keep the stale content forever.
  const [stateResult, productResult, aliasResult] = (await db.batch([
    db.prepare('SELECT version FROM canonical_index_state WHERE id = 1'),
    db.prepare(
      `SELECT id, product_key, name, brand, product_type, variant, size_quantity,
              size_unit, pack_count, total_quantity, packaging, quantity_min,
              quantity_max, description, category, category_version, status,
              metadata_version, first_seen_at, last_seen_at, updated_at
       FROM price_products
       ORDER BY product_key`
    ),
    db.prepare(
      `SELECT product_id, name, store_slug, first_seen_at, last_seen_at, source
       FROM price_product_aliases
       WHERE status = 'approved'
       ORDER BY product_id, name`
    ),
  ])) as { results?: unknown[] }[]

  const state = (stateResult?.results?.[0] ?? null) as { version: number } | null
  const products = (productResult?.results ?? []) as ProductRow[]
  const aliases = (aliasResult?.results ?? []) as AliasRow[]

  const aliasesByProduct = new Map<string, CanonicalProduct['aliases']>()
  for (const alias of aliases) {
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
    products: products.map((row) => ({
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

  const parsed = safeParse(canonicalIndexSchema, index)
  if (!parsed.success) {
    const issues = parsed.issues.map((issue) => ({
      path: (issue.path ?? []).map((item) => item.key),
      message: issue.message,
    }))
    const badIndex = issues.find(
      (issue) => issue.path[0] === 'products' && typeof issue.path[1] === 'number'
    )?.path[1]
    const productId = typeof badIndex === 'number' ? (products[badIndex]?.id ?? 'unknown') : 'index'
    // Server-side only: the rows are the pipeline's input, and the message a
    // valibot error would put in the response describes internal data.
    console.error(
      '[canonical-index] the canonical index does not match the contract',
      JSON.stringify({ productId, issues: issues.slice(0, 10) })
    )
    throw new CanonicalIndexIntegrityError(
      productId,
      issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    )
  }
  return parsed.output
}
