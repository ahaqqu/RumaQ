// The observation registry merge (ahaqqu/RumaQ#744, owner decision OQ8
// 2026-11-22: option 1 — re-point price observations at merge-approval time).
// When a review pair is approved, the ENTRY side's product identity is
// absorbed into the ITEM side's survivor: observations re-point (product_id
// only — prices, member_price, original_price and provenance ride untouched),
// alias spellings move with their status preserved, the absorbed price_products
// row is DELETEd (owner decision: no 'superseded' status — the contract's
// 3-value picklist and every price read path stay untouched), and ONE
// price_product_merge_audit receipt records the collapse.
//
// EVERY approval writer calls this module — the human decide route
// (lib/match-review.ts), the AI auto-apply sweep and the cached-verdict apply
// (lib/review-ai.ts) — and the merge statements ride the SAME db.batch as the
// decision write, so an approval can never commit without its merge (the
// ticket's "observations never orphan" property; a post-commit side effect
// would have a crash window the auto sweep's pending-CAS makes permanent).
// The bulk-taxonomy acknowledgement is a self-pair writer: the equal-keys
// guard makes it a natural no-op, so it does not route through here at all.
//
// Semantics are set-based SQL (one batch, ~8 statements for the common
// single-row absorb): no per-observation loop, no read-path changes, and the
// re-point writes ONLY product_id (QA-07: original_price/member_price are
// plain observation columns a merge never rewrites — deleted collision rows
// are duplicate (product, source, date) rows by definition and their ids are
// in the receipt).
//
// Idempotency is the receipt gate (the decideAlias/override pattern of
// re-proving state, never changes()-chasing): the receipt INSERT's WHERE must
// hold IN THIS TRANSACTION — the absorbed row still exists, the survivor still
// exists, and this batch's own decision landed approved — so a re-approval, a
// double-merge, or a lost race inserts no receipt, bumps no index, and the
// gated merge statements no-op on the already-absorbed rows.
// Merge-of-a-merge composes: keys resolve through
// the receipt chain (union-find over to_product_key edges), so approving a
// pair whose either side was absorbed earlier lands on the live root.

import { indexBumpStatement } from './canonical-products.js'
import { selectIn, type Statement } from './d1.js'

/** One decision's registry numbers, read back from the receipt it wrote. */
export type MergeReceiptCounts = {
  /** Observations re-pointed to the survivor (S3's row count). */
  repointed: number
  /** Same-(source, date) collision observations deleted (the survivor's row wins). */
  dropped: number
  /** Alias spellings transferred with status preserved. */
  movedAliases: number
}

/** The frozen product identity a plan or receipt carries. */
export type ProductHandle = {
  id: string
  productKey: string
  name: string | null
}

/**
 * What the pre-read resolved for one review pair. `merge` carries the live
 * rows the batch will move (absorbed in chain order — the entry key first,
 * the chain ROOT last, because the root is where the identity currently
 * lives and its row is the one the receipt freezes); every `noop` kind is a
 * silent skip except `missing_survivor`, which the planner warns about.
 */
export type MergePlan =
  | { kind: 'merge'; survivor: ProductHandle; absorbed: ProductHandle[] }
  | { kind: 'noop'; reason: 'equal_keys' | 'missing_survivor' | 'nothing_to_absorb' }

/** The pair keys one review item contributes to the registry planning read. */
export type MergePairKeys = {
  itemId: string
  itemProductKey: string
  entryProductKey: string
}

/** The receipt chain resolves at most this many hops — past it the catalog is
 * malformed and the merge refuses (a hard error, per the design's union-find
 * bound) instead of looping forever. */
const MAX_CHAIN_HOPS = 10

/** Per-absorbed-row statement cost bound: each absorbed row spends 6
 * statements and the batch must stay under BATCH_CHUNK (50) with the writer's
 * own decision statements and the receipt + bump. */
const MAX_ABSORBED_ROWS = 8

export class MergeChainTooDeepError extends Error {
  constructor(readonly productKey: string) {
    super(`Merge receipt chain from '${productKey}' exceeds ${MAX_CHAIN_HOPS} hops`)
    this.name = 'MergeChainTooDeepError'
  }
}

type EdgeRow = {
  from_product_key: string
  to_product_key: string
  created_at: string
  id: string
}

/**
 * The latest receipt edge leaving each key, keyed `from_product_key`. A key
 * can carry more than one receipt over its life (a zombie re-create absorbed
 * by a later re-approval), so ties resolve newest-first — created_at is
 * datetime('now') (second resolution) and the id breaks same-second ties.
 */
function latestEdges(rows: EdgeRow[]): Map<string, EdgeRow> {
  const latest = new Map<string, EdgeRow>()
  for (const row of rows) {
    const current = latest.get(row.from_product_key)
    if (
      !current ||
      row.created_at > current.created_at ||
      (row.created_at === current.created_at && row.id > current.id)
    ) {
      latest.set(row.from_product_key, row)
    }
  }
  return latest
}

/**
 * Walk the receipt chain from `key` to its live root (union-find over the
 * edges). `edges` may be partial — keys discovered mid-walk that have no edge
 * in the map are gathered into `missing` so the caller can fetch one more
 * page instead of the planner re-querying per hop. The walk also terminates
 * with a hard error past MAX_CHAIN_HOPS edges: a cycle or an over-deep chain
 * is a malformed receipt trail, never something to merge across.
 */
function walkChain(
  key: string,
  edges: Map<string, EdgeRow>,
  missing: Set<string>
): { chain: string[]; root: string } {
  const chain = [key]
  let current = key
  for (;;) {
    const edge = edges.get(current)
    if (!edge) {
      missing.add(current)
      return { chain, root: current }
    }
    current = edge.to_product_key
    chain.push(current)
    // chain.length = hops + 1; past the bound the trail is malformed.
    if (chain.length > MAX_CHAIN_HOPS + 1) throw new MergeChainTooDeepError(key)
  }
}

async function fetchEdges(db: D1Database, keys: string[]): Promise<Map<string, EdgeRow>> {
  if (keys.length === 0) return new Map()
  const rows = await selectIn<EdgeRow>(
    db,
    `SELECT from_product_key, to_product_key, created_at, id
     FROM price_product_merge_audit
     WHERE from_product_key IN`,
    keys
  )
  return latestEdges(rows)
}

type ProductRow = {
  id: string
  product_key: string
  name: string | null
}

async function fetchProductRows(db: D1Database, keys: string[]): Promise<Map<string, ProductRow>> {
  if (keys.length === 0) return new Map()
  const rows = await selectIn<ProductRow>(
    db,
    `SELECT id, product_key, name FROM price_products WHERE product_key IN`,
    keys
  )
  return new Map(rows.map((row) => [row.product_key, row]))
}

/**
 * Resolve the registry plan for ONE review pair — the human decide route's
 * entry point. Survivor = the item-side identity resolved to its live root;
 * absorbed = every live row along the entry-side receipt chain (the root
 * included — that is where the identity's rows live now — minus the survivor
 * itself). Guards, in order: equal keys, missing survivor row (warned),
 * nothing to absorb.
 */
export async function planProductMerge(
  db: D1Database,
  itemProductKey: string,
  entryProductKey: string
): Promise<MergePlan> {
  const plans = await planProductMerges(db, [{ itemId: '', itemProductKey, entryProductKey }])
  return plans.get('')!
}

/**
 * Resolve registry plans for MANY review pairs in two shared reads (one
 * chunked edge read + one chunked product read, plus bounded follow-ups for
 * multi-hop chains) — the sweep's pre-read, so a 20-item tick spends 2
 * queries on planning instead of 2 per item. Equal-key pairs (the taxonomy
 * self-pairs) resolve to `equal_keys` without touching the database.
 */
export async function planProductMerges(
  db: D1Database,
  pairs: MergePairKeys[]
): Promise<Map<string, MergePlan>> {
  const plans = new Map<string, MergePlan>()

  // Guard 1 — equal keys (self-pairs carry no identity question). Resolved
  // BEFORE any read: the taxonomy ack path never even reaches for the db.
  const open = pairs.filter((pair) => {
    if (pair.itemProductKey === pair.entryProductKey) {
      plans.set(pair.itemId, { kind: 'noop', reason: 'equal_keys' })
      return false
    }
    return true
  })
  if (open.length === 0) return plans

  // The receipt chains. Follow-ups fetch edges for keys the first page
  // discovered mid-walk (multi-hop chains only; the common chain is one hop
  // or none and this loop runs zero extra times). `queried` keeps roots —
  // keys with no outgoing edge at all — out of the follow-up pages forever.
  const initialKeys = open.flatMap((pair) => [pair.itemProductKey, pair.entryProductKey])
  const edges = await fetchEdges(db, initialKeys)
  const queried = new Set<string>(initialKeys)
  const missing = new Set<string>()
  const chains = new Map<string, { itemChain: string[]; entryChain: string[] }>()
  for (const pair of open) {
    const item = walkChain(pair.itemProductKey, edges, missing)
    const entry = walkChain(pair.entryProductKey, edges, missing)
    chains.set(pair.itemId, { itemChain: item.chain, entryChain: entry.chain })
  }
  for (let round = 0; round < MAX_CHAIN_HOPS && missing.size > 0; round += 1) {
    for (const key of [...missing]) {
      if (queried.has(key)) missing.delete(key)
    }
    if (missing.size === 0) break
    const batch = [...missing]
    missing.clear()
    for (const key of batch) queried.add(key)
    const found = await fetchEdges(db, batch)
    for (const { itemChain, entryChain } of chains.values()) {
      const item = walkChain(itemChain[itemChain.length - 1]!, found, missing)
      const entry = walkChain(entryChain[entryChain.length - 1]!, found, missing)
      if (item.chain.length > 1) itemChain.push(...item.chain.slice(1))
      if (entry.chain.length > 1) entryChain.push(...entry.chain.slice(1))
    }
  }
  // The round budget is hop-exact: the worst case advances one hop per round
  // (initial hop + MAX_CHAIN_HOPS - 1 follow-ups reach any chain walkChain
  // permits), so anything still `missing` after a final queried-root filter
  // is a trail the walk genuinely could not resolve — over-deep or cyclic.
  // Without this second filter a legal chain whose ROOT was queried on the
  // last round would wedge here: the root's edge-less page re-adds it to
  // `missing` after the loop's own top-of-round filter has run.
  for (const key of [...missing]) {
    if (queried.has(key)) missing.delete(key)
  }
  if (missing.size > 0) {
    // The follow-up rounds could not reach a root — a malformed trail. Never
    // merge across a chain whose survivor is unresolved.
    throw new MergeChainTooDeepError([...missing][0]!)
  }

  // The live rows for every key the chains name, then the guard classification.
  const allKeys = new Set<string>()
  for (const { itemChain, entryChain } of chains.values()) {
    for (const key of [...itemChain, ...entryChain]) allKeys.add(key)
  }
  const rows = await fetchProductRows(db, [...allKeys])

  for (const [itemId, { itemChain, entryChain }] of chains) {
    const survivor = rows.get(itemChain[itemChain.length - 1]!)
    if (!survivor) {
      // Guard 2 — the item-side root has no live row (the pair came from the
      // pipeline catalog, so this is a stale/hand-made key). A review verdict
      // must never be blocked by registry state: no-op, warn, approval lands.
      console.warn(
        `[product-merge] survivor row missing for key '${itemChain[itemChain.length - 1]}' — merge skipped`
      )
      plans.set(itemId, { kind: 'noop', reason: 'missing_survivor' })
      continue
    }
    // Absorbed = every live row along the entry chain (root included), the
    // survivor itself excluded (an entry whose identity already lives under
    // the survivor has nothing left to move).
    const absorbed: ProductHandle[] = []
    const seen = new Set<string>([survivor.id])
    for (const key of entryChain) {
      const row = rows.get(key)
      if (row && !seen.has(row.id)) {
        seen.add(row.id)
        absorbed.push({ id: row.id, productKey: row.product_key, name: row.name })
      }
    }
    if (absorbed.length === 0) {
      // Guard 3 — re-approval of an already-absorbed pair (or an entry whose
      // chain is fully dead): silent no-op, no receipt, no bump.
      plans.set(itemId, { kind: 'noop', reason: 'nothing_to_absorb' })
      continue
    }
    plans.set(itemId, {
      kind: 'merge',
      survivor: { id: survivor.id, productKey: survivor.product_key, name: survivor.name },
      absorbed,
    })
  }
  return plans
}

/**
 * The merge statements for ONE review item, appended to the writer's decision
 * batch (never run alone, never chunked — the whole batch is one transaction).
 * Order inside the batch: the writer's decision statements first, then
 *
 *   R   receipt INSERT — computed from the PRE-merge state inside this
 *       transaction (counts and observation-id lists are exact at execution
 *       time, whatever ingested between the pre-read and the batch), gated on
 *       the state only a live merge can produce: the principal absorbed row
 *       still exists, the survivor still exists, and THIS batch's decision
 *       landed approved (the decided_at/decided_by marker — the same values
 *       the writer's own UPDATE just bound, so a lost decision race inserts
 *       nothing).
 *   P1  plan_items re-point off the collision observations about to be
 *       deleted (their FK is NO ACTION — migration 0007:46).
 *   P2  delete the absorbed (source, date) collisions — the survivor's row
 *       wins; UNIQUE(product_id, source_id, observed_date) would reject the
 *       re-point otherwise. SQLite checks uniqueness per-row on UPDATE, so
 *       this precedes P3.
 *   P3  the re-point itself: product_id ONLY.
 *   P4  delete aliases colliding with the survivor's (store_slug, name) — the
 *       survivor's spelling always wins (terminal: a rejected survivor
 *       spelling stays rejected).
 *   P5  move the remaining absorbed spellings, status preserved.
 *   P6  delete the absorbed identity row — the FK on price_observations is
 *       the storage-level proof that P3 moved everything. Gated on the
 *       receipt TOO: the identity collapse never happens unrecorded.
 *   B   the canonical-index bump, gated on the receipt (indexBumpStatement) —
 *       exactly one bump per committed receipt, or the pipeline's cached
 *       index keeps matching against the absorbed product.
 *
 * P1-P6 repeat per absorbed row (the zombie case adds rows to the chain).
 * Gating matrix, tuned per statement: R and P6 hang off the receipt's state
 * gates (a concurrent writer that absorbed the row first writes no receipt
 * and collapses nothing), P1-P5 hang off the decision marker ONLY — the
 * receipt's gates must NOT guard the re-point, because a survivor deleted
 * between the pre-read and this batch has to fail P3's FK (the design's
 * rollback-and-retry posture: the route 500s, the retry re-resolves the chain
 * through the receipt that deleted the survivor) rather than silently skip.
 * An undecided item fails every marker and turns the whole block into a
 * no-op.
 */
export function mergeStatements(
  db: D1Database,
  input: {
    reviewItemId: string
    /** Pre-generated receipt id — the batch's own read-back and the bump gate name it. */
    receiptId: string
    survivor: ProductHandle
    /** Chain order (entry key first, root last); the LAST row is the receipt's frozen identity. */
    absorbed: ProductHandle[]
    actorUserId: string
    decidedSource: 'human' | 'ai_assist' | 'ai_auto'
    /** The decision marker this batch's own UPDATE writes (the writer passes
     * the exact same binds), proving the merge rides a decision that landed. */
    decidedAt: string
    decidedBy: string
  }
): Statement[] {
  if (input.absorbed.length === 0) return []
  if (input.absorbed.length > MAX_ABSORBED_ROWS) {
    throw new Error(
      `merge absorbs ${input.absorbed.length} rows, over the ${MAX_ABSORBED_ROWS}-row one-batch bound`
    )
  }
  const s = input.survivor.id
  const principal = input.absorbed[input.absorbed.length - 1]!

  // The decision marker, repeated by every gated statement: the row THIS
  // batch just decided, proved by its exact decided_at/decided_by binds.
  const markerSql = `EXISTS (SELECT 1 FROM match_review_items
                 WHERE id = ? AND status = 'approved' AND decided_at = ? AND decided_by = ?)`
  const markerBinds = [input.reviewItemId, input.decidedAt, input.decidedBy]

  const absorbedValues = input.absorbed.map(() => '(?)').join(', ')
  const statements: Statement[] = []

  // R — the receipt (see the doc comment; the counts read the pre-merge state
  // of THIS transaction, so no pre-read of observation ids is needed and the
  // numbers are exact even when ingest raced the planner).
  statements.push(
    db
      .prepare(
        `WITH merge_absorbed(id) AS (VALUES ${absorbedValues})
         INSERT INTO price_product_merge_audit
           (id, review_item_id, from_product_id, from_product_key, from_product_name,
            to_product_id, to_product_key, actor_user_id, decided_source,
            repointed_observations, dropped_observations, moved_aliases,
            observation_ids, dropped_observation_ids)
         SELECT ?, ?, a.id, a.product_key, a.name, ?, ?, ?, ?,
                (SELECT COUNT(*) FROM price_observations o
                  WHERE o.product_id IN (SELECT id FROM merge_absorbed)
                    AND NOT EXISTS (SELECT 1 FROM price_observations s2
                          WHERE s2.product_id = ? AND s2.source_id = o.source_id
                            AND s2.observed_date = o.observed_date)),
                (SELECT COUNT(*) FROM price_observations o
                  WHERE o.product_id IN (SELECT id FROM merge_absorbed)
                    AND EXISTS (SELECT 1 FROM price_observations s2
                          WHERE s2.product_id = ? AND s2.source_id = o.source_id
                            AND s2.observed_date = o.observed_date)),
                (SELECT COUNT(*) FROM price_product_aliases al
                  WHERE al.product_id IN (SELECT id FROM merge_absorbed)
                    AND NOT EXISTS (SELECT 1 FROM price_product_aliases s3
                          WHERE s3.product_id = ? AND s3.store_slug = al.store_slug
                            AND s3.name = al.name)),
                (SELECT COALESCE(json_group_array(o.id), '[]') FROM price_observations o
                  WHERE o.product_id IN (SELECT id FROM merge_absorbed)
                    AND NOT EXISTS (SELECT 1 FROM price_observations s2
                          WHERE s2.product_id = ? AND s2.source_id = o.source_id
                            AND s2.observed_date = o.observed_date)),
                (SELECT COALESCE(json_group_array(o.id), '[]') FROM price_observations o
                  WHERE o.product_id IN (SELECT id FROM merge_absorbed)
                    AND EXISTS (SELECT 1 FROM price_observations s2
                          WHERE s2.product_id = ? AND s2.source_id = o.source_id
                            AND s2.observed_date = o.observed_date))
         FROM price_products a
         WHERE a.id = ?
           AND EXISTS (SELECT 1 FROM price_products WHERE id = ?)
           AND ${markerSql}`
      )
      .bind(
        ...input.absorbed.map((row) => row.id),
        input.receiptId,
        input.reviewItemId,
        s,
        input.survivor.productKey,
        input.actorUserId,
        input.decidedSource,
        // repointed / dropped counts and both id lists read the survivor id.
        s,
        s,
        s,
        s,
        s,
        principal.id,
        s,
        ...markerBinds
      )
  )

  // The receipt this batch just (conditionally) wrote — the gate every merge
  // statement and the bump hang off. One bind, reused below.
  const receiptGateSql = `EXISTS (SELECT 1 FROM price_product_merge_audit WHERE id = ?)`
  const receiptGateBinds = [input.receiptId]

  for (const absorbed of input.absorbed) {
    const a = absorbed.id
    // P1 — plan_items ride collision observations whose rows are about to be
    // deleted; they land on the survivor's same-(source, date) observation.
    // Subquery aliases are deliberately distinct (`s`/`ax`/`aw`/`s2`) —
    // defensive separation of the SET and WHERE scopes so no future edit can
    // make a name's resolution ambiguous; the plan-item test pins the
    // statement's semantics.
    statements.push(
      db
        .prepare(
          `UPDATE plan_items
           SET price_observation_id = (
                 SELECT s.id FROM price_observations s
                 JOIN price_observations ax ON ax.id = plan_items.price_observation_id
                 WHERE s.product_id = ? AND s.source_id = ax.source_id
                   AND s.observed_date = ax.observed_date
                 LIMIT 1
               )
           WHERE ${markerSql}
             AND price_observation_id IN (
                   SELECT aw.id FROM price_observations aw
                   WHERE aw.product_id = ?
                     AND EXISTS (SELECT 1 FROM price_observations s2
                                 WHERE s2.product_id = ? AND s2.source_id = aw.source_id
                                   AND s2.observed_date = aw.observed_date))`
        )
        // Bind order follows the SQL's placeholder order: the SET subquery's
        // survivor id comes first, then the marker, then the IN-subquery pair.
        .bind(s, ...markerBinds, a, s)
    )
    // P2 — the collision deletes (the survivor's row wins, deterministically).
    statements.push(
      db
        .prepare(
          `DELETE FROM price_observations
           WHERE ${markerSql}
             AND product_id = ?
             AND EXISTS (SELECT 1 FROM price_observations s
                         WHERE s.product_id = ? AND s.source_id = price_observations.source_id
                           AND s.observed_date = price_observations.observed_date)`
        )
        .bind(...markerBinds, a, s)
    )
    // P3 — the re-point: product_id ONLY (QA-07 — every other column rides).
    statements.push(
      db
        .prepare(
          `UPDATE price_observations
           SET product_id = ?
           WHERE ${markerSql}
             AND product_id = ?`
        )
        .bind(s, ...markerBinds, a)
    )
    // P4 — alias collisions; the survivor's spelling always wins.
    statements.push(
      db
        .prepare(
          `DELETE FROM price_product_aliases
           WHERE ${markerSql}
             AND product_id = ?
             AND EXISTS (SELECT 1 FROM price_product_aliases s
                         WHERE s.product_id = ? AND s.store_slug = price_product_aliases.store_slug
                           AND s.name = price_product_aliases.name)`
        )
        .bind(...markerBinds, a, s)
    )
    // P5 — the display-mapping transfer, status preserved.
    statements.push(
      db
        .prepare(
          `UPDATE price_product_aliases
           SET product_id = ?
           WHERE ${markerSql}
             AND product_id = ?`
        )
        .bind(s, ...markerBinds, a)
    )
    // P6 — the identity collapse; the FK (0007:27) proves P3 completed.
    statements.push(
      db
        .prepare(
          `DELETE FROM price_products
           WHERE ${receiptGateSql}
             AND ${markerSql}
             AND id = ?`
        )
        .bind(...receiptGateBinds, ...markerBinds, a)
    )
  }

  // B — exactly one index bump per committed receipt (the pipeline's cached
  // canonical index is the one real cache a merge must invalidate).
  statements.push(indexBumpStatement(db, input.receiptId, 'price_product_merge_audit'))
  return statements
}

/**
 * The batched read-back of the receipt a merge batch just wrote — appended as
 * the batch's LAST statement by the human decide route, whose response
 * surfaces the registry numbers (a no-op merge returns no row and the route
 * answers `registry: null`).
 */
export function mergeReceiptReadStatement(db: D1Database, receiptId: string): Statement {
  return db
    .prepare(
      `SELECT repointed_observations AS repointed,
              dropped_observations AS dropped,
              moved_aliases AS movedAliases
       FROM price_product_merge_audit
       WHERE id = ?`
    )
    .bind(receiptId)
}
