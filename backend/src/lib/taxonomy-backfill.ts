// Replay-backfill storage (issue #373, checklist item 5): classify
// historical price_observations by product name and write the answers back —
// the derived layer only, never a re-scrape. The classifier itself lives in
// the scraper (groceries/scraper src/categorize, PR 2); this module is the
// Worker side the offline job talks to:
//
//   1. listUncategorizedProducts — the job's work list: product keys + names
//      still missing a category, keyset-stable page walk (ORDER BY
//      product_key, offset pagination like the review queue — rows LEAVE the
//      list as the job fills them, so an offset page walk is honest only
//      against a static snapshot; the job therefore re-reads page 0 until it
//      returns empty, which also makes it restart-safe for free).
//   2. applyCategoryBackfill — the answers: fill the product's NULL category
//      and stamp its observations' NULL taxo_version. Both writes are
//      guarded by `IS NULL`, so a re-run (crash retry, whole-job replay) is
//      an idempotent no-op, and a value the live gate=on ingest already
//      wrote is never clobbered.

import type { BackfillCategoriesPayload } from '@rumaq/contract'

export type BackfillProduct = {
  productKey: string
  name: string
}

export type BackfillQueuePage = {
  products: BackfillProduct[]
  /** Whether another page exists at this offset (the walk's stop signal). */
  hasMore: boolean
}

// The job walks in D1-safe page sizes; 200 keeps the response well under the
// ingest-adjacent sizes the Worker already serves.
export const BACKFILL_QUEUE_PAGE = 200

export async function listUncategorizedProducts(
  db: D1Database,
  options: { limit?: number; offset?: number } = {}
): Promise<BackfillQueuePage> {
  const limit = Math.min(Math.max(options.limit ?? BACKFILL_QUEUE_PAGE, 1), BACKFILL_QUEUE_PAGE)
  const offset = Math.max(options.offset ?? 0, 0)
  // LIMIT +1 so hasMore is precise (a 201st row existed) without a count
  // query — the job only needs "is there more", never the total.
  const { results } = await db
    .prepare(
      `SELECT product_key, name FROM price_products
       WHERE category IS NULL
       ORDER BY product_key ASC
       LIMIT ? OFFSET ?`
    )
    .bind(limit + 1, offset)
    .all<{ product_key: string; name: string }>()

  const rows = results ?? []
  return {
    products: rows.slice(0, limit).map((row) => ({ productKey: row.product_key, name: row.name })),
    hasMore: rows.length > limit,
  }
}

export type BackfillResult = {
  /** Products whose NULL category this call filled. */
  productsUpdated: number
  /** Observations whose NULL taxo_version this call stamped. */
  observationsStamped: number
  /** Keys the payload carried that match no known product. */
  unknownProducts: number
}

// Same budget math as ingest.ts: one db.batch() is one query against D1's
// per-invocation limit; the payload cap (500 items) fits 10 statements per
// two-statement product, well under both the query and bind limits.
const BATCH_CHUNK = 50

type Statement = ReturnType<D1Database['prepare']>

export async function applyCategoryBackfill(
  db: D1Database,
  payload: BackfillCategoriesPayload
): Promise<BackfillResult> {
  if (payload.items.length === 0) {
    return { productsUpdated: 0, observationsStamped: 0, unknownProducts: 0 }
  }

  // Resolve which keys exist first: unknown keys are counted, never fatal —
  // a catalog pruned between the queue read and the write-back must not
  // 500 the whole idempotent batch.
  const keys = [...new Set(payload.items.map((item) => item.productKey))]
  const knownRows: Array<{ id: string; product_key: string }> = []
  const SELECT_IN_CHUNK = 90
  for (let i = 0; i < keys.length; i += SELECT_IN_CHUNK) {
    const chunk = keys.slice(i, i + SELECT_IN_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await db
      .prepare(`SELECT id, product_key FROM price_products WHERE product_key IN (${placeholders})`)
      .bind(...chunk)
      .all<{ id: string; product_key: string }>()
    knownRows.push(...(results ?? []))
  }
  const productIdByKey = new Map(knownRows.map((row) => [row.product_key, row.id]))
  const knownItems = payload.items.filter((item) => productIdByKey.has(item.productKey))
  const unknownProducts = payload.items.length - knownItems.length

  if (knownItems.length === 0) {
    return { productsUpdated: 0, observationsStamped: 0, unknownProducts }
  }

  const statements: Statement[] = []
  for (const item of knownItems) {
    statements.push(
      db
        .prepare(
          `UPDATE price_products SET category = ? WHERE product_key = ? AND category IS NULL`
        )
        .bind(item.category, item.productKey)
    )
    statements.push(
      db
        .prepare(
          `UPDATE price_observations SET taxo_version = ?
           WHERE product_id = ? AND taxo_version IS NULL`
        )
        .bind(payload.taxoVersion, productIdByKey.get(item.productKey)!)
    )
  }
  const results = []
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    results.push(...(await db.batch(statements.slice(i, i + BATCH_CHUNK))))
  }

  // D1's batch results carry meta.changes per statement; a missing/odd meta
  // (fake db in tests, engine drift) degrades to 0 for that statement — the
  // counters are observability, the writes are the contract.
  let productsUpdated = 0
  let observationsStamped = 0
  for (let i = 0; i < results.length; i++) {
    const changes = Number(
      (results[i] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0
    )
    if (i % 2 === 0) productsUpdated += changes
    else observationsStamped += changes
  }

  return { productsUpdated, observationsStamped, unknownProducts }
}
