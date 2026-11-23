import { SCRAPE_STORE_SLUGS } from '@rumaq/contract'

import { changesOf } from './scrape.js'
import { indexBumpStatement } from './canonical-products.js'

// The store-scoped ingest wipe (ahaqqu/RumaQ#753, fill-phase toolkit): the
// FIRST bulk DELETE surface in the product. Before a re-ingest command runs,
// the owner can wipe one store's ingest rows so the fill loop re-derives
// everything from the fresh push instead of fighting stale catalog rows.
//
// The blast radius is exactly the named store's observations plus the products
// that would be orphaned by deleting them. Everything else on the price graph
// keeps its referential duty, which fixes the statement ORDER inside the one
// transaction (D1 runs a batch as ONE SQL transaction, sequentially and
// non-concurrently — the same primitive createScrapeCommand leans on):
//
//   0. capture — read the store's observation count and the DISTINCT product
//      ids its observations point at. Runs BEFORE the batch because a DELETE
//      statement has no memory: once the observations are gone, "which
//      products did they reference" is unanswerable inside SQL.
//   1. plan_items  — NULL the grounded-price references that point at the
//      observations about to die (0007's FK has no ON DELETE, so an un-nulled
//      reference fails the whole wipe under FK enforcement). The plan ITEM
//      survives — only its price-provenance link is dropped; plan data is
//      household data, never scrape data.
//   2. price_observations — the store's rows go (source_id via
//      price_sources.slug). Products still exist, so the product FK holds;
//      price_sources survives (it carries the source's name/kind metadata and
//      re-ingest upserts it anyway).
//   3. price_products — only the products captured in step 0 whose LAST
//      observations were this store's: the captured-ids scope plus a NOT
//      EXISTS re-check inside the statement. The re-check is the race guard —
//      a concurrent ingest that added a non-store observation between the
//      capture and this batch makes the product survive. Approved/candidate
//      aliases cascade with their product (0030's ON DELETE CASCADE);
//      match_review_items and its verdicts are NOT touched (plain-text keys,
//      no FK — the 0054 receipt convention keeps review history readable even
//      when the pair's rows are gone).
//   4. ingest_wipe_audit — the receipt (0055), SAME transaction: a wipe that
//      half-ran must never be invisible.
//   5. canonical_index_state — the family's receipt-gated bump: deleted
//      products/aliases invalidate the pipeline's cached canonical index.
//      Always armed on a wipe (even a no-op), because "index unchanged after
//      a wipe" is a claim only the refetch can make cheap.
//
// The counts freeze into the receipt in a follow-up single-row UPDATE (same
// call, not the same transaction): D1 batches cannot feed one statement's
// meta.changes into a later statement's binds, and an all-subquery INSERT
// would re-bind every captured id twice — past D1's 100-parameter statement
// cap for any real store. The atomicity that matters holds: deletes, receipt
// existence and the index bump commit together or not at all; a crash in the
// millisecond before the counts UPDATE leaves a RECEIPT with zero counts
// (store, actor and moment still recorded), never a wipe without a receipt.
//
// The wipe is single-store BY CONTRACT (the create schema's check rejects
// multi-store wipes), so the capture is one store's worth of product ids,
// chunked under the same parameter cap in the DELETEs.

/** D1 caps bound parameters per statement; the id chunks stay far under it. */
const ID_CHUNK_SIZE = 90

export type IngestWipeResult = {
  /** The receipt id written to ingest_wipe_audit (the audit handle). */
  receiptId: string
  storeSlug: string
  observationsDeleted: number
  productsDeleted: number
}

/**
 * Wipes one store's ingest rows inside one transaction and writes the receipt.
 * Unknown slugs refuse up front (the picklist already rejects them at the
 * route — this guard protects any future caller of the lib). An empty store
 * is a no-op that still writes its zero-count receipt.
 */
export async function wipeStoreIngest(
  db: D1Database,
  { storeSlug, actorUserId }: { storeSlug: string; actorUserId: string }
): Promise<IngestWipeResult> {
  if (!(SCRAPE_STORE_SLUGS as readonly string[]).includes(storeSlug)) {
    throw new Error(`ingest wipe: unknown store slug "${storeSlug}"`)
  }

  // Step 0 — capture what the store's observations point at, before any of
  // them is gone.
  const productsResult = await db
    .prepare(
      `SELECT DISTINCT o.product_id AS id
       FROM price_observations o
       JOIN price_sources s ON s.id = o.source_id
       WHERE s.slug = ?`
    )
    .bind(storeSlug)
    .all<{ id: string }>()
  const productIds = (productsResult.results ?? []).map((row) => row.id)

  const receiptId = crypto.randomUUID()
  const statements: D1PreparedStatement[] = [
    // 1 — plan items lose only their provenance link (FK duty first).
    db
      .prepare(
        `UPDATE plan_items SET price_observation_id = NULL
         WHERE price_observation_id IN (
           SELECT o.id FROM price_observations o
           JOIN price_sources s ON s.id = o.source_id
           WHERE s.slug = ?
         )`
      )
      .bind(storeSlug),
    // 2 — the store's observations (products still exist, FK holds).
    db
      .prepare(
        `DELETE FROM price_observations
         WHERE source_id IN (SELECT id FROM price_sources WHERE slug = ?)`
      )
      .bind(storeSlug),
  ]

  // 3 — the newly-orphaned products, chunked under the bind limit. The NOT
  // EXISTS re-check means a captured id that gained a non-store observation
  // since the capture survives, and a product of ANOTHER store is never in
  // the list in the first place.
  for (let i = 0; i < productIds.length; i += ID_CHUNK_SIZE) {
    const chunk = productIds.slice(i, i + ID_CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(', ')
    statements.push(
      db
        .prepare(
          `DELETE FROM price_products
           WHERE id IN (${placeholders})
             AND NOT EXISTS (
               SELECT 1 FROM price_observations WHERE product_id = price_products.id
             )`
        )
        .bind(...chunk)
    )
  }

  // 4 — the receipt lands in the SAME transaction as the deletes it describes
  // (counts ride the follow-up UPDATE — see the module comment).
  statements.push(
    db
      .prepare(
        `INSERT INTO ingest_wipe_audit
           (id, store_slug, actor_user_id, observations_deleted, products_deleted)
         VALUES (?, ?, ?, 0, 0)`
      )
      .bind(receiptId, storeSlug, actorUserId)
  )
  // 5 — the receipt-gated canonical-index bump (the merge/rename convention):
  // runs after the receipt INSERT inside the batch, so the EXISTS gate sees it.
  statements.push(indexBumpStatement(db, receiptId, 'ingest_wipe_audit'))

  const results = await db.batch(statements)
  // Statement offsets: 0 plan_items, 1 observations, then the product chunks.
  const chunkResults = results.slice(2, 2 + Math.ceil(productIds.length / ID_CHUNK_SIZE))
  const productsDeleted = chunkResults.reduce((sum, result) => sum + changesOf(result), 0)
  const observationsDeleted = changesOf(results[1])

  await db
    .prepare(
      `UPDATE ingest_wipe_audit
       SET observations_deleted = ?, products_deleted = ?
       WHERE id = ?`
    )
    .bind(observationsDeleted, productsDeleted, receiptId)
    .run()

  return { receiptId, storeSlug, observationsDeleted, productsDeleted }
}
