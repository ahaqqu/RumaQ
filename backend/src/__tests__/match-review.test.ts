import { describe, it, expect, vi } from 'vite-plus/test'
import {
  TAXONOMY_BUCKETS,
  TAXONOMY_VERSION,
  reviewItemPairSchema,
  type ReviewItemPair,
} from '@rumaq/contract'
import { generateSpecs } from 'hono-openapi'
import { apiApp } from '../apps/api.js'
import {
  recordReviewItems,
  listReviewItems,
  decideReviewItem,
  acknowledgePendingTaxonomy,
  undoReviewDecision,
  exportReviewDecisions,
  fetchEntryEvidence,
  fetchReviewItemsByIds,
  overrideTaxonomyCategory,
} from '../lib/match-review.js'
// The backend tsconfig pins `types` to @cloudflare/workers-types, so Node
// builtin imports carry no declarations — same contained suppressions as
// migrations.test.ts: the enrichment semantics below run on real SQLite
// (node:sqlite — D1 is SQLite), which the string-matching fake db cannot pin.
// @ts-expect-error — no node types in this tsconfig
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error — no node types in this tsconfig
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error — no node types in this tsconfig
import { join, dirname } from 'node:path'
// @ts-expect-error — no node types in this tsconfig
import { fileURLToPath } from 'node:url'

type SqliteDb = {
  exec(sql: string): void
  prepare(sql: string): {
    // node:sqlite's run info carries `changes`; the #728 override adapter
    // reads it to mirror D1's meta.changes.
    run(...params: unknown[]): { changes?: number | bigint }
    all(...params: unknown[]): Array<Record<string, unknown>>
    // node:sqlite's single-row read; the #626 ack test's first() adapter uses it.
    get(...params: unknown[]): Record<string, unknown> | undefined
  }
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations')

function applyRealMigrations(db: SqliteDb): void {
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name: string) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

// Minimal D1-shaped adapter over node:sqlite — only the surface
// fetchEntryEvidence uses (prepare → bind → all).
function sqliteD1(db: SqliteDb): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        all: async () => ({ results: db.prepare(sql).all(...params) }),
      }),
    }),
  } as unknown as D1Database
}

// The same adapter plus db.batch (just the statements executed in order), for
// readers like listReviewItems that issue their reads as one batch.
type BatchableStatement = { all: () => Promise<{ results: unknown[] }> }

function sqliteD1Batch(db: SqliteDb): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        all: async () => ({ results: db.prepare(sql).all(...params) }),
      }),
    }),
    batch: async (statements: BatchableStatement[]) =>
      Promise.all(statements.map((statement) => statement.all())),
  } as unknown as D1Database
}

// The run report ride-along lands pairs in D1 (issue #294). The fake DB
// follows the price-runs.test.ts pattern; the export test drives keyset
// paging for real so the non-truncation pin means something.

type FakeStatement = { sql: string; params: unknown[]; results?: unknown[] }

function createFakeDb(
  config: {
    batchResults?: Array<{ results?: unknown[] }>
    firstRow?: unknown
    exportRows?: Array<Record<string, unknown>>
    /** Issue #380: observations answering the entry-evidence lookup. */
    observationRows?: Array<{
      product_key: string
      store_slug: string
      brochure_url: string | null
      source_url: string | null
      observed_date: string
      /** QA-07: the sighting's struck original price (0052 column). */
      original_price?: number | null
    }>
    /** #744: receipt-chain edges answering the merge planner's edge read. */
    mergeEdges?: Array<{
      from_product_key: string
      to_product_key: string
      created_at: string
      id: string
    }>
    /** #744: live product rows answering the merge planner's row read. */
    mergeProducts?: Array<{ id: string; product_key: string; name: string | null }>
  } = {}
) {
  const statements: FakeStatement[] = []
  const batches: FakeStatement[] = []
  const db = {
    prepare(sql: string) {
      const stmt: FakeStatement & {
        bind: (...params: unknown[]) => FakeStatement
        all: () => Promise<{ results: unknown[] }>
        first: () => Promise<unknown>
        run: () => Promise<{ success: boolean }>
      } = {
        sql,
        params: [],
        bind(...params: unknown[]) {
          stmt.params = params
          return stmt
        },
        async all() {
          statements.push({ ...stmt })
          // Keyset paging for the export: filter the fixture by the bound
          // after(decided_at, id) cursor, page sized like the real query.
          if (sql.includes('FROM match_review_items r') && sql.includes('r.status !=')) {
            const [afterAt, , , afterId] = stmt.params as [string | null, ...unknown[]]
            const filtered = (config.exportRows ?? []).filter((row) => {
              if (afterAt === null) return true
              if ((row.decided_at as string) !== afterAt) {
                return (row.decided_at as string) > afterAt
              }
              return (row.id as string) > (afterId as string)
            })
            return { results: filtered.slice(0, 200) }
          }
          // Entry-evidence enrichment (issue #380, store-pinned): answer with
          // the fixture rows whose (product_key, store_slug) composite is in
          // the bound IN-chunk, shaped like the real query's rows.
          if (
            sql.includes('FROM price_observations o') &&
            sql.includes("p.product_key || '|' || s.slug")
          ) {
            const composites = stmt.params as string[]
            return {
              results: (config.observationRows ?? [])
                .filter((row) => composites.includes(`${row.product_key}|${row.store_slug}`))
                .map((row) => ({ ...row, evidence_key: `${row.product_key}|${row.store_slug}` })),
            }
          }
          // #744: the merge planner's two chunked reads — receipt edges, then
          // live product rows (selectIn spreads the keys after any leading
          // binds; both reads here are bare key lists).
          if (
            sql.includes('FROM price_product_merge_audit') &&
            sql.includes('from_product_key IN')
          ) {
            const keys = stmt.params as string[]
            return {
              results: (config.mergeEdges ?? []).filter((edge) =>
                keys.includes(edge.from_product_key)
              ),
            }
          }
          if (sql.includes('FROM price_products WHERE product_key IN')) {
            const keys = stmt.params as string[]
            return {
              results: (config.mergeProducts ?? []).filter((row) => keys.includes(row.product_key)),
            }
          }
          return { results: [] }
        },
        async first() {
          statements.push({ ...stmt })
          return config.firstRow ?? null
        },
        async run() {
          statements.push({ ...stmt })
          return { success: true }
        },
      }
      return stmt
    },
    async batch(bound: FakeStatement[]) {
      statements.push(...bound)
      batches.push(...bound)
      return config.batchResults ?? []
    },
  }
  return { db: db as unknown as D1Database, statements, batches }
}

function pair(over: Partial<ReviewItemPair> = {}): ReviewItemPair {
  return {
    itemProductKey: 'beras-ramos-5kg----5-kg',
    itemName: 'Beras Ramos 5 kg',
    itemBrand: null,
    itemUnit: '5 kg',
    itemPrice: 89000,
    itemEffectiveUnitPrice: 89000,
    itemStore: 'lotte-mart',
    entryProductKey: 'beras-ramos-5kg--ramos--5-kg',
    entryName: 'Beras Ramos 5kg',
    entryBrand: 'Ramos',
    entryUnit: '5 kg',
    entryPrice: 27000,
    entryEffectiveUnitPrice: 27000,
    entryStore: 'superindo',
    matchMethod: 'exact',
    confidence: 1,
    reason: 'price_ratio',
    ...over,
  }
}

describe('recordReviewItems', () => {
  it('is a no-op for a report without pairs (old scraper)', async () => {
    const { db, statements } = createFakeDb()
    await recordReviewItems(db, '2026-10-28T23:00:05Z', [])
    expect(statements).toHaveLength(0)
  })

  it('upserts on the natural key, refreshing evidence only — never the decision columns', async () => {
    const { db, statements } = createFakeDb()
    await recordReviewItems(db, '2026-10-28T23:00:05Z', [
      pair(),
      pair({ reason: 'verifier_unresolved' }),
    ])
    expect(statements).toHaveLength(2)
    const { sql, params } = statements[0]!
    expect(sql).toContain('ON CONFLICT(item_product_key, entry_product_key) DO UPDATE SET')
    // The never-reopen invariant, pinned at the SQL level: the DO UPDATE list
    // refreshes evidence and recurrence, and never mentions the verdict.
    expect(sql).toContain('flag_count = flag_count + 1')
    expect(sql).toContain('last_flagged_at = excluded.last_flagged_at')
    // Same-run replay no-op (postRunReport retry): a report replayed with the
    // same runStartedAt must not bump flag_count for already-committed chunks.
    expect(sql).toContain('WHERE match_review_items.run_started_at <> excluded.run_started_at')
    expect(sql).not.toMatch(/status\s*=/)
    expect(sql).not.toMatch(/decided_at\s*=/)
    expect(sql).not.toMatch(/decided_by\s*=/)
    expect(sql).not.toMatch(/first_flagged_at\s*=/)
    // pair_data is the validated contract pair, verbatim.
    expect(JSON.parse(params[3] as string)).toEqual(pair())
    expect(params[4]).toBe('price_ratio')
    expect(params[7]).toBe('2026-10-28T23:00:05Z') // run_started_at
    expect(params[8]).toBe('2026-10-28T23:00:05Z') // first_flagged_at
    expect(params[9]).toBe('2026-10-28T23:00:05Z') // last_flagged_at
  })

  it('chunks large reports into db.batch windows', async () => {
    const { db, statements } = createFakeDb()
    const pairs = Array.from({ length: 120 }, (_, i) => pair({ itemProductKey: `p-${i}----` }))
    await recordReviewItems(db, '2026-10-28T23:00:05Z', pairs)
    expect(statements).toHaveLength(120)
  })
})

describe('listReviewItems', () => {
  const rowFor = (over: Record<string, unknown>) => ({
    id: 'rev-1',
    pair_data: JSON.stringify(pair()),
    status: 'pending',
    decided_at: null,
    decided_by: null,
    flag_count: 2,
    first_flagged_at: '2026-10-27T23:00:05Z',
    last_flagged_at: '2026-10-28T23:00:05Z',
    run_started_at: '2026-10-28T23:00:05Z',
    run_id: 'run-uuid-1',
    // #626: the item side's assigned category, aliased off price_products.
    item_category: 'makanan-minuman',
    item_category_version: 'v0.4',
    ...over,
  })

  it('defaults to pending/50/0 and flattens pair_data with the overlay columns', async () => {
    const { db } = createFakeDb({
      batchResults: [
        { results: [rowFor({})] },
        {
          results: [
            { status: 'pending', count: 3 },
            { status: 'rejected', count: 1 },
          ],
        },
        {
          results: [
            { flag_reason: 'price_ratio', count: 2 },
            { flag_reason: 'taxonomy', count: 1 },
          ],
        },
        { results: [{ count: 3 }] },
      ],
    })
    const page = await listReviewItems(db)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      id: 'rev-1',
      itemProductKey: 'beras-ramos-5kg----5-kg',
      entryName: 'Beras Ramos 5kg',
      reason: 'price_ratio',
      status: 'pending',
      flagCount: 2,
      runId: 'run-uuid-1',
      decidedAt: null,
      // #626: the category context rides every row (null when the product
      // row is gone).
      itemCategory: 'makanan-minuman',
      itemCategoryVersion: 'v0.4',
    })
    expect(page.counts).toEqual({
      pending: 3,
      approved: 0,
      rejected: 1,
      // Issue #628: absent reasons are 0, never missing keys.
      pendingByReason: { price_ratio: 2, verifier_unresolved: 0, taxonomy: 1 },
    })
    expect(page.filteredTotal).toBe(3)
  })

  it('binds the requested filter and window', async () => {
    const { db, statements } = createFakeDb({
      batchResults: [{ results: [] }, { results: [] }, { results: [] }, { results: [] }],
    })
    await listReviewItems(db, { status: 'approved', limit: 10, offset: 25 })
    const [pageStmt, , reasonStmt, filteredStmt] = statements
    // #626: no reason = the IDENTITY queue — the exclusion guard, and the
    // fragment is picked on the reason's presence, so no reason binds at all.
    expect(pageStmt!.params).toEqual(['approved', 'approved', 10, 25])
    expect(filteredStmt!.params).toEqual(['approved', 'approved'])
    expect(statements[0]!.sql).toContain('LEFT JOIN price_runs p ON p.run_started_at')
    // #626: the category context rides the same joins.
    expect(statements[0]!.sql).toContain('LEFT JOIN price_products pp ON pp.product_key')
    expect(statements[0]!.sql).toContain("<> 'taxonomy'")
    expect(statements[0]!.sql).toContain('ORDER BY r.last_flagged_at DESC')
    // The exact pending split is its own whole-queue GROUP BY.
    expect(reasonStmt!.sql).toContain(`WHERE r.status = 'pending'`)
    expect(reasonStmt!.sql).toContain('GROUP BY flag_reason')
  })

  it('clamps an oversized offset instead of binding it (#630 A1)', async () => {
    const { db, statements } = createFakeDb({
      batchResults: [{ results: [] }, { results: [] }, { results: [] }, { results: [] }],
    })
    await listReviewItems(db, { offset: Number.MAX_SAFE_INTEGER + 1 })
    expect(statements[0]!.params[3]).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('narrows the page and filteredTotal by reason, keeping the status counts whole (issue #628)', async () => {
    const { db, statements } = createFakeDb({
      batchResults: [
        { results: [rowFor({})] },
        { results: [{ status: 'pending', count: 9 }] },
        { results: [{ flag_reason: 'taxonomy', count: 4 }] },
        { results: [{ count: 1 }] },
      ],
    })
    const page = await listReviewItems(db, { reason: 'taxonomy' })
    expect(page.items).toHaveLength(1)
    expect(page.filteredTotal).toBe(1)
    // Counts stay independent of the filter — same rule as the status filter.
    expect(page.counts.pending).toBe(9)
    expect(page.counts.pendingByReason).toEqual({
      price_ratio: 0,
      verifier_unresolved: 0,
      taxonomy: 4,
    })
    const [pageStmt, statusStmt, , filteredStmt] = statements
    expect(pageStmt!.params).toEqual(['pending', 'pending', 'taxonomy', 50, 0])
    expect(pageStmt!.sql).toContain(`json_extract(r.pair_data, '$.reason')`)
    // The reason filter reaches the total too, or "Showing X of Y" would lie.
    expect(filteredStmt!.params).toEqual(['pending', 'pending', 'taxonomy'])
    // The status GROUP BY is unsullied by the filter (no JSON in it at all).
    expect(statusStmt!.sql).not.toContain('json')
  })

  it('drops unknown and malformed reasons from the pending split instead of widening it', async () => {
    const { db } = createFakeDb({
      batchResults: [
        { results: [] },
        { results: [{ status: 'pending', count: 5 }] },
        {
          results: [
            { flag_reason: 'price_ratio', count: 3 },
            { flag_reason: 'something_else', count: 1 },
            { flag_reason: null, count: 1 },
          ],
        },
        { results: [{ count: 5 }] },
      ],
    })
    const page = await listReviewItems(db)
    expect(page.counts.pendingByReason).toEqual({
      price_ratio: 3,
      verifier_unresolved: 0,
      taxonomy: 0,
    })
  })

  it('survives a malformed pair_data blob without losing the rest of the page', async () => {
    const { db } = createFakeDb({
      batchResults: [
        {
          results: [rowFor({ id: 'bad', pair_data: '{not json' }), rowFor({ id: 'good' })],
        },
        { results: [{ status: 'pending', count: 2 }] },
        { results: [{ flag_reason: 'price_ratio', count: 2 }] },
        { results: [{ count: 2 }] },
      ],
    })
    const page = await listReviewItems(db)
    expect(page.items.map((item) => item.id)).toEqual(['good'])
    expect(page.counts.pending).toBe(2)
  })
})

describe('entry-side evidence enrichment (issue #380)', () => {
  const rowFor = (over: Record<string, unknown>) => ({
    id: 'rev-1',
    pair_data: JSON.stringify(pair()),
    status: 'pending',
    decided_at: null,
    decided_by: null,
    flag_count: 1,
    first_flagged_at: '2026-10-28T23:00:05Z',
    last_flagged_at: '2026-10-28T23:00:05Z',
    run_started_at: '2026-10-28T23:00:05Z',
    run_id: null,
    ...over,
  })

  const observation = {
    product_key: 'beras-ramos-5kg--ramos--5-kg',
    store_slug: 'superindo',
    brochure_url: '/api/brochures/superindo/20261028/page-3.jpg',
    source_url: 'https://www.superindo.co.id/promosi/katalog-super-hemat/',
    observed_date: '2026-10-28',
  }

  function pageOf(rows: unknown[]) {
    return [
      { results: rows },
      { results: [{ status: 'pending', count: rows.length }] },
      // Issue #628: the pending split by reason (empty here — the split is
      // pinned by the list tests; these are the enrichment semantics).
      { results: [] },
      { results: [{ count: rows.length }] },
    ]
  }

  it('enriches every listed row with the latest observation of its entry', async () => {
    const { db } = createFakeDb({
      batchResults: pageOf([rowFor({})]),
      observationRows: [observation],
    })
    const page = await listReviewItems(db)
    expect(page.items[0]).toMatchObject({
      entryBrochureUrl: '/api/brochures/superindo/20261028/page-3.jpg',
      entrySourceUrl: 'https://www.superindo.co.id/promosi/katalog-super-hemat/',
      entryObservedAt: '2026-10-28',
    })
  })

  it('enriches DECIDED rows too — after-the-fact review is the point', async () => {
    const { db } = createFakeDb({
      batchResults: pageOf([rowFor({ id: 'rev-2', status: 'approved' })]),
      observationRows: [observation],
    })
    const page = await listReviewItems(db, { status: 'approved' })
    expect(page.items[0]!.status).toBe('approved')
    expect(page.items[0]!.entryObservedAt).toBe('2026-10-28')
  })

  it('stays null when the entry has no observation (or none survived retention)', async () => {
    const { db } = createFakeDb({ batchResults: pageOf([rowFor({})]), observationRows: [] })
    const page = await listReviewItems(db)
    expect(page.items[0]).toMatchObject({
      entryBrochureUrl: null,
      entrySourceUrl: null,
      entryObservedAt: null,
    })
  })

  it('chunks the IN-list at 90 keys — a 120-entry page still reads every observation', async () => {
    const entries = Array.from({ length: 120 }, (_, i) => `entry-key-${i}--brand--unit`)
    const rows = entries.map((key, i) =>
      rowFor({ id: `rev-${i}`, pair_data: JSON.stringify(pair({ entryProductKey: key })) })
    )
    const observationRows = entries.map((key) => ({
      product_key: key,
      store_slug: 'superindo',
      brochure_url: null,
      source_url: null,
      observed_date: '2026-10-28',
    }))
    const { db, statements } = createFakeDb({
      batchResults: pageOf(rows),
      observationRows,
    })
    const page = await listReviewItems(db, { limit: 120 })
    expect(page.items).toHaveLength(120)
    const enrichment = statements.filter(
      (s) =>
        s.sql.includes('FROM price_observations o') &&
        s.sql.includes("p.product_key || '|' || s.slug")
    )
    expect(enrichment).toHaveLength(2) // 90 + 30
    expect(enrichment[0]!.params).toHaveLength(90)
    expect(enrichment[1]!.params).toHaveLength(30)
    // Every row got its evidence — no key lost between chunks.
    for (const item of page.items) expect(item.entryObservedAt).toBe('2026-10-28')
  })

  it('carries the same evidence through decide/undo responses', async () => {
    const decidedRow = rowFor({
      status: 'approved',
      decided_at: '2026-10-29T10:00:00.000Z',
      decided_by: 'admin-1',
    })
    const { db } = createFakeDb({ firstRow: decidedRow, observationRows: [observation] })
    const { item } = await decideReviewItem(db, 'rev-1', 'approved', 'admin-1')
    expect(item).toMatchObject({ status: 'approved', entryObservedAt: '2026-10-28' })
  })
})

describe('decideReviewItem / undoReviewDecision', () => {
  const decidedRow = {
    id: 'rev-1',
    pair_data: JSON.stringify(pair()),
    status: 'approved',
    decided_at: '2026-10-29T10:00:00.000Z',
    decided_by: 'admin-1',
    flag_count: 1,
    first_flagged_at: '2026-10-28T23:00:05Z',
    last_flagged_at: '2026-10-28T23:00:05Z',
    run_started_at: '2026-10-28T23:00:05Z',
    run_id: null,
  }

  it('records the verdict with the deciding admin and returns the updated row', async () => {
    const { db, statements } = createFakeDb({ firstRow: decidedRow })
    const { item } = await decideReviewItem(db, 'rev-1', 'rejected', 'admin-9')
    expect(item).toMatchObject({ id: 'rev-1', status: 'approved' }) // from the fake's row
    // #484: the verdict-existence read decides the provenance BEFORE the
    // write — no verdict + no agreement means plain human provenance.
    expect(statements[0]!.sql).toContain('FROM review_ai_verdicts')
    const update = statements.find((s) => s.sql.startsWith('UPDATE match_review_items'))!
    expect(update.sql).toContain(
      'SET status = ?, decided_at = ?, decided_by = ?, decided_source = ?'
    )
    expect(update.params[0]).toBe('rejected')
    expect(update.params[2]).toBe('admin-9')
    expect(update.params[3]).toBe('human')
  })

  it('overwrites a previous verdict — last verdict wins', async () => {
    const { db, statements } = createFakeDb({ firstRow: decidedRow })
    await decideReviewItem(db, 'rev-1', 'approved', 'admin-1')
    await decideReviewItem(db, 'rev-1', 'rejected', 'admin-2')
    // Each decide = UPDATE then re-SELECT (+ the #380 evidence enrichment
    // read); the second UPDATE carries the newer verdict and admin.
    const updates = statements.filter((s) => s.sql.startsWith('UPDATE match_review_items'))
    expect(updates).toHaveLength(2)
    expect(updates[0]!.params[0]).toBe('approved')
    expect(updates[1]!.params[0]).toBe('rejected')
    expect(updates[1]!.params[2]).toBe('admin-2')
  })

  it('returns null for an unknown id (the route 404s)', async () => {
    const { db } = createFakeDb({ firstRow: null })
    expect((await decideReviewItem(db, 'nope', 'approved', 'admin-1')).item).toBeNull()
    expect(await undoReviewDecision(db, 'nope')).toBeNull()
  })

  it('undo clears the verdict back to pending; undoing a pending row is idempotent', async () => {
    const { db, statements } = createFakeDb({
      firstRow: { ...decidedRow, status: 'pending', decided_at: null, decided_by: null },
    })
    const item = await undoReviewDecision(db, 'rev-1')
    expect(item).toMatchObject({ status: 'pending', decidedAt: null })
    const update = statements[0]!
    expect(update.sql).toContain("status = 'pending'")
    expect(update.sql).toContain('decided_at = NULL')
    expect(update.sql).toContain('decided_by = NULL')
    // #484: the provenance goes with the decision; the cached verdict stays
    // but its agreement described the decision that was just undone.
    expect(update.sql).toContain('decided_source = NULL')
    expect(statements.some((s) => s.sql.startsWith('UPDATE review_ai_verdicts'))).toBe(true)
  })
})

// #744: an approval rides the registry merge in the SAME batch. The fake db
// answers the planner's two reads so the statement sequence can be pinned
// exactly; the real-SQLite suite (product-merge.test.ts) proves the SQL's
// semantics.
describe('decideReviewItem rides the registry merge (#744)', () => {
  const decidedRow = {
    id: 'rev-1',
    pair_data: JSON.stringify(pair()),
    status: 'pending',
    decided_at: null,
    decided_by: null,
    flag_count: 1,
    first_flagged_at: '2026-10-28T23:00:05Z',
    last_flagged_at: '2026-10-28T23:00:05Z',
    run_started_at: '2026-10-28T23:00:05Z',
    run_id: null,
  }
  // The fake's .first() answers EVERY single-row read with firstRow — the
  // keys read gets the same object (whose item/entry keys are the pair's, so
  // the planner reads real keys).
  const survivorKey = pair().itemProductKey
  const absorbedKey = pair().entryProductKey

  it('an approval batches the verdict write with the receipt, the six merge statements and the gated bump', async () => {
    const { db, batches } = createFakeDb({
      firstRow: { ...decidedRow, item_product_key: survivorKey, entry_product_key: absorbedKey },
      mergeProducts: [
        { id: 'prod-s', product_key: survivorKey, name: 'Beras Ramos 5 kg' },
        { id: 'prod-a', product_key: absorbedKey, name: 'Beras Ramos 5kg' },
      ],
    })
    const { registry } = await decideReviewItem(db, 'rev-1', 'approved', 'admin-1')
    // The read-back rode the batch; the fake's batchResults default to [] so
    // the merge plan's receipt read answers no row → registry null.
    expect(registry).toBeNull()

    // The ONE batch: the decision (+ its agreement), the receipt, the six
    // merge statements, the gated bump, and the receipt read-back.
    const batched = batches
    const kinds = batched.map((s) => {
      if (s.sql.startsWith('UPDATE match_review_items')) return 'decision'
      if (s.sql.startsWith('UPDATE review_ai_verdicts')) return 'agreement'
      if (s.sql.includes('INSERT INTO price_product_merge_audit')) return 'receipt'
      if (s.sql.startsWith('UPDATE plan_items')) return 'p1'
      if (s.sql.startsWith('DELETE FROM price_observations')) return 'p2'
      if (s.sql.startsWith('UPDATE price_observations')) return 'p3'
      if (s.sql.startsWith('DELETE FROM price_product_aliases')) return 'p4'
      if (s.sql.startsWith('UPDATE price_product_aliases')) return 'p5'
      if (s.sql.startsWith('DELETE FROM price_products')) return 'p6'
      if (s.sql.includes('UPDATE canonical_index_state')) return 'bump'
      if (
        s.sql.includes('FROM price_product_merge_audit') &&
        s.sql.includes('repointed_observations AS')
      )
        return 'read-back'
      return `other:${s.sql.slice(0, 40)}`
    })
    expect(kinds).toEqual([
      'decision',
      // The fake's verdict read answers truthy, so the agreement write rides.
      'agreement',
      'receipt',
      'p1',
      'p2',
      'p3',
      'p4',
      'p5',
      'p6',
      'bump',
      'read-back',
    ])

    // The receipt's gates: the principal absorbed row, the survivor, and THIS
    // batch's decision marker (the exact decided_at/decided_by the decision
    // UPDATE bound — the CAS that makes a re-approval write nothing).
    const receipt = batched.find((s) => s.sql.includes('INSERT INTO price_product_merge_audit'))!
    expect(receipt.sql).toContain('WITH merge_absorbed(id) AS (VALUES (?)')
    expect(receipt.sql).toContain('FROM price_products a')
    expect(receipt.params).toContain('prod-a') // from_product_id (principal)
    expect(receipt.params).toContain('prod-s') // to_product_id (survivor)
    // The receipt's tail binds are the decision marker: the review item id
    // plus the EXACT decided_at/decided_by the decision UPDATE bound — the
    // CAS that makes a re-approval insert nothing.
    const decision = batched[0]!
    expect(receipt.params.slice(-3)).toEqual(['rev-1', decision.params[1], decision.params[2]])
    // The bump is the receipt-gated indexBumpStatement naming the same receipt.
    const bump = batched.find((s) => s.sql.includes('UPDATE canonical_index_state'))!
    expect(bump.sql).toContain('price_product_merge_audit')
  })

  it('re-approval after the merge plans nothing to absorb — the batch is the decision alone', async () => {
    // The first merge's receipt left an edge absorbed→survivor and the
    // absorbed row is gone: the planner resolves the chain to the survivor
    // and finds no live absorbed rows.
    const { db, statements } = createFakeDb({
      firstRow: decidedRow,
      mergeEdges: [
        {
          from_product_key: absorbedKey,
          to_product_key: survivorKey,
          created_at: '2026-11-20 00:00:00',
          id: 'rec-1',
        },
      ],
      mergeProducts: [{ id: 'prod-s', product_key: survivorKey, name: 'Beras Ramos 5 kg' }],
    })
    const { registry } = await decideReviewItem(db, 'rev-1', 'approved', 'admin-1')
    expect(registry).toBeNull()
    expect(statements.some((s) => s.sql.includes('INSERT INTO price_product_merge_audit'))).toBe(
      false
    )
    expect(statements.some((s) => s.sql.includes('UPDATE canonical_index_state'))).toBe(false)
    // The verdict write still happened (last-wins) with no merge around it.
    expect(statements.some((s) => s.sql.startsWith('UPDATE match_review_items'))).toBe(true)
  })

  it('a reject batches the decision alone and never touches the registry', async () => {
    const { db, statements } = createFakeDb({
      firstRow: decidedRow,
      mergeProducts: [
        { id: 'prod-s', product_key: survivorKey, name: 'Beras Ramos 5 kg' },
        { id: 'prod-a', product_key: absorbedKey, name: 'Beras Ramos 5kg' },
      ],
    })
    const { registry } = await decideReviewItem(db, 'rev-1', 'rejected', 'admin-1')
    expect(registry).toBeNull()
    expect(statements.some((s) => s.sql.includes('INSERT INTO price_product_merge_audit'))).toBe(
      false
    )
    expect(statements.some((s) => s.sql.includes('UPDATE canonical_index_state'))).toBe(false)
  })
})

describe('exportReviewDecisions', () => {
  it('streams EVERY decided row across keyset pages — non-truncation is the point', async () => {
    // 450 decided rows: three keyset pages (200 + 200 + 50) — far beyond the
    // list endpoint's default 50/page, which must never truncate the export.
    const exportRows = Array.from({ length: 450 }, (_, i) => ({
      id: `rev-${String(i).padStart(4, '0')}`,
      pair_data: JSON.stringify(
        pair({
          itemProductKey: `item-${i}----`,
          matchMethod: 'ai',
          confidence: 0.7,
          reason: 'verifier_unresolved',
        })
      ),
      status: i % 2 === 0 ? 'approved' : 'rejected',
      decided_at: new Date(Date.UTC(2026, 9, 28, 0, 0, i)).toISOString(),
      decided_by: 'admin-1',
      flag_count: 3,
      run_started_at: '2026-10-28T23:00:05Z',
    }))
    const { db } = createFakeDb({ exportRows })
    const text = await new Response(exportReviewDecisions(db)).text()
    const parsed = JSON.parse(text) as {
      schema: number
      exportedAt: string
      decisions: Array<Record<string, unknown>>
    }
    expect(parsed.schema).toBe(1)
    expect(parsed.exportedAt).toBeTruthy()
    expect(parsed.decisions).toHaveLength(450)
    // Ordered by decision time; the flattened row carries exactly the fields
    // a future matcher-feedback loop consumes.
    expect(parsed.decisions[0]).toMatchObject({
      itemProductKey: 'item-0----',
      entryProductKey: 'beras-ramos-5kg--ramos--5-kg',
      decision: 'approved',
      decidedBy: 'admin-1',
      flagCount: 3,
      confidence: 0.7,
      matchMethod: 'ai',
      reason: 'verifier_unresolved',
    })
    const keys = parsed.decisions.map((row) => row.itemProductKey)
    expect(new Set(keys).size).toBe(450)
  })

  it('continues past a malformed blob in a full page — pagination is RAW-row based (thermos A2)', async () => {
    // Row 199 is the last row of the first full 200-row page and carries a
    // corrupt blob. The walk must jump past it (cursor from the last RAW row)
    // and keep paging — the pre-A2 loop ended at the 199 parsed rows and
    // silently dropped every later decided row.
    const exportRows = Array.from({ length: 450 }, (_, i) => ({
      id: `rev-${String(i).padStart(4, '0')}`,
      pair_data:
        i === 199 ? '{not json' : JSON.stringify(pair({ itemProductKey: `item-${i}----` })),
      status: 'approved',
      decided_at: new Date(Date.UTC(2026, 9, 28, 0, 0, i)).toISOString(),
      decided_by: 'admin-1',
      flag_count: 1,
      run_started_at: '2026-10-28T23:00:05Z',
    }))
    const { db } = createFakeDb({ exportRows })
    const text = await new Response(exportReviewDecisions(db)).text()
    const parsed = JSON.parse(text) as { decisions: Array<{ itemProductKey: string }> }
    expect(parsed.decisions).toHaveLength(449)
    const keys = parsed.decisions.map((row) => row.itemProductKey)
    expect(keys).toContain('item-198----')
    expect(keys).toContain('item-200----')
    expect(keys).toContain('item-449----')
  })

  it('streams an empty decisions array when nothing was decided', async () => {
    const { db } = createFakeDb({ exportRows: [] })
    const text = await new Response(exportReviewDecisions(db)).text()
    const parsed = JSON.parse(text) as { schema: number; decisions: unknown[] }
    expect(parsed.schema).toBe(1)
    expect(parsed.decisions).toEqual([])
  })

  it('carries the entry-side evidence on every export row (issue #380)', async () => {
    const exportRows = [
      {
        id: 'rev-1',
        pair_data: JSON.stringify(pair()),
        status: 'approved',
        decided_at: new Date(Date.UTC(2026, 9, 28, 0, 0, 0)).toISOString(),
        decided_by: 'admin-1',
        flag_count: 1,
        run_started_at: '2026-10-28T23:00:05Z',
      },
    ]
    const { db } = createFakeDb({
      exportRows,
      observationRows: [
        {
          product_key: 'beras-ramos-5kg--ramos--5-kg',
          store_slug: 'superindo',
          brochure_url: '/api/brochures/superindo/20261028/page-3.jpg',
          source_url: 'https://www.superindo.co.id/promosi/katalog-super-hemat/',
          observed_date: '2026-10-28',
          // QA-07: the sighting's struck original price rides the same
          // lookup onto the export row.
          original_price: 32000,
        },
      ],
    })
    const text = await new Response(exportReviewDecisions(db)).text()
    const parsed = JSON.parse(text) as { decisions: Array<Record<string, unknown>> }
    expect(parsed.decisions[0]).toMatchObject({
      entryBrochureUrl: '/api/brochures/superindo/20261028/page-3.jpg',
      entrySourceUrl: 'https://www.superindo.co.id/promosi/katalog-super-hemat/',
      entryObservedAt: '2026-10-28',
      entryOriginalPrice: 32000,
    })
  })

  it('carries a null original price when the observation has none (QA-07)', async () => {
    const exportRows = [
      {
        id: 'rev-1',
        pair_data: JSON.stringify(pair()),
        status: 'approved',
        decided_at: new Date(Date.UTC(2026, 9, 28, 0, 0, 0)).toISOString(),
        decided_by: 'admin-1',
        flag_count: 1,
        run_started_at: '2026-10-28T23:00:05Z',
      },
    ]
    const { db } = createFakeDb({
      exportRows,
      observationRows: [
        {
          product_key: 'beras-ramos-5kg--ramos--5-kg',
          store_slug: 'superindo',
          brochure_url: '/api/brochures/superindo/20261028/page-3.jpg',
          source_url: 'https://www.superindo.co.id/promosi/katalog-super-hemat/',
          observed_date: '2026-10-28',
        },
      ],
    })
    const text = await new Response(exportReviewDecisions(db)).text()
    const parsed = JSON.parse(text) as { decisions: Array<Record<string, unknown>> }
    expect(parsed.decisions[0]).toMatchObject({ entryOriginalPrice: null })
  })
})

// Issue #493: the review-list `reason` enum reads REVIEW_REASONS, which is a
// HAND-KEPT mirror of the contract's picklist — so pin the schema the API
// actually publishes to the contract options. A reason added to the contract
// (or a drift back to two values in the route schema) must fail here, not
// reach the triage queue as a mislabelled flag.
describe('review reason vocabulary (issue #493)', () => {
  it('publishes exactly the contract reason picklist in the review-list schema', async () => {
    const specs = (await generateSpecs(apiApp, {
      documentation: { info: { title: 'RumaQ API', version: '0.1.0' } },
    })) as Record<string, any>
    const listSchema =
      specs.paths['/api/admin/review'].get.responses['200'].content['application/json'].schema
    const published = [...(listSchema.properties.items.items.properties.reason.enum as string[])]
    const contractReasons = [...reviewItemPairSchema.entries.reason.options]
    expect(published.sort()).toEqual(contractReasons.sort())
  })

  // Issue #628: the filter param and the pendingByReason split are both
  // derived from REVIEW_REASONS, so the contract picklist stays the one
  // source — a reason added there must surface in both without drift.
  it('publishes the same vocabulary on the reason query param and the split', async () => {
    const specs = (await generateSpecs(apiApp, {
      documentation: { info: { title: 'RumaQ API', version: '0.1.0' } },
    })) as Record<string, any>
    const operation = specs.paths['/api/admin/review'].get
    const reasonParam = (operation.parameters as Array<Record<string, any>>).find(
      (param) => param.name === 'reason'
    )!
    const offsetParam = (operation.parameters as Array<Record<string, any>>).find(
      (param) => param.name === 'offset'
    )!
    expect(offsetParam.schema.maximum).toBe(Number.MAX_SAFE_INTEGER)
    expect(reasonParam.in).toBe('query')
    expect(reasonParam.required).toBe(false)
    expect([...reasonParam.schema.enum].sort()).toEqual(
      [...reviewItemPairSchema.entries.reason.options].sort()
    )
    const countsSchema =
      operation.responses['200'].content['application/json'].schema.properties.counts
    expect(Object.keys(countsSchema.properties.pendingByReason.properties).sort()).toEqual(
      [...reviewItemPairSchema.entries.reason.options].sort()
    )
  })
})

describe('review routes', () => {
  const adminEnv = () => ({
    DB: {
      prepare: vi.fn().mockReturnThis(),
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ email: 'admin@rumaq.dev', is_admin: 1 }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      batch: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    },
    WORKER_JWT_SECRET: 'test-secret',
    props: { userId: 'admin-1', householdId: 'h1' },
  })

  it('401s logged-out on every review route', async () => {
    const paths: Array<[string, RequestInit]> = [
      ['/api/admin/review', {}],
      ['/api/admin/review/export', {}],
      ['/api/admin/review/mode', {}],
      ['/api/admin/review/mode', { method: 'PUT' }],
      ['/api/admin/review/evaluate', { method: 'POST' }],
      ['/api/admin/review/rev-1/decision', { method: 'POST' }],
      ['/api/admin/review/rev-1/decision', { method: 'DELETE' }],
      // #728: the override is a catalog write — the chain gates it like the
      // decision routes; the vocabulary read is admin-only server state.
      ['/api/admin/review/taxonomy/buckets', {}],
      ['/api/admin/review/rev-1/category', { method: 'POST' }],
      ['/api/admin/products/beras/category', { method: 'DELETE' }],
    ]
    for (const [path, init] of paths) {
      const res = await apiApp.request(path, init, { props: undefined } as never)
      expect(res.status).toBe(401)
    }
  })

  it('403s non-admins on every review route', async () => {
    const nonAdmin = {
      ...adminEnv(),
      DB: {
        ...adminEnv().DB,
        first: vi.fn().mockResolvedValue({ email: 'shopper@rumaq.dev', is_admin: 0 }),
      },
      props: { userId: 'u2', householdId: 'h1' },
    }
    const paths: Array<[string, RequestInit]> = [
      ['/api/admin/review', {}],
      ['/api/admin/review/export', {}],
      ['/api/admin/review/mode', {}],
      ['/api/admin/review/mode', { method: 'PUT' }],
      ['/api/admin/review/evaluate', { method: 'POST' }],
      ['/api/admin/review/rev-1/decision', { method: 'POST' }],
      ['/api/admin/review/rev-1/decision', { method: 'DELETE' }],
      ['/api/admin/review/taxonomy/buckets', {}],
      ['/api/admin/review/rev-1/category', { method: 'POST' }],
      ['/api/admin/products/beras/category', { method: 'DELETE' }],
    ]
    for (const [path, init] of paths) {
      const res = await apiApp.request(path, init, nonAdmin as never)
      expect(res.status).toBe(403)
    }
  })

  it('400s an offset outside the documented maximum (#630 A1)', async () => {
    const env = adminEnv()
    for (const offset of ['1e19', String(Number.MAX_SAFE_INTEGER + 1)]) {
      const res = await apiApp.request(`/api/admin/review?offset=${offset}`, {}, env as never)
      expect(res.status).toBe(400)
    }
  })

  it('an admin list request returns 200 with private cache headers', async () => {
    const env = adminEnv()
    env.DB.batch = vi
      .fn()
      .mockResolvedValue([{ results: [] }, { results: [] }, { results: [] }, { results: [] }])
    const res = await apiApp.request('/api/admin/review', {}, env as never)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
    const body = (await res.json()) as { counts: unknown; filteredTotal: number }
    expect(body.counts).toEqual({
      pending: 0,
      approved: 0,
      rejected: 0,
      pendingByReason: { price_ratio: 0, verifier_unresolved: 0, taxonomy: 0 },
    })
    expect(body.filteredTotal).toBe(0)
  })

  it('passes a valid reason through to the list read (issue #628)', async () => {
    const env = adminEnv()
    env.DB.batch = vi
      .fn()
      .mockResolvedValue([{ results: [] }, { results: [] }, { results: [] }, { results: [] }])
    const res = await apiApp.request('/api/admin/review?reason=taxonomy', {}, env as never)
    expect(res.status).toBe(200)
    // The page query's binds carry the reason once (#626: the guard fragment
    // is picked on the reason's presence). find() skips requireAdmin's own
    // user lookup binds.
    const pageBinds = env.DB.bind.mock.calls.find(
      (call: unknown[]) => call.length === 5 && call[0] === 'pending'
    )
    expect(pageBinds).toEqual(['pending', 'pending', 'taxonomy', 50, 0])
  })

  it('rejects an unknown reason with 400 (issue #628)', async () => {
    const res = await apiApp.request('/api/admin/review?reason=bogus', {}, adminEnv() as never)
    expect(res.status).toBe(400)
  })

  it('rejects an invalid decision value with 400', async () => {
    const res = await apiApp.request(
      '/api/admin/review/rev-1/decision',
      {
        method: 'POST',
        body: JSON.stringify({ decision: 'maybe' }),
        headers: { 'Content-Type': 'application/json' },
      },
      adminEnv() as never
    )
    expect(res.status).toBe(400)
  })

  it('404s a decision on an unknown review item', async () => {
    const env = adminEnv()
    // First `first` call is requireAdmin's user lookup (admin passes); the
    // handler's row lookup then finds nothing.
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ email: 'admin@rumaq.dev', is_admin: 1 })
      .mockResolvedValue(null)
    const res = await apiApp.request(
      '/api/admin/review/rev-1/decision',
      {
        method: 'POST',
        body: JSON.stringify({ decision: 'approved' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env as never
    )
    expect(res.status).toBe(404)
  })

  // -- #691 Phase A: the queue-report's per-ID inspection mode. The item
  // SHAPE itself is pinned on real SQLite in review-script-auth.test.ts;
  // these mocked-DB tests pin the routing, validation and the envelope. --

  // prepare call order on the ids path: requireAdmin's admin lookup, the ids
  // prefix read, then (only when something was found) the evidence read.
  function queueReportIdsEnv(inListResults: unknown[]) {
    const env = adminEnv()
    const inListBind = vi.fn().mockReturnThis()
    env.DB.prepare = vi
      .fn()
      .mockReturnValueOnce({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue({ email: 'admin@rumaq.dev', is_admin: 1 }),
      })
      .mockReturnValueOnce({
        bind: inListBind,
        all: vi.fn().mockResolvedValue({ results: inListResults }),
      })
      .mockReturnValueOnce({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [] }),
      })
    return { env, inListBind }
  }

  it('queue-report without ids keeps the aggregate contract byte-for-byte (#691 pin)', async () => {
    const env = adminEnv()
    env.DB.batch = vi.fn().mockResolvedValue([
      { results: [] }, // status counts
      { results: [] }, // pending split by reason
      { results: [] }, // verdict coverage
      { results: [] }, // provider/model mix
      { results: [] }, // confidence bands
      { results: [] }, // agreement
    ])
    const res = await apiApp.request('/api/admin/review/queue-report', {}, env as never)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
    const body = (await res.json()) as Record<string, unknown>
    // The exact aggregate key set — the pre-#691 contract. A future field
    // must extend this assertion deliberately, never leak in ids-only shape.
    expect(Object.keys(body).sort()).toEqual(['agreement', 'ai', 'counts', 'generatedAt'])
    expect(body.counts).toEqual({
      pending: 0,
      approved: 0,
      rejected: 0,
      pendingByReason: { price_ratio: 0, verifier_unresolved: 0, taxonomy: 0 },
    })
    expect(body.ai).toEqual({
      pendingWithVerdict: 0,
      pendingWithoutVerdict: 0,
      models: [],
      confidenceBands: [
        { band: '<0.6', count: 0 },
        { band: '0.6-0.8', count: 0 },
        { band: '>=0.8', count: 0 },
      ],
      autoEligible: 0,
    })
    expect(body.agreement).toEqual([
      { band: '<0.6', decided: 0, agreed: 0, disagreed: 0, precision: null },
      { band: '0.6-0.8', decided: 0, agreed: 0, disagreed: 0, precision: null },
      { band: '>=0.8', decided: 0, agreed: 0, disagreed: 0, precision: null },
    ])
  })

  it('queue-report 400s ids that are neither short hex tokens nor lowercase UUIDs (#691)', async () => {
    const overMax = Array.from({ length: 51 }, (_, i) => i.toString(16).padStart(8, '0')).join(',')
    for (const ids of [
      'zzzz', // not hex
      'ABC123', // uppercase
      'AA11AA11-1111-4111-8111-111111111111', // uppercase full UUID
      'aa11,,bb22', // empty token
      'aa11 bb22', // whitespace separator
      `${'f'.repeat(33)}`, // over the 32-char cap
      overMax, // over the 50-id cap
    ]) {
      const res = await apiApp.request(
        `/api/admin/review/queue-report?ids=${ids}`,
        {},
        adminEnv() as never
      )
      expect(res.status).toBe(400)
    }
  })

  it('queue-report ids mode returns per-id lookups in request order (#691)', async () => {
    const { env, inListBind } = queueReportIdsEnv([queueReportRow()])
    const res = await apiApp.request(
      // Both accepted forms in one request: the 8-hex short id (resolved as a
      // prefix of the row UUID) and a full lowercase UUID.
      '/api/admin/review/queue-report?ids=bb22bb22,aa11aa11-1111-4111-8111-111111111111,deadbeef',
      {},
      env as never
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
    // Each requested id was bound verbatim as its LIKE prefix pattern, in
    // route order — exact-or-prefix resolution (production rows are UUIDs,
    // humans quote the card's short form).
    expect(inListBind).toHaveBeenCalledWith(
      'bb22bb22%',
      'aa11aa11-1111-4111-8111-111111111111%',
      'deadbeef%'
    )
    const body = (await res.json()) as {
      items: Array<{ id: string; found: boolean; item: Record<string, unknown> | null }>
    }
    expect(Object.keys(body).sort()).toEqual(['items'])
    // Entries echo the REQUESTED id verbatim — short or full UUID form.
    expect(body.items).toEqual([
      { id: 'bb22bb22', found: true, item: expect.any(Object) },
      { id: 'aa11aa11-1111-4111-8111-111111111111', found: false, item: null },
      { id: 'deadbeef', found: false, item: null },
    ])
    expect(body.items[0]!.item).toMatchObject({
      id: 'bb22bb22',
      status: 'pending',
      itemName: 'Beras Ramos 5 kg',
      // No observation rows in the evidence read → evidence stays null.
      entryBrochureUrl: null,
      entrySourceUrl: null,
      entryObservedAt: null,
    })
  })

  it('queue-report dedupes repeated ids — the response is a set in request order (#691)', async () => {
    const { env, inListBind } = queueReportIdsEnv([])
    const res = await apiApp.request(
      '/api/admin/review/queue-report?ids=bb22bb22,bb22bb22,aa11aa11',
      {},
      env as never
    )
    expect(res.status).toBe(200)
    expect(inListBind).toHaveBeenCalledWith('bb22bb22%', 'aa11aa11%')
    const body = (await res.json()) as { items: unknown[] }
    expect(body.items).toEqual([
      { id: 'bb22bb22', found: false, item: null },
      { id: 'aa11aa11', found: false, item: null },
    ])
  })

  // #728: the override route's HTTP contract. The write semantics live in the
  // real-SQLite block above; these pin the error mapping and the vocabulary
  // route (the picker's data source).
  it('override rejects a body without a category with 400', async () => {
    const res = await apiApp.request(
      '/api/admin/review/rev-1/category',
      { method: 'POST', body: JSON.stringify({}), headers: { 'Content-Type': 'application/json' } },
      adminEnv() as never
    )
    expect(res.status).toBe(400)
  })

  it('override answers 400 category_unknown for a slug outside the sealed vocabulary', async () => {
    const res = await apiApp.request(
      '/api/admin/review/rev-1/category',
      {
        method: 'POST',
        body: JSON.stringify({ category: 'beras-ramos' }),
        headers: { 'Content-Type': 'application/json' },
      },
      adminEnv() as never
    )
    // The lib validates BEFORE any read/write, so the mock env's empty results
    // never matter — the vocabulary is the first gate.
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'category_unknown' })
  })

  it('serves the sealed vocabulary from the contract constants', async () => {
    const res = await apiApp.request('/api/admin/review/taxonomy/buckets', {}, adminEnv() as never)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
    const body = (await res.json()) as { version: string; buckets: string[] }
    expect(body.version).toBe(TAXONOMY_VERSION)
    // The sealed list is the contract's own array, verbatim — one source.
    expect(body.buckets).toEqual([...TAXONOMY_BUCKETS])
    expect(body.buckets).toHaveLength(49)
    expect(new Set(body.buckets).size).toBe(49)
  })
})

// A full queue-report row for the ids-mode route tests — the projection the
// list/decide reads share (REVIEW_ROW_COLUMNS), with a parseable pair blob.
function queueReportRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'bb22bb22',
    pair_data: JSON.stringify(pair()),
    status: 'pending',
    decided_at: null,
    decided_by: null,
    decided_source: null,
    flag_count: 1,
    first_flagged_at: '2026-11-13T00:00:00Z',
    last_flagged_at: '2026-11-13T00:00:00Z',
    run_started_at: '2026-11-13T00:00:00Z',
    run_id: null,
    item_category: null,
    item_category_version: null,
    ai_verdict: null,
    ai_confidence: null,
    ai_reason: null,
    ai_model: null,
    ai_human_agreement: null,
    ...over,
  }
}

// #691 Phase A: the queue-report's published schema must carry BOTH modes —
// the aggregate (the unchanged contract) and the ids inspection entries — so
// the generated client documents the switch instead of a bare object.
describe('queue-report ids-mode schema (#691 Phase A)', () => {
  it('publishes the ids query param and the oneOf aggregate/inspection response', async () => {
    const specs = (await generateSpecs(apiApp, {
      documentation: { info: { title: 'RumaQ API', version: '0.1.0' } },
    })) as Record<string, any>
    const operation = specs.paths['/api/admin/review/queue-report'].get
    const idsParam = (operation.parameters as Array<Record<string, any>>).find(
      (param) => param.name === 'ids'
    )
    expect(idsParam).toMatchObject({ in: 'query', required: false, schema: { type: 'string' } })
    const schema = operation.responses['200'].content['application/json'].schema
    expect(schema.oneOf).toHaveLength(2)
    const [aggregate, inspection] = schema.oneOf as Array<Record<string, any>>
    expect(Object.keys(aggregate.properties).sort()).toEqual([
      'agreement',
      'ai',
      'counts',
      'generatedAt',
    ])
    const entry = inspection.properties.items.items
    expect(Object.keys(entry.properties).sort()).toEqual(['found', 'id', 'item'])
    // `item` is the queue card's schema by SPREAD (single-owned shape) —
    // nullable because a found row can still carry a malformed blob.
    expect(entry.properties.item.type).toEqual(['object', 'null'])
    expect(entry.properties.item.properties).toEqual(
      expect.objectContaining({
        itemName: expect.any(Object),
        entryObservedAt: expect.any(Object),
        aiVerdict: expect.any(Object),
      })
    )
    expect(operation.responses['400']).toBeDefined()
  })
})

describe('runs ingest ride-along', () => {
  it('persists the report pairs after recording the run', async () => {
    const report = {
      schemaVersion: 1,
      runStartedAt: '2026-10-28T23:00:05Z',
      finishedAt: '2026-10-28T23:04:11Z',
      exitCode: 0,
      status: 'success',
      stage: 'done',
      perStore: {},
      match: {
        exact: 0,
        embedding: 0,
        ai: 0,
        solo: 1,
        reviewItems: 1,
        embeddingsDegraded: false,
        reviewItemPairs: [pair()],
        reviewItemsTotal: 1,
        reviewItemsTruncated: false,
      },
      publish: null,
      error: null,
    }
    // Drive the handler through the app like the automation suite does —
    // via the bearer-secret internal route.
    const res = await apiApp.request(
      '/api/internal/ingest/runs',
      {
        method: 'POST',
        body: JSON.stringify(report),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer s3cret' },
      },
      {
        HAQITA_INGEST_SECRET: 's3cret',
        DB: {
          prepare: vi.fn().mockReturnThis(),
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
          batch: vi.fn().mockResolvedValue([]),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        },
      } as never
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Real-SQLite enrichment semantics (issue #380, thermos A2; store pinning
// per the owner's 2026-11-15 production report): the fake db above matches
// SQL strings, so it cannot pin ORDER BY / tie-break behavior. These run
// fetchEntryEvidence's REAL SQL through a minimal D1-shaped adapter on
// node:sqlite, on the real migration chain.
describe('fetchEntryEvidence — real-SQLite semantics (thermos A2 + store pinning)', () => {
  // One canonical entry sighted by TWO stores; the lotte-mart sighting is
  // the newest overall. A key-only lookup (the pre-pinning #380 code) took
  // that lotte-mart page for every request — the owner's report: an
  // 'alfamart'-labelled card rendering another store's brochure.
  async function seedTwoStoreEntry(sqlite: SqliteDb): Promise<void> {
    applyRealMigrations(sqlite)
    sqlite
      .prepare(
        `INSERT INTO price_products (id, product_key, name)
         VALUES ('prod-1', 'beras--ramos--5-kg', 'Beras Ramos')`
      )
      .run()
    const insertSource = sqlite.prepare(
      `INSERT INTO price_sources (id, slug, name) VALUES (?, ?, ?)`
    )
    insertSource.run('src-superindo', 'superindo', 'Superindo')
    insertSource.run('src-lotte-mart', 'lotte-mart', 'Lotte Mart')

    const insertObs = sqlite.prepare(
      `INSERT INTO price_observations
         (id, product_id, source_id, observed_date, price, match_confidence,
          brochure_url, source_url, scraped_at)
       VALUES (?, 'prod-1', ?, ?, 27000, 1.0, ?, ?, ?)`
    )
    // An older superindo sighting first — it must lose within its own store.
    insertObs.run(
      'obs-old',
      'src-superindo',
      '2026-10-20',
      '/api/brochures/superindo/20261020/old.jpg',
      'https://old.example/',
      '2026-10-20T23:00:05Z'
    )
    // The NEWEST sighting overall, from the other store — exactly the page
    // the unpinned lookup rendered on the wrong card.
    insertObs.run(
      'obs-lotte',
      'src-lotte-mart',
      '2026-10-28',
      '/api/brochures/lotte-mart/20261028/b.jpg',
      'https://b.example/',
      '2026-10-28T23:00:05Z'
    )
    insertObs.run(
      'obs-superindo',
      'src-superindo',
      '2026-10-26',
      '/api/brochures/superindo/20261026/a.jpg',
      'https://a.example/',
      '2026-10-26T23:00:05Z'
    )
  }

  it('picks the latest observation from the FROZEN store — never another store page', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    await seedTwoStoreEntry(sqlite)

    const evidence = await fetchEntryEvidence(sqliteD1(sqlite), [
      { productKey: 'beras--ramos--5-kg', storeSlug: 'superindo' },
    ])
    expect(evidence.get('beras--ramos--5-kg|superindo')).toEqual({
      entryBrochureUrl: '/api/brochures/superindo/20261026/a.jpg',
      entrySourceUrl: 'https://a.example/',
      entryObservedAt: '2026-10-26',
      // QA-07: the latest sighting's struck original price rides the same
      // lookup — null here, the seeded rows predate the column.
      entryOriginalPrice: null,
    })
  })

  it('carries the latest sighting original price — the newest observation wins (QA-07)', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    await seedTwoStoreEntry(sqlite)
    // Only the superindo store's NEWEST sighting (obs-superindo, 2026-10-26)
    // prints a struck original price; its older one does not. The lookup
    // must take the newest row's value, never an older sighting's.
    sqlite
      .prepare(`UPDATE price_observations SET original_price = 32000 WHERE id = 'obs-superindo'`)
      .run()

    const evidence = await fetchEntryEvidence(sqliteD1(sqlite), [
      { productKey: 'beras--ramos--5-kg', storeSlug: 'superindo' },
    ])
    expect(evidence.get('beras--ramos--5-kg|superindo')).toMatchObject({
      entryObservedAt: '2026-10-26',
      entryOriginalPrice: 32000,
    })
  })

  it('returns nothing when the frozen store never sighted the entry — no cross-store fallback', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    await seedTwoStoreEntry(sqlite)

    const evidence = await fetchEntryEvidence(sqliteD1(sqlite), [
      { productKey: 'beras--ramos--5-kg', storeSlug: 'hydro' },
    ])
    expect(evidence.size).toBe(0)
  })

  it('returns nothing for an entry without observations', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyRealMigrations(sqlite)
    const evidence = await fetchEntryEvidence(sqliteD1(sqlite), [
      { productKey: 'never-seen--null--1-kg', storeSlug: 'superindo' },
    ])
    expect(evidence.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Frozen entry evidence — blob-first semantics (#691 RC3, real SQLite): the
// pair blob's flag-time sighting wins PER FIELD, and the store-pinned live
// lookup (#380) fills only the fields an old (pre-#691) blob does not carry.
// The seed's LIVE observation is NEWER than the frozen one on purpose — if
// enrichment ever overwrote a frozen field, the live values would leak into
// the assertions.
describe('frozen entry evidence — blob-first semantics (#691 RC3)', () => {
  const ENTRY_KEY = 'beras--ramos--5-kg'
  const ENTRY_STORE = 'superindo'
  const FROZEN = {
    entryBrochureUrl: '/api/brochures/superindo/20261020/frozen.jpg',
    entrySourceUrl: 'https://frozen.example/',
    entryObservedAt: '2026-10-20',
  }
  const LIVE = {
    entryBrochureUrl: '/api/brochures/superindo/20261026/a.jpg',
    entrySourceUrl: 'https://a.example/',
    entryObservedAt: '2026-10-26',
  }

  function freshSqlite(): SqliteDb {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyRealMigrations(sqlite)
    sqlite
      .prepare(`INSERT INTO price_products (id, product_key, name)
               VALUES ('prod-1', ?, 'Beras Ramos')`)
      .run(ENTRY_KEY)
    sqlite
      .prepare(`INSERT INTO price_sources (id, slug, name)
               VALUES ('src-superindo', 'superindo', 'Superindo')`)
      .run()
    const insertObs = sqlite.prepare(
      `INSERT INTO price_observations
         (id, product_id, source_id, observed_date, price, match_confidence,
          brochure_url, source_url, scraped_at)
       VALUES (?, 'prod-1', 'src-superindo', ?, 27000, 1.0, ?, ?, ?)`
    )
    // The entry's store sighting TWICE: the frozen flag-time sighting and a
    // newer one the campaign rotation produced after the flag (#691's
    // contradiction source). The lookup takes the NEWEST (2026-10-26).
    insertObs.run(
      'obs-live',
      '2026-10-26',
      LIVE.entryBrochureUrl,
      LIVE.entrySourceUrl,
      '2026-10-26T23:00:05Z'
    )
    insertObs.run(
      'obs-frozen',
      '2026-10-20',
      FROZEN.entryBrochureUrl,
      FROZEN.entrySourceUrl,
      '2026-10-20T23:00:05Z'
    )
    return sqlite
  }

  function insertReviewRow(sqlite: SqliteDb, id: string, blob: ReviewItemPair): void {
    sqlite
      .prepare(
        `INSERT INTO match_review_items
           (id, item_product_key, entry_product_key, pair_data, reason, match_method,
            confidence, run_started_at, first_flagged_at, last_flagged_at, status)
         VALUES (?, ?, ?, ?, 'price_ratio', 'exact', 0.9,
                 '2026-10-20T23:00:05Z', '2026-10-20T23:00:05Z', '2026-10-20T23:00:05Z', 'pending')`
      )
      .run(id, `${id}----`, ENTRY_KEY, JSON.stringify(blob))
  }

  const frozenPair = (over: Partial<ReviewItemPair> = {}): ReviewItemPair =>
    pair({ entryProductKey: ENTRY_KEY, entryStore: ENTRY_STORE, ...over })

  it('an old-style blob (no evidence fields) rides the live lookup exactly as before', async () => {
    const sqlite = freshSqlite()
    insertReviewRow(sqlite, 'rev-old', frozenPair())
    const page = await listReviewItems(sqliteD1Batch(sqlite))
    expect(page.items).toHaveLength(1)
    // The pre-#691 byte-compat pin: nulls projected by toReviewItem, filled
    // by the store-pinned lookup — the newest sighting at the frozen store.
    expect(page.items[0]).toMatchObject(LIVE)
  })

  it('a fully frozen blob wins per field — the NEWER live sighting is never applied', async () => {
    const sqlite = freshSqlite()
    insertReviewRow(sqlite, 'rev-frozen', frozenPair(FROZEN))
    const page = await listReviewItems(sqliteD1Batch(sqlite))
    expect(page.items[0]).toMatchObject(FROZEN)
    // Explicit non-overwrite: not one live field leaked through.
    expect(page.items[0]!.entryObservedAt).not.toBe(LIVE.entryObservedAt)
    expect(page.items[0]!.entryBrochureUrl).not.toBe(LIVE.entryBrochureUrl)
    expect(page.items[0]!.entrySourceUrl).not.toBe(LIVE.entrySourceUrl)
  })

  it('a partial blob freezes what it carries — live fills only the null fields', async () => {
    const sqlite = freshSqlite()
    insertReviewRow(
      sqlite,
      'rev-partial',
      frozenPair({ entryBrochureUrl: FROZEN.entryBrochureUrl })
    )
    const page = await listReviewItems(sqliteD1Batch(sqlite))
    expect(page.items[0]).toMatchObject({
      entryBrochureUrl: FROZEN.entryBrochureUrl, // frozen wins
      entrySourceUrl: LIVE.entrySourceUrl, // null → live fills
      entryObservedAt: LIVE.entryObservedAt, // null → live fills
    })
  })

  it('a fully frozen blob still carries the live original price — it never freezes (QA-07)', async () => {
    const sqlite = freshSqlite()
    // The live (newest) sighting prints a struck original price; the frozen
    // flag-time one does not. entryOriginalPrice has no blob counterpart, so
    // even a fully-frozen row takes the live lookup's value — and the frozen
    // fields must STILL win per field.
    sqlite
      .prepare(`UPDATE price_observations SET original_price = 32000 WHERE id = 'obs-live'`)
      .run()
    insertReviewRow(sqlite, 'rev-frozen', frozenPair(FROZEN))
    const page = await listReviewItems(sqliteD1Batch(sqlite))
    expect(page.items[0]).toMatchObject({
      ...FROZEN, // the frozen sighting, untouched
      entryOriginalPrice: 32000, // ...plus the live lookup's original price
    })
    expect(page.items[0]!.entryObservedAt).not.toBe(LIVE.entryObservedAt)
  })

  it('the decide re-read (hydrateReviewRows) applies the same frozen-first rule', async () => {
    const sqlite = freshSqlite()
    insertReviewRow(sqlite, 'rev-frozen', frozenPair(FROZEN))
    // Same adapter shape as the #626 ack test: bound statements run in order,
    // including through db.batch.
    const db = {
      prepare: (sql: string) => ({
        bind: (...params: unknown[]) => ({
          all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
          run: async () => sqlite.prepare(sql).run(...params),
          first: async () => sqlite.prepare(sql).get(...params) ?? null,
        }),
      }),
      batch: async (statements: Array<{ all: () => Promise<unknown> }>) =>
        Promise.all(statements.map((statement) => statement.all())),
    } as unknown as D1Database
    const { item } = await decideReviewItem(db, 'rev-frozen', 'approved', 'admin-1')
    expect(item).toMatchObject({ status: 'approved', ...FROZEN })
  })

  it('the per-ID inspection read applies the same frozen-first rule', async () => {
    const sqlite = freshSqlite()
    insertReviewRow(sqlite, 'rev-frozen', frozenPair(FROZEN))
    const lookups = await fetchReviewItemsByIds(sqliteD1Batch(sqlite), ['rev-frozen'])
    expect(lookups).toHaveLength(1)
    expect(lookups[0]).toMatchObject({ found: true, item: FROZEN })
  })
})

// ---------------------------------------------------------------------------
// Issue #628 reason semantics on REAL SQLite: the fake db above answers by SQL
// string, so it cannot prove the json_extract filter or the pending GROUP BY
// actually do what the API promises. These run listReviewItems' REAL SQL
// through node:sqlite (D1 is SQLite) on the real migration chain — including
// the malformed-blob tolerance the json_valid guard exists for.
describe('listReviewItems — real-SQLite reason semantics (issue #628)', () => {
  function seed(sqlite: SqliteDb): void {
    const insert = sqlite.prepare(
      `INSERT INTO match_review_items
         (id, item_product_key, entry_product_key, pair_data, reason, match_method,
          confidence, run_started_at, first_flagged_at, last_flagged_at, status)
       VALUES (?, ?, ?, ?, ?, 'exact', 0.9,
               '2026-10-28T23:00:05Z', '2026-10-28T23:00:05Z', '2026-10-28T23:00:05Z', ?)`
    )
    const add = (
      id: string,
      reason: ReviewItemPair['reason'],
      status: 'pending' | 'approved' | 'rejected',
      pairData?: string
    ) =>
      insert.run(
        id,
        `${id}----`,
        `${id}--x--`,
        pairData ?? JSON.stringify(pair({ reason })),
        reason,
        status
      )

    add('rev-p1', 'price_ratio', 'pending')
    add('rev-p2', 'price_ratio', 'pending')
    add('rev-v1', 'verifier_unresolved', 'pending')
    add('rev-t1', 'taxonomy', 'pending')
    add('rev-t2', 'taxonomy', 'pending')
    // Decided rows never count in the pending split.
    add('rev-app', 'price_ratio', 'approved')
    // A corrupted legacy blob: json_extract would THROW on it, so the whole
    // list read depends on the json_valid guard. It still counts as pending
    // (the real row exists) but carries no reason.
    add('rev-bad', 'price_ratio', 'pending', '{not json')
  }

  function freshDb(): SqliteDb {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyRealMigrations(sqlite)
    seed(sqlite)
    return sqlite
  }

  it('filters the page and filteredTotal by reason while the counts stay whole-queue', async () => {
    const db = sqliteD1Batch(freshDb())

    const taxonomy = await listReviewItems(db, { reason: 'taxonomy' })
    expect(taxonomy.items.map((item) => item.id).sort()).toEqual(['rev-t1', 'rev-t2'])
    expect(taxonomy.filteredTotal).toBe(2)
    // Counts are exact and filter-independent (same rule as the status counts).
    expect(taxonomy.counts).toEqual({
      pending: 6,
      approved: 1,
      rejected: 0,
      pendingByReason: { price_ratio: 2, verifier_unresolved: 1, taxonomy: 2 },
    })

    const verifier = await listReviewItems(db, { reason: 'verifier_unresolved' })
    expect(verifier.items.map((item) => item.id)).toEqual(['rev-v1'])
    expect(verifier.filteredTotal).toBe(1)
    expect(verifier.counts.pendingByReason.taxonomy).toBe(2)
  })

  it('combines the reason filter with the status filter', async () => {
    const db = sqliteD1Batch(freshDb())
    const approved = await listReviewItems(db, { status: 'approved', reason: 'price_ratio' })
    expect(approved.items.map((item) => item.id)).toEqual(['rev-app'])
    expect(approved.filteredTotal).toBe(1)
    // The status counts still describe the whole queue.
    expect(approved.counts.pending).toBe(6)

    const rejected = await listReviewItems(db, { status: 'rejected', reason: 'price_ratio' })
    expect(rejected.items).toEqual([])
    expect(rejected.filteredTotal).toBe(0)
  })

  it('#626: the default read is the IDENTITY queue — taxonomy excluded, malformed blob still tolerated', async () => {
    const db = sqliteD1Batch(freshDb())
    const page = await listReviewItems(db)
    // The two taxonomy self-pairs are NOT in the default page anymore, and
    // neither do they count in its filteredTotal — the corrupt blob, however,
    // is not a taxonomy flag and stays (in SQL; the pair parser drops it from
    // the rendered page exactly as before issue #628, so 4 counted → 3 shown).
    expect(page.items.map((item) => item.id).sort()).toEqual(['rev-p1', 'rev-p2', 'rev-v1'])
    expect(page.counts).toEqual({
      pending: 6,
      approved: 1,
      rejected: 0,
      // The split is whole-queue and still names the taxonomy backlog.
      pendingByReason: { price_ratio: 2, verifier_unresolved: 1, taxonomy: 2 },
    })
    expect(page.filteredTotal).toBe(4)

    // Filtering must not 500 on the corrupted row: it simply has no reason.
    const price = await listReviewItems(db, { reason: 'price_ratio' })
    expect(price.items.map((item) => item.id).sort()).toEqual(['rev-p1', 'rev-p2'])
    expect(price.filteredTotal).toBe(2)
  })

  it("#626: the taxonomy page carries the item side's assigned category + version", async () => {
    const sqlite = freshDb()
    // The seed helper derives the product key as `${id}----`; give rev-t1's
    // item a real price_products row (category + 0030's version column) and
    // leave rev-t2's missing — both shapes must render.
    sqlite.exec(
      `INSERT INTO price_products (id, product_key, name, category, category_version)
       VALUES ('pp-t1', 'rev-t1----', 'Item rev-t1', 'makanan-minuman', 'v0.4')`
    )
    const page = await listReviewItems(sqliteD1Batch(sqlite), { reason: 'taxonomy' })
    const byId = new Map(page.items.map((item) => [item.id, item]))
    expect(byId.get('rev-t1')).toMatchObject({
      itemCategory: 'makanan-minuman',
      itemCategoryVersion: 'v0.4',
    })
    expect(byId.get('rev-t2')).toMatchObject({ itemCategory: null, itemCategoryVersion: null })
  })

  it('#626 part 2: kind/rulesCategory ride pair_data to the page; the join still owns the category', async () => {
    const sqlite = freshDb()
    // The join answers rev-t1's assigned category from price_products, while
    // the blob carries a STALE same-named field — proving the overlay order
    // keeps the join authoritative (Part 1's invariant) even as the NEW
    // kind/rulesCategory names flow through parseReviewPair → toReviewItem.
    sqlite.exec(
      `INSERT INTO price_products (id, product_key, name, category, category_version)
       VALUES ('pp-t1', 'rev-t1----', 'Item rev-t1', 'makanan-minuman', 'v0.4')`
    )
    const blob = {
      ...pair({ reason: 'taxonomy', confidence: 0.42 }),
      // NOT a contract field — only the spread order keeps this from leaking.
      itemCategory: 'stale-blob-category',
      kind: 'disagreement',
      rulesCategory: 'minyak-goreng',
    }
    sqlite
      .prepare('UPDATE match_review_items SET pair_data = ? WHERE id = ?')
      .run(JSON.stringify(blob), 'rev-t1')

    const page = await listReviewItems(sqliteD1Batch(sqlite), { reason: 'taxonomy' })
    const byId = new Map(page.items.map((item) => [item.id, item]))
    // The emitted fields survive parseReviewPair → toReviewItem untouched.
    expect(byId.get('rev-t1')).toMatchObject({
      kind: 'disagreement',
      rulesCategory: 'minyak-goreng',
    })
    // Join precedence: a same-named blob field NEVER overrides the live join.
    expect(byId.get('rev-t1')).toMatchObject({
      itemCategory: 'makanan-minuman',
      itemCategoryVersion: 'v0.4',
    })
    // An old row without the fields stays clean — no backfill, no fabrication.
    expect(byId.get('rev-t2')!.kind).toBeUndefined()
    expect(byId.get('rev-t2')!.rulesCategory).toBeUndefined()
  })

  it('#626: acknowledgePendingTaxonomy decides every pending self-pair as the acting admin — idempotently', async () => {
    const sqlite = freshDb()
    const db = {
      prepare: (sql: string) => ({
        bind: (...params: unknown[]) => ({
          all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
          run: async () => sqlite.prepare(sql).run(...params),
          first: async () => sqlite.prepare(sql).get(...params) ?? null,
        }),
      }),
      // undoReviewDecision writes through db.batch — same convention as the
      // other adapters: each statement is already bound, run it.
      batch: async (statements: Array<{ all: () => Promise<unknown> }>) =>
        Promise.all(statements.map((statement) => statement.all())),
    } as unknown as D1Database

    const first = await acknowledgePendingTaxonomy(db, 'admin-1', new Date('2026-11-14T00:00:00Z'))
    expect(first).toEqual({ acknowledged: 2, remaining: 0 })

    const rows = sqlite
      .prepare(`SELECT id, status, decided_at, decided_by, decided_source
                FROM match_review_items ORDER BY id`)
      .all() as Array<Record<string, string | null>>
    const byId = new Map(rows.map((row) => [row.id as string, row]))
    const acked = byId.get('rev-t1')!
    expect(acked).toMatchObject({
      status: 'approved',
      decided_by: 'admin-1',
      decided_source: 'human',
      decided_at: '2026-11-14T00:00:00.000Z',
    })
    expect(byId.get('rev-t2')).toMatchObject({ status: 'approved', decided_source: 'human' })
    // Nothing else moves: the price_ratio pair and the corrupt-blob row are
    // not taxonomy flags.
    expect(byId.get('rev-p1')).toMatchObject({ status: 'pending', decided_source: null })
    expect(byId.get('rev-bad')).toMatchObject({ status: 'pending', decided_source: null })

    // A second call is a visible no-op.
    const second = await acknowledgePendingTaxonomy(db, 'admin-1')
    expect(second).toEqual({ acknowledged: 0, remaining: 0 })

    // Per-row undo stays available; the re-ack picks the row back up.
    await undoReviewDecision(db, 'rev-t2')
    const third = await acknowledgePendingTaxonomy(db, 'admin-9')
    expect(third).toEqual({ acknowledged: 1, remaining: 0 })
    expect(
      sqlite
        .prepare(`SELECT decided_by, decided_source FROM match_review_items WHERE id = 'rev-t2'`)
        .get()
    ).toMatchObject({ decided_by: 'admin-9', decided_source: 'human' })
  })
})

// ---------------------------------------------------------------------------
// Human category override (#728) — real-SQLite semantics. The batch's
// guarded UPDATE → gated receipt → gated bump → gated settle chain (and its
// all-or-nothing failure) is the feature's whole correctness story, so these
// run on the real migration chain, not the string-matching fake.
// ---------------------------------------------------------------------------

// A full D1-shaped adapter over node:sqlite (the canonical-products.test.ts
// one): first/all/run plus a batch that mirrors D1's transaction — the CAS
// race and unique-index tests rely on a failed statement rolling the batch
// back. `beforeBatch` is the seam a concurrent writer commits through.
class OverrideStatement {
  constructor(
    private readonly sqlite: SqliteDb,
    readonly sql: string,
    readonly params: unknown[] = []
  ) {}

  bind(...params: unknown[]): OverrideStatement {
    return new OverrideStatement(this.sqlite, this.sql, params)
  }

  async first<T>(): Promise<T | null> {
    return (this.sqlite.prepare(this.sql).get(...this.params) ?? null) as T | null
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.sqlite.prepare(this.sql).all(...this.params) as T[] }
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const info = this.sqlite.prepare(this.sql).run(...this.params)
    return { success: true, meta: { changes: Number(info?.changes ?? 0) } }
  }
}

function runOverrideBatch(sqlite: SqliteDb, statement: OverrideStatement) {
  if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(statement.sql)) {
    return {
      results: sqlite.prepare(statement.sql).all(...statement.params),
      success: true,
      meta: { changes: 0 },
    }
  }
  const info = sqlite.prepare(statement.sql).run(...statement.params)
  return { results: [], success: true, meta: { changes: Number(info?.changes ?? 0) } }
}

function overrideD1(sqlite: SqliteDb, options: { beforeBatch?: () => void } = {}): D1Database {
  let fired = false
  return {
    prepare: (sql: string) => new OverrideStatement(sqlite, sql),
    batch: async (statements: OverrideStatement[]) => {
      if (!fired) {
        fired = true
        options.beforeBatch?.()
      }
      sqlite.exec('BEGIN')
      try {
        const results = statements.map((statement) => runOverrideBatch(sqlite, statement))
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
}

describe('overrideTaxonomyCategory — real-SQLite semantics (#728)', () => {
  const PRODUCT_KEY = 'beras-ramos-5kg----5-kg'
  const OVERRIDE_AT = new Date('2026-11-19T06:00:00.000Z')

  function seed(sqlite: SqliteDb, over: { pairData?: string; status?: string } = {}): void {
    sqlite
      .prepare(
        `INSERT INTO price_products
           (id, product_key, name, category, category_version, metadata_version,
            first_seen_at, last_seen_at, updated_at)
         VALUES ('pp-1', ?, 'Beras Ramos 5 kg', 'snack', 'v0.3', 1,
                 '2026-11-01T00:00:00Z', '2026-11-07T00:00:00Z', '2026-11-01T00:00:00Z')`
      )
      .run(PRODUCT_KEY)
    sqlite
      .prepare(
        `INSERT INTO match_review_items
           (id, item_product_key, entry_product_key, pair_data, reason, match_method,
            confidence, run_started_at, first_flagged_at, last_flagged_at, flag_count, status)
         VALUES ('rev-1', ?, 'beras-ramos-5kg--ramos--5-kg', ?, 'taxonomy', 'exact', 0.42,
                 '2026-11-18T23:00:05Z', '2026-11-18T23:00:05Z', '2026-11-18T23:00:05Z', 1, ?)`
      )
      .run(
        PRODUCT_KEY,
        over.pairData ?? JSON.stringify(pair({ reason: 'taxonomy', confidence: 0.42 })),
        over.status ?? 'pending'
      )
  }

  function freshSqlite(over: { pairData?: string; status?: string } = {}): SqliteDb {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyRealMigrations(sqlite)
    seed(sqlite, over)
    return sqlite
  }

  function receiptRows(sqlite: SqliteDb) {
    return sqlite.prepare('SELECT * FROM price_product_category_audit').all()
  }

  function indexVersion(sqlite: SqliteDb): number {
    return Number(
      sqlite.prepare('SELECT version FROM canonical_index_state WHERE id = 1').get()?.version
    )
  }

  it('writes the category with provenance, appends one receipt, bumps the index, settles the flag — one batch', async () => {
    const sqlite = freshSqlite()
    const item = await overrideTaxonomyCategory(overrideD1(sqlite), {
      reviewItemId: 'rev-1',
      category: 'beras',
      actorUserId: 'admin-1',
      reason: '  rules head was right  ',
      now: OVERRIDE_AT,
    })
    expect(item).toMatchObject({
      id: 'rev-1',
      status: 'approved',
      decidedAt: '2026-11-19T06:00:00.000Z',
      decidedBy: 'admin-1',
      decidedSource: 'human',
      itemCategory: 'beras',
      itemCategoryVersion: TAXONOMY_VERSION,
      itemCategorySource: 'human',
    })

    // The canonical row: the column IS the override surface (no shadow store),
    // stamped with the sealed version it was validated against.
    const product = sqlite
      .prepare(
        'SELECT category, category_version, category_source, metadata_version FROM price_products WHERE id = ?'
      )
      .get('pp-1') as Record<string, unknown>
    expect(product).toEqual({
      category: 'beras',
      category_version: TAXONOMY_VERSION,
      category_source: 'human',
      metadata_version: 2,
    })

    // The receipt: who/when/from → to, the flag link, the version pair.
    const receipts = receiptRows(sqlite)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      product_id: 'pp-1',
      product_key: PRODUCT_KEY,
      actor_user_id: 'admin-1',
      action: 'set',
      old_category: 'snack',
      old_category_version: 'v0.3',
      new_category: 'beras',
      new_category_version: TAXONOMY_VERSION,
      reason: 'rules head was right',
      review_item_id: 'rev-1',
      metadata_version_before: 1,
      metadata_version_after: 2,
      reverts_audit_id: null,
    })

    // Exactly one canonical-index bump — the pipeline picks the corrected
    // category up within its ≤48 h cached-index window.
    expect(indexVersion(sqlite)).toBe(1)
  })

  it('rejects a slug outside the sealed vocabulary before touching anything', async () => {
    const sqlite = freshSqlite()
    // 'beras-ramos' is not a bucket — and the pipeline treats an
    // out-of-domain answer as a hard failure for the same reason: a stray
    // slug pollutes the filter domain permanently.
    await expect(
      overrideTaxonomyCategory(overrideD1(sqlite), {
        reviewItemId: 'rev-1',
        category: 'beras-ramos',
        actorUserId: 'admin-1',
      })
    ).rejects.toMatchObject({ name: 'CategoryUnknownError' })
    expect(receiptRows(sqlite)).toEqual([])
    expect(indexVersion(sqlite)).toBe(0)
    expect(
      sqlite
        .prepare('SELECT category, metadata_version FROM price_products WHERE id = ?')
        .get('pp-1')
    ).toMatchObject({ category: 'snack', metadata_version: 1 })
    expect(
      sqlite.prepare('SELECT status FROM match_review_items WHERE id = ?').get('rev-1')
    ).toMatchObject({ status: 'pending' })
  })

  it('answers category_unchanged without writing — confirming is the ack path', async () => {
    const sqlite = freshSqlite()
    await expect(
      overrideTaxonomyCategory(overrideD1(sqlite), {
        reviewItemId: 'rev-1',
        category: 'snack',
        actorUserId: 'admin-1',
      })
    ).rejects.toMatchObject({ name: 'CategoryUnchangedError' })
    expect(receiptRows(sqlite)).toEqual([])
    expect(indexVersion(sqlite)).toBe(0)
    expect(
      sqlite.prepare('SELECT status FROM match_review_items WHERE id = ?').get('rev-1')
    ).toMatchObject({ status: 'pending' })
  })

  it('loses the from-value CAS cleanly: no receipt, no bump, no settle', async () => {
    const sqlite = freshSqlite()
    const db = overrideD1(sqlite, {
      // A concurrent category write commits between the card's read and the
      // batch: statement (1) must 0-row, and everything gated on it must
      // follow. The flag stays pending — intent is atomic.
      beforeBatch: () =>
        sqlite
          .prepare(
            `UPDATE price_products
             SET category = 'buah', category_version = 'v0.4',
                 metadata_version = 2, updated_at = '2026-11-19T05:00:00.000Z'
             WHERE id = 'pp-1'`
          )
          .run(),
    })
    await expect(
      overrideTaxonomyCategory(db, {
        reviewItemId: 'rev-1',
        category: 'beras',
        actorUserId: 'admin-1',
        now: OVERRIDE_AT,
      })
    ).rejects.toMatchObject({ name: 'StaleCategoryError' })
    expect(receiptRows(sqlite)).toEqual([])
    expect(indexVersion(sqlite)).toBe(0)
    expect(
      sqlite
        .prepare('SELECT status, decided_source FROM match_review_items WHERE id = ?')
        .get('rev-1')
    ).toMatchObject({ status: 'pending', decided_source: null })
    // The concurrent write stands untouched (a stale request writes NOTHING).
    expect(
      sqlite.prepare('SELECT category FROM price_products WHERE id = ?').get('pp-1')
    ).toMatchObject({ category: 'buah' })
  })

  it('moves the category on a decided flag while its decision stands', async () => {
    const sqlite = freshSqlite({ status: 'approved' })
    sqlite
      .prepare(
        `UPDATE match_review_items
         SET decided_at = '2026-11-18T07:00:00.000Z', decided_by = 'admin-2',
             decided_source = 'ai_assist'
         WHERE id = 'rev-1'`
      )
      .run()

    const item = await overrideTaxonomyCategory(overrideD1(sqlite), {
      reviewItemId: 'rev-1',
      category: 'beras',
      actorUserId: 'admin-1',
      now: OVERRIDE_AT,
    })
    // The catalog fix is legitimate on a decided row; the settle's
    // status='pending' guard leaves the existing decision alone.
    expect(item).toMatchObject({
      status: 'approved',
      decidedBy: 'admin-2',
      decidedSource: 'ai_assist',
      itemCategory: 'beras',
      itemCategorySource: 'human',
    })
    expect(receiptRows(sqlite)).toHaveLength(1)
    expect(indexVersion(sqlite)).toBe(1)
  })

  it('404s an unknown review item, an unrenderable pair blob, and a gone product row', async () => {
    const missing = freshSqlite()
    await expect(
      overrideTaxonomyCategory(overrideD1(missing), {
        reviewItemId: 'rev-none',
        category: 'beras',
        actorUserId: 'admin-1',
      })
    ).rejects.toMatchObject({ name: 'ReviewItemNotFoundError' })

    const malformed = freshSqlite({ pairData: '{not json' })
    await expect(
      overrideTaxonomyCategory(overrideD1(malformed), {
        reviewItemId: 'rev-1',
        category: 'beras',
        actorUserId: 'admin-1',
      })
    ).rejects.toMatchObject({ name: 'ReviewItemNotFoundError' })
    expect(receiptRows(malformed)).toEqual([])

    // The flag names a key with no product row: the queue card renders it
    // category-less, and there is nothing to override.
    const noProduct = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyRealMigrations(noProduct)
    noProduct
      .prepare(
        `INSERT INTO match_review_items
           (id, item_product_key, entry_product_key, pair_data, reason, match_method,
            confidence, run_started_at, first_flagged_at, last_flagged_at, flag_count, status)
         VALUES ('rev-1', 'gone--key--1-kg', 'gone--key--1-kg', ?, 'taxonomy', 'exact', 0.4,
                 '2026-11-18T23:00:05Z', '2026-11-18T23:00:05Z', '2026-11-18T23:00:05Z', 1, 'pending')`
      )
      .run(JSON.stringify(pair({ reason: 'taxonomy', itemProductKey: 'gone--key--1-kg' })))
    await expect(
      overrideTaxonomyCategory(overrideD1(noProduct), {
        reviewItemId: 'rev-1',
        category: 'beras',
        actorUserId: 'admin-1',
      })
    ).rejects.toMatchObject({ name: 'ProductNotFoundError' })
  })

  it('normalizes the reason and rejects a control-character one', async () => {
    const sqlite = freshSqlite()
    await overrideTaxonomyCategory(overrideD1(sqlite), {
      reviewItemId: 'rev-1',
      category: 'beras',
      actorUserId: 'admin-1',
      reason: '',
    })
    expect(receiptRows(sqlite)[0]).toMatchObject({ reason: null })

    const second = freshSqlite()
    await expect(
      overrideTaxonomyCategory(overrideD1(second), {
        reviewItemId: 'rev-1',
        category: 'beras',
        actorUserId: 'admin-1',
        reason: 'wrong\u0000reason',
      })
    ).rejects.toMatchObject({ name: 'InvalidReasonError' })
    expect(receiptRows(second)).toEqual([])
  })

  it('surfaces itemCategorySource on the queue read after an override', async () => {
    const sqlite = freshSqlite()
    await overrideTaxonomyCategory(overrideD1(sqlite), {
      reviewItemId: 'rev-1',
      category: 'beras',
      actorUserId: 'admin-1',
    })
    // The override settles the flag (approved), so the read is the approved
    // page — the join carries the new provenance on every status.
    const page = await listReviewItems(sqliteD1Batch(sqlite), {
      status: 'approved',
      reason: 'taxonomy',
    })
    expect(page.items[0]).toMatchObject({
      id: 'rev-1',
      itemCategory: 'beras',
      itemCategorySource: 'human',
    })
  })
})
