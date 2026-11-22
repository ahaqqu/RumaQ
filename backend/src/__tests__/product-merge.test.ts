// The observation registry merge (#744) against REAL SQLite: the batch's
// statement semantics — the collision delete, the FK-enforced plan_items
// re-point, the receipt's counts and id lists, the exactly-once index bump,
// the DELETE-CAS idempotency, the receipt-chain composition — are SQL and
// transaction behavior the string-matching fake db cannot pin. The adapter
// (support/d1-sqlite.ts) wraps db.batch in BEGIN/COMMIT/ROLLBACK and the
// suite opts into PRAGMA foreign_keys = ON, so the FK guards are proven, not
// assumed. The driver is the human decide path (lib/match-review.ts) — the
// product surface the merge rides.

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { createDb, type Db } from './support/d1-sqlite.js'
import { acknowledgePendingTaxonomy, decideReviewItem } from '../lib/match-review.js'
import { indexBumpStatement } from '../lib/canonical-products.js'
import { MergeChainTooDeepError, mergeStatements, planProductMerge } from '../lib/product-merge.js'
import type { ReviewItemPair } from '@rumaq/contract'

let sqlite: Db
let d1: D1Database

beforeEach(() => {
  const { sqlite: db, d1: adapter } = createDb()
  sqlite = db
  d1 = adapter
  // D1 enforces foreign keys; node:sqlite defaults them OFF. The plan_items
  // re-point, the absorbed-row delete and the concurrent-race rollback are FK
  // semantics — the whole point of running these on a real engine.
  sqlite.exec('PRAGMA foreign_keys = ON')
})

// --- fixtures ---------------------------------------------------------------

const SOURCE_ID = 'src-superindo'

function pair(overrides: Partial<ReviewItemPair> = {}): ReviewItemPair {
  return {
    itemProductKey: 'beras--ramos--5-kg',
    itemName: 'Beras Ramos 5 kg',
    itemPrice: 15000,
    itemStore: 'superindo',
    entryProductKey: 'beras--ramos--5kg',
    entryName: 'Beras Ramos 5kg',
    entryPrice: 15500,
    entryStore: 'superindo',
    matchMethod: 'embedding',
    confidence: 0.86,
    reason: 'price_ratio',
    ...overrides,
  }
}

function seedProduct(
  key: string,
  options: { id?: string; name?: string; status?: string } = {}
): string {
  const id = options.id ?? `prod-${key}`
  sqlite
    .prepare(
      `INSERT INTO price_products
         (id, product_key, name, brand, unit, status, metadata_version,
          first_seen_at, last_seen_at, updated_at)
       VALUES (?, ?, ?, 'Ramos', '5 kg', ?, 1,
               '2026-11-01T00:00:00Z', '2026-11-07T00:00:00Z', '2026-11-01T00:00:00Z')`
    )
    .run(id, key, options.name ?? 'Beras Ramos 5 kg', options.status ?? 'provisional')
  return id
}

function seedSource(): void {
  sqlite
    .prepare(`INSERT INTO price_sources (id, slug, name) VALUES (?, 'superindo', 'Superindo')`)
    .run(SOURCE_ID)
}

function seedObservation(
  productId: string,
  options: {
    id: string
    date?: string
    price?: number
    memberPrice?: number | null
    originalPrice?: number | null
  }
): string {
  sqlite
    .prepare(
      `INSERT INTO price_observations
         (id, product_id, source_id, observed_date, price, member_price, original_price,
          match_method, match_confidence, scraped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'exact', 0.9, '2026-11-07T01:00:00Z')`
    )
    .run(
      options.id,
      productId,
      SOURCE_ID,
      options.date ?? '2026-11-07',
      options.price ?? 15000,
      options.memberPrice ?? null,
      options.originalPrice ?? null
    )
  return options.id
}

function seedAlias(
  productId: string,
  name: string,
  options: { status?: string; store?: string; id?: string } = {}
): string {
  const id = options.id ?? `alias-${productId}-${name}`
  sqlite
    .prepare(
      `INSERT INTO price_product_aliases
         (id, product_id, store_slug, name, status, source, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, 'ocr', '2026-11-01T00:00:00Z', '2026-11-07T00:00:00Z')`
    )
    .run(id, productId, options.store ?? 'superindo', name, options.status ?? 'candidate')
  return id
}

function seedReviewItem(id: string, pairValue: ReviewItemPair): void {
  sqlite
    .prepare(
      `INSERT INTO match_review_items
         (id, item_product_key, entry_product_key, pair_data, reason, match_method,
          confidence, run_started_at, first_flagged_at, last_flagged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      pairValue.itemProductKey,
      pairValue.entryProductKey,
      JSON.stringify(pairValue),
      pairValue.reason,
      pairValue.matchMethod,
      pairValue.confidence,
      '2026-11-18T23:00:05Z',
      '2026-11-18T23:00:05Z',
      '2026-11-18T23:00:05Z'
    )
}

function seedPlanItemReferencing(observationId: string, id = 'plan-item-1'): void {
  sqlite.prepare(`INSERT INTO users (id, email) VALUES ('u-merge', 'merge@rumaq.dev')`).run()
  sqlite
    .prepare(`INSERT INTO households (id, name, created_by) VALUES ('h-merge', 'H', 'u-merge')`)
    .run()
  sqlite
    .prepare(`INSERT INTO plans (id, household_id, status) VALUES ('plan-1', 'h-merge', 'active')`)
    .run()
  sqlite
    .prepare(
      `INSERT INTO plan_items (id, plan_id, qty, price_observation_id) VALUES (?, 'plan-1', 1, ?)`
    )
    .run(id, observationId)
}

function receiptRows(): Array<Record<string, unknown>> {
  return sqlite.prepare('SELECT * FROM price_product_merge_audit').all()
}

function indexVersion(): number {
  return (
    sqlite.prepare('SELECT version FROM canonical_index_state WHERE id = 1').get() as {
      version: number
    }
  ).version
}

function counts(table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

// --- the happy path ---------------------------------------------------------

describe('product-merge: approval absorbs the entry identity (#744)', () => {
  it('re-points observations, moves aliases with status preserved, deletes the absorbed row, writes one receipt and bumps the index once', async () => {
    seedSource()
    const survivorId = seedProduct('beras--ramos--5-kg', { name: 'Beras Ramos 5 kg' })
    const absorbedId = seedProduct('beras--ramos--5kg', { name: 'Beras Ramos 5kg' })
    seedObservation(survivorId, { id: 'obs-s1', price: 15000 })
    seedObservation(absorbedId, {
      id: 'obs-a1',
      date: '2026-11-09',
      price: 15500,
      memberPrice: 14000,
      originalPrice: 17000,
    })
    seedObservation(absorbedId, { id: 'obs-a2', date: '2026-11-08', price: 15500 })
    seedAlias(survivorId, 'Beras Ramos 5 kg', { id: 'al-s1', status: 'approved' })
    seedAlias(absorbedId, 'Beras Ramos 5kg', { id: 'al-a1', status: 'approved' })
    seedAlias(absorbedId, 'Beras Ramos', { id: 'al-a2', status: 'candidate' })
    seedAlias(absorbedId, 'Beras Ramos Rejected', { id: 'al-a3', status: 'rejected' })
    seedReviewItem('rev-1', pair())

    const { item, registry } = await decideReviewItem(d1, 'rev-1', 'approved', 'admin-1')
    expect(item).toMatchObject({ id: 'rev-1', status: 'approved' })

    // The re-point: every surviving absorbed observation now belongs to the
    // survivor — product_id is the ONLY column that moved.
    expect(
      sqlite.prepare('SELECT id FROM price_observations WHERE product_id = ?').all(survivorId)
    ).toEqual([{ id: 'obs-s1' }, { id: 'obs-a1' }, { id: 'obs-a2' }])
    expect(counts('price_observations')).toBe(3)

    // QA-07: the moved rows are byte-identical apart from product_id —
    // member_price and original_price ride untouched.
    expect(
      sqlite
        .prepare('SELECT price, member_price, original_price FROM price_observations WHERE id = ?')
        .get('obs-a1')
    ).toEqual({ price: 15500, member_price: 14000, original_price: 17000 })

    // The display-mapping transfer: statuses preserved, no collisions left.
    const aliasStatuses = sqlite
      .prepare('SELECT name, status FROM price_product_aliases WHERE product_id = ? ORDER BY name')
      .all(survivorId)
    expect(aliasStatuses).toEqual([
      { name: 'Beras Ramos', status: 'candidate' },
      { name: 'Beras Ramos 5 kg', status: 'approved' },
      { name: 'Beras Ramos 5kg', status: 'approved' },
      { name: 'Beras Ramos Rejected', status: 'rejected' },
    ])
    expect(counts('price_product_aliases')).toBe(4)

    // The identity collapse (OQ-A: DELETE, no 'superseded' status).
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM price_products WHERE id = ?').get(absorbedId)
    ).toEqual({ n: 0 })
    expect(counts('price_products')).toBe(1)

    // One receipt, one bump.
    const receipts = receiptRows()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      review_item_id: 'rev-1',
      from_product_id: absorbedId,
      from_product_key: 'beras--ramos--5kg',
      from_product_name: 'Beras Ramos 5kg',
      to_product_id: survivorId,
      to_product_key: 'beras--ramos--5-kg',
      actor_user_id: 'admin-1',
      decided_source: 'human',
      repointed_observations: 2,
      dropped_observations: 0,
      moved_aliases: 3,
    })
    expect(indexVersion()).toBe(1)

    // The response's registry block carries the receipt's numbers.
    expect(registry).toEqual({ repointed: 2, dropped: 0, movedAliases: 3 })
  })

  it('deletes (source, date) collisions keeping the survivor row, and moves plan items off the deleted observation', async () => {
    seedSource()
    const survivorId = seedProduct('beras--ramos--5-kg')
    const absorbedId = seedProduct('beras--ramos--5kg')
    // The SAME (source, date) on both sides: UNIQUE(product_id, source_id,
    // observed_date) would reject the re-point, so the collision deletes
    // first and the ITEM side's row wins.
    const survivorObs = seedObservation(survivorId, {
      id: 'obs-s1',
      date: '2026-11-07',
      price: 15000,
    })
    const collision = seedObservation(absorbedId, {
      id: 'obs-a1',
      date: '2026-11-07',
      price: 15500,
      originalPrice: 17000,
    })
    seedObservation(absorbedId, { id: 'obs-a2', date: '2026-11-08', price: 15500 })
    // A household plan item grounded on the collision observation: its FK
    // (plan_items.price_observation_id, NO ACTION) must not block the delete,
    // and it lands on the survivor's same-(source, date) observation.
    seedPlanItemReferencing(collision)

    seedReviewItem('rev-1', pair())
    const { registry } = await decideReviewItem(d1, 'rev-1', 'approved', 'admin-1')

    expect(registry).toEqual({ repointed: 1, dropped: 1, movedAliases: 0 })
    expect(counts('price_observations')).toBe(2)
    expect(
      sqlite.prepare('SELECT id FROM price_observations WHERE product_id = ?').all(survivorId)
    ).toEqual([{ id: survivorObs }, { id: 'obs-a2' }])
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM price_observations WHERE id = ?').get(collision)
    ).toEqual({ n: 0 })

    // The grounded plan item survived the collision delete, re-pointed to the
    // survivor's same-store same-date sighting.
    expect(
      sqlite.prepare('SELECT price_observation_id FROM plan_items WHERE id = ?').get('plan-item-1')
    ).toEqual({ price_observation_id: survivorObs })

    const receipts = receiptRows()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ dropped_observations: 1, repointed_observations: 1 })
    expect(JSON.parse(String(receipts[0]!.observation_ids))).toEqual(['obs-a2'])
    expect(JSON.parse(String(receipts[0]!.dropped_observation_ids))).toEqual(['obs-a1'])
  })

  it('records a key-only absorption with zero counts and empty id lists', async () => {
    seedSource()
    seedProduct('beras--ramos--5-kg')
    seedProduct('beras--ramos--5kg')
    seedReviewItem('rev-1', pair())

    const { registry } = await decideReviewItem(d1, 'rev-1', 'approved', 'admin-1')
    expect(registry).toEqual({ repointed: 0, dropped: 0, movedAliases: 0 })
    expect(counts('price_products')).toBe(1)
    const receipts = receiptRows()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      repointed_observations: 0,
      dropped_observations: 0,
      moved_aliases: 0,
    })
    expect(receipts[0]!.observation_ids).toBe('[]')
    expect(receipts[0]!.dropped_observation_ids).toBe('[]')
    expect(indexVersion()).toBe(1)
  })
})

// --- idempotency ------------------------------------------------------------

describe('product-merge: idempotency (re-approval, double-merge)', () => {
  it('re-approving an already-absorbed pair is a no-op — no second receipt, no second bump', async () => {
    seedSource()
    seedProduct('beras--ramos--5-kg')
    seedProduct('beras--ramos--5kg')
    seedObservation(
      (
        sqlite
          .prepare('SELECT id FROM price_products WHERE product_key = ?')
          .get('beras--ramos--5kg') as { id: string }
      ).id,
      { id: 'obs-a1' }
    )
    seedReviewItem('rev-1', pair())

    const first = await decideReviewItem(d1, 'rev-1', 'approved', 'admin-1')
    expect(first.registry).toEqual({ repointed: 1, dropped: 0, movedAliases: 0 })

    // Last verdict wins by design; the registry has nothing left to absorb.
    const second = await decideReviewItem(d1, 'rev-1', 'approved', 'admin-2')
    expect(second.registry).toBeNull()
    expect(counts('price_products')).toBe(1)
    expect(counts('price_product_merge_audit')).toBe(1)
    expect(indexVersion()).toBe(1)
  })

  it("approving the same pair from a concurrent writer's footprint writes nothing (the DELETE CAS)", async () => {
    seedSource()
    seedProduct('beras--ramos--5-kg')
    seedProduct('beras--ramos--5kg')
    seedReviewItem('rev-1', pair())

    const plan = await planProductMerge(d1, pair().itemProductKey, pair().entryProductKey)
    expect(plan.kind).toBe('merge')
    // A concurrent writer merged first: the absorbed row is gone.
    sqlite.prepare('DELETE FROM price_products WHERE product_key = ?').run(pair().entryProductKey)

    const decidedAt = new Date().toISOString()
    const statements = [
      d1
        .prepare(
          `UPDATE match_review_items SET status = 'approved', decided_at = ?, decided_by = ?, decided_source = 'human' WHERE id = 'rev-1'`
        )
        .bind(decidedAt, 'admin-1'),
      ...mergeStatements(d1, {
        reviewItemId: 'rev-1',
        receiptId: 'rec-race',
        survivor: {
          id: (
            sqlite
              .prepare('SELECT id FROM price_products WHERE product_key = ?')
              .get(pair().itemProductKey) as { id: string }
          ).id,
          productKey: pair().itemProductKey,
          name: 'Beras Ramos 5 kg',
        },
        absorbed: [
          {
            id: 'prod-beras--ramos--5kg',
            productKey: pair().entryProductKey,
            name: 'Beras Ramos 5kg',
          },
        ],
        actorUserId: 'admin-1',
        decidedSource: 'human',
        decidedAt,
        decidedBy: 'admin-1',
      }),
      // The bump gated on the receipt — a lost race inserts no receipt, so
      // the version must not move either.
      indexBumpStatement(d1, 'rec-race', 'price_product_merge_audit'),
    ]
    await d1.batch(statements)

    expect(counts('price_product_merge_audit')).toBe(0)
    expect(indexVersion()).toBe(0)
    // The decision still landed (a verdict is never blocked by registry state).
    expect(
      sqlite.prepare('SELECT status FROM match_review_items WHERE id = ?').get('rev-1')
    ).toEqual({ status: 'approved' })
  })

  it('a merge statement block whose decision marker does not match writes nothing', async () => {
    seedSource()
    seedProduct('beras--ramos--5-kg')
    seedProduct('beras--ramos--5kg')
    seedReviewItem('rev-1', pair())
    // The item was decided by SOMEONE ELSE (different marker) — the merge
    // statements hang off the marker and the receipt gate, so a stale batch
    // must be inert.
    sqlite
      .prepare(
        `UPDATE match_review_items SET status = 'approved', decided_at = '2026-11-01T00:00:00.000Z', decided_by = 'other-admin', decided_source = 'human' WHERE id = 'rev-1'`
      )
      .run()

    const survivorId = (
      sqlite
        .prepare('SELECT id FROM price_products WHERE product_key = ?')
        .get('beras--ramos--5-kg') as { id: string }
    ).id
    await d1.batch(
      mergeStatements(d1, {
        reviewItemId: 'rev-1',
        receiptId: 'rec-stale',
        survivor: { id: survivorId, productKey: 'beras--ramos--5-kg', name: 'x' },
        absorbed: [{ id: 'prod-beras--ramos--5kg', productKey: 'beras--ramos--5kg', name: 'y' }],
        actorUserId: 'admin-1',
        decidedSource: 'human',
        decidedAt: '2026-11-22T00:00:00.000Z',
        decidedBy: 'admin-1',
      })
    )
    expect(counts('price_product_merge_audit')).toBe(0)
    expect(counts('price_products')).toBe(2)
    expect(indexVersion()).toBe(0)
  })
})

// --- composition ------------------------------------------------------------

describe('product-merge: merge-of-a-merge and zombies', () => {
  it('approving (B, C) after B was absorbed into A absorbs C into A via the receipt chain', async () => {
    seedSource()
    const aId = seedProduct('key--a', { name: 'A' })
    const bId = seedProduct('key--b', { name: 'B' })
    const cId = seedProduct('key--c', { name: 'C' })
    seedObservation(cId, { id: 'obs-c1', price: 12000 })

    // First merge: B absorbed into A (the receipt chain's edge B→A).
    seedReviewItem('rev-ab', pair({ itemProductKey: 'key--a', entryProductKey: 'key--b' }))
    await decideReviewItem(d1, 'rev-ab', 'approved', 'admin-1')
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM price_products WHERE id = ?').get(bId)
    ).toEqual({ n: 0 })

    // The pair (B, C) — B's row is gone; the chain resolves B's identity to A.
    seedReviewItem(
      'rev-bc',
      pair({
        itemProductKey: 'key--b',
        entryProductKey: 'key--c',
        entryName: 'C',
        entryPrice: 12000,
      })
    )
    const { registry } = await decideReviewItem(d1, 'rev-bc', 'approved', 'admin-1')
    expect(registry).toEqual({ repointed: 1, dropped: 0, movedAliases: 0 })

    // C's rows live under A; C's row is gone; the receipt names C→A.
    expect(
      sqlite.prepare('SELECT id FROM price_observations WHERE product_id = ?').all(aId)
    ).toEqual([{ id: 'obs-c1' }])
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM price_products WHERE id = ?').get(cId)
    ).toEqual({ n: 0 })
    const receipts = receiptRows()
    expect(receipts).toHaveLength(2)
    expect(receipts[1]).toMatchObject({
      review_item_id: 'rev-bc',
      from_product_id: cId,
      from_product_key: 'key--c',
      to_product_id: aId,
      to_product_key: 'key--a',
    })
    expect(indexVersion()).toBe(2)
  })

  it('absorbs a zombie re-create of an absorbed key on re-approval', async () => {
    seedSource()
    const aId = seedProduct('key--a', { name: 'A' })
    seedProduct('key--e', { name: 'E' })
    seedReviewItem('rev-1', pair({ itemProductKey: 'key--a', entryProductKey: 'key--e' }))
    await decideReviewItem(d1, 'rev-1', 'approved', 'admin-1')
    expect(indexVersion()).toBe(1)

    // A stale pipeline re-emits the absorbed key: ingest re-creates the row
    // (and re-flags the SAME pair — the natural key upserts, never reopens).
    const zombieId = seedProduct('key--e', { name: 'E (zombie)' })
    seedObservation(zombieId, { id: 'obs-z1', price: 13000 })

    // The re-approval (last verdict wins) re-runs the merge; the chain
    // resolves the entry key through the first receipt to the survivor.
    const { registry } = await decideReviewItem(d1, 'rev-1', 'approved', 'admin-1')
    expect(registry).toEqual({ repointed: 1, dropped: 0, movedAliases: 0 })
    expect(
      sqlite.prepare('SELECT id FROM price_observations WHERE product_id = ?').all(aId)
    ).toEqual([{ id: 'obs-z1' }])
    expect(counts('price_products')).toBe(1)
    expect(counts('price_product_merge_audit')).toBe(2)
    expect(indexVersion()).toBe(2)
  })

  it('composes merges through the receipt chain — an entry whose identity lives under an earlier survivor moves the whole group', async () => {
    seedSource()
    const aId = seedProduct('key--a', { name: 'A' })
    const bId = seedProduct('key--b', { name: 'B' })
    const cId = seedProduct('key--c', { name: 'C' })
    const dId = seedProduct('key--d', { name: 'D' })
    seedObservation(aId, { id: 'obs-a1', date: '2026-11-06', price: 11000 })
    seedObservation(cId, { id: 'obs-c1', date: '2026-11-07', price: 13000 })

    // 1. (A, B) approved: B absorbed into A. B has nothing to move yet.
    seedReviewItem('rev-ab', pair({ itemProductKey: 'key--a', entryProductKey: 'key--b' }))
    const first = await decideReviewItem(d1, 'rev-ab', 'approved', 'admin-1')
    expect(first.registry).toEqual({ repointed: 0, dropped: 0, movedAliases: 0 })
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM price_products WHERE id = ?').get(bId)
    ).toEqual({ n: 0 })

    // 2. (C, B) approved: B's identity lives at A (the receipt chain's root),
    //    so the merge absorbs A's live row into C — obs-a1 re-points to C and
    //    A's row is deleted. Receipt: from=A, to=C.
    seedReviewItem('rev-cb', pair({ itemProductKey: 'key--c', entryProductKey: 'key--b' }))
    const second = await decideReviewItem(d1, 'rev-cb', 'approved', 'admin-1')
    expect(second.registry).toEqual({ repointed: 1, dropped: 0, movedAliases: 0 })
    expect(
      sqlite.prepare('SELECT id FROM price_observations WHERE product_id = ?').all(cId)
    ).toEqual([{ id: 'obs-a1' }, { id: 'obs-c1' }])
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM price_products WHERE id = ?').get(aId)
    ).toEqual({ n: 0 })

    // 3. (D, C) approved: C's chain is still just C (it was never absorbed) —
    //    C's rows move to D and C's row is deleted.
    seedReviewItem('rev-dc', pair({ itemProductKey: 'key--d', entryProductKey: 'key--c' }))
    const third = await decideReviewItem(d1, 'rev-dc', 'approved', 'admin-1')
    expect(third.registry).toEqual({ repointed: 2, dropped: 0, movedAliases: 0 })
    expect(
      sqlite.prepare('SELECT id FROM price_observations WHERE product_id = ?').all(dId)
    ).toEqual([{ id: 'obs-a1' }, { id: 'obs-c1' }])
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM price_products WHERE id = ?').get(cId)
    ).toEqual({ n: 0 })

    // Three receipts, three bumps; the last receipt's chain edge is D's
    // survivorship of C's group.
    expect(counts('price_product_merge_audit')).toBe(3)
    expect(counts('price_products')).toBe(1)
    expect(indexVersion()).toBe(3)
  })
})

// --- guards and failures ----------------------------------------------------

describe('product-merge: guards and failure semantics', () => {
  it('equal keys are a natural no-op (the taxonomy self-pair shape)', async () => {
    const plan = await planProductMerge(d1, 'key--a', 'key--a')
    expect(plan).toEqual({ kind: 'noop', reason: 'equal_keys' })
  })

  it('the bulk taxonomy acknowledgement never merges (self-pairs, #626 ack path)', async () => {
    seedSource()
    seedProduct('key--t')
    // The ack approves every pending taxonomy row — a SELF-pair (both sides
    // the same product). The ack does not route through the merge at all;
    // the equal-keys guard is the second line of defense.
    seedReviewItem(
      'rev-tax',
      pair({ itemProductKey: 'key--t', entryProductKey: 'key--t', reason: 'taxonomy' })
    )
    const acknowledged = await acknowledgePendingTaxonomy(d1, 'admin-1')
    expect(acknowledged.acknowledged).toBe(1)
    expect(acknowledged.remaining).toBe(0)
    expect(counts('price_products')).toBe(1)
    expect(counts('price_product_merge_audit')).toBe(0)
    expect(indexVersion()).toBe(0)
  })

  it('a missing survivor row skips the merge with a warning and the approval still lands', async () => {
    seedSource()
    seedProduct('beras--ramos--5kg')
    seedObservation(
      (
        sqlite
          .prepare('SELECT id FROM price_products WHERE product_key = ?')
          .get('beras--ramos--5kg') as { id: string }
      ).id,
      { id: 'obs-a1' }
    )
    seedReviewItem('rev-1', pair())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { item, registry } = await decideReviewItem(d1, 'rev-1', 'approved', 'admin-1')
    expect(item).toMatchObject({ status: 'approved' })
    expect(registry).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('survivor row missing'))
    // Nothing was absorbed and no receipt exists.
    expect(counts('price_product_merge_audit')).toBe(0)
    expect(indexVersion()).toBe(0)
    warn.mockRestore()
  })

  it('a missing entry row approves without merging (silent no-op)', async () => {
    seedProduct('beras--ramos--5-kg')
    seedReviewItem('rev-1', pair())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { registry } = await decideReviewItem(d1, 'rev-1', 'approved', 'admin-1')
    expect(registry).toBeNull()
    expect(counts('price_product_merge_audit')).toBe(0)
    expect(indexVersion()).toBe(0)
    warn.mockRestore()
  })

  it('a reject decides only — the batch stays the pre-#744 two statements', async () => {
    seedSource()
    seedProduct('beras--ramos--5-kg')
    seedProduct('beras--ramos--5kg')
    seedReviewItem('rev-1', pair())

    const { registry } = await decideReviewItem(d1, 'rev-1', 'rejected', 'admin-1')
    expect(registry).toBeNull()
    expect(counts('price_products')).toBe(2)
    expect(counts('price_product_merge_audit')).toBe(0)
    expect(indexVersion()).toBe(0)
    expect(
      sqlite.prepare('SELECT status FROM match_review_items WHERE id = ?').get('rev-1')
    ).toEqual({ status: 'rejected' })
  })

  it('a survivor deleted after the pre-read fails the whole batch — the verdict rolls back with it (FK posture)', async () => {
    seedSource()
    const survivorId = seedProduct('beras--ramos--5-kg')
    const absorbedId = seedProduct('beras--ramos--5kg')
    seedObservation(absorbedId, { id: 'obs-a1' })
    seedReviewItem('rev-1', pair())

    // The plan reads both rows live, then the survivor vanishes (a concurrent
    // (A, B) approval's footprint) before the batch runs.
    const plan = await planProductMerge(d1, pair().itemProductKey, pair().entryProductKey)
    expect(plan.kind).toBe('merge')
    sqlite.prepare('DELETE FROM price_products WHERE id = ?').run(survivorId)

    const decidedAt = new Date().toISOString()
    const survivorHandle = {
      id: survivorId,
      productKey: 'beras--ramos--5-kg',
      name: 'Beras Ramos 5 kg',
    }
    const batch = [
      d1
        .prepare(
          `UPDATE match_review_items SET status = 'approved', decided_at = ?, decided_by = ?, decided_source = 'human' WHERE id = 'rev-1'`
        )
        .bind(decidedAt, 'admin-1'),
      ...mergeStatements(d1, {
        reviewItemId: 'rev-1',
        receiptId: 'rec-fk',
        survivor: survivorHandle,
        absorbed: [{ id: absorbedId, productKey: 'beras--ramos--5kg', name: 'Beras Ramos 5kg' }],
        actorUserId: 'admin-1',
        decidedSource: 'human',
        decidedAt,
        decidedBy: 'admin-1',
      }),
    ]
    // P3's re-point targets a dead product id — the FK refuses, and the
    // adapter's BEGIN/ROLLBACK unwinds the decision write with it.
    await expect(d1.batch(batch)).rejects.toThrow()
    expect(
      sqlite.prepare('SELECT status FROM match_review_items WHERE id = ?').get('rev-1')
    ).toEqual({ status: 'pending' })
    expect(counts('price_product_merge_audit')).toBe(0)
    expect(indexVersion()).toBe(0)
    // The absorbed observation is untouched — no partial state.
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM price_observations WHERE id = ?').get('obs-a1')
    ).toEqual({ n: 1 })
  })

  it('throws on a receipt chain deeper than the bound', async () => {
    seedSource()
    // Chain A→B→C→… of receipts naming keys that never had live rows: the
    // walk is bounded by hops, not by live rows.
    let previous = 'key--0'
    for (let i = 1; i <= 12; i += 1) {
      sqlite
        .prepare(
          `INSERT INTO price_product_merge_audit
             (id, review_item_id, from_product_id, from_product_key, to_product_id, to_product_key,
              actor_user_id, decided_source, repointed_observations, dropped_observations,
              moved_aliases, observation_ids, dropped_observation_ids)
           VALUES (?, ?, ?, ?, ?, ?, 'u', 'human', 0, 0, 0, '[]', '[]')`
        )
        .run(`rec-${i}`, `rev-${i}`, `p-${previous}`, previous, `p-key--${i}`, `key--${i}`)
      previous = `key--${i}`
    }
    await expect(planProductMerge(d1, 'key--0', 'key--z')).rejects.toThrow(MergeChainTooDeepError)
  })

  it('caps the absorbed-row count per batch (the 50-statement chunk bound)', async () => {
    seedSource()
    const survivorId = seedProduct('key--a')
    const absorbed = Array.from({ length: 9 }, (_, i) => ({
      id: `prod-key--z${i}`,
      productKey: `key--z${i}`,
      name: `Z${i}`,
    }))
    expect(() =>
      mergeStatements(d1, {
        reviewItemId: 'rev-1',
        receiptId: 'rec-1',
        survivor: { id: survivorId, productKey: 'key--a', name: 'A' },
        absorbed,
        actorUserId: 'u',
        decidedSource: 'human',
        decidedAt: '2026-11-22T00:00:00.000Z',
        decidedBy: 'u',
      })
    ).toThrow(/one-batch bound/)
  })
})
