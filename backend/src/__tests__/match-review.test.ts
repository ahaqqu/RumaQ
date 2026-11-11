import { describe, it, expect, vi } from 'vite-plus/test'
import { reviewItemPairSchema, type ReviewItemPair } from '@rumaq/contract'
import { generateSpecs } from 'hono-openapi'
import { apiApp } from '../apps/api.js'
import {
  recordReviewItems,
  listReviewItems,
  decideReviewItem,
  undoReviewDecision,
  exportReviewDecisions,
  fetchEntryEvidence,
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
    run(...params: unknown[]): unknown
    all(...params: unknown[]): Array<Record<string, unknown>>
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
      brochure_url: string | null
      source_url: string | null
      observed_date: string
    }>
  } = {}
) {
  const statements: FakeStatement[] = []
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
          // Entry-evidence enrichment (issue #380): answer with the fixture
          // rows whose product_key is in the bound IN-chunk.
          if (sql.includes('FROM price_observations o') && sql.includes('p.product_key IN')) {
            const keys = stmt.params as string[]
            return {
              results: (config.observationRows ?? []).filter((row) =>
                keys.includes(row.product_key)
              ),
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
      return config.batchResults ?? []
    },
  }
  return { db: db as unknown as D1Database, statements }
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
    // No reason = every reason: the same SQL shape with a NULL bind.
    expect(pageStmt!.params).toEqual(['approved', 'approved', null, null, 10, 25])
    expect(filteredStmt!.params).toEqual(['approved', 'approved', null, null])
    expect(statements[0]!.sql).toContain('LEFT JOIN price_runs p ON p.run_started_at')
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
    expect(statements[0]!.params[5]).toBe(Number.MAX_SAFE_INTEGER)
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
    expect(pageStmt!.params).toEqual(['pending', 'pending', 'taxonomy', 'taxonomy', 50, 0])
    expect(pageStmt!.sql).toContain(`json_extract(r.pair_data, '$.reason')`)
    // The reason filter reaches the total too, or "Showing X of Y" would lie.
    expect(filteredStmt!.params).toEqual(['pending', 'pending', 'taxonomy', 'taxonomy'])
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
      (s) => s.sql.includes('FROM price_observations o') && s.sql.includes('p.product_key IN')
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
    const item = await decideReviewItem(db, 'rev-1', 'approved', 'admin-1')
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
    const item = await decideReviewItem(db, 'rev-1', 'rejected', 'admin-9')
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
    expect(await decideReviewItem(db, 'nope', 'approved', 'admin-1')).toBeNull()
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
          brochure_url: '/api/brochures/superindo/20261028/page-3.jpg',
          source_url: 'https://www.superindo.co.id/promosi/katalog-super-hemat/',
          observed_date: '2026-10-28',
        },
      ],
    })
    const text = await new Response(exportReviewDecisions(db)).text()
    const parsed = JSON.parse(text) as { decisions: Array<Record<string, unknown>> }
    expect(parsed.decisions[0]).toMatchObject({
      entryBrochureUrl: '/api/brochures/superindo/20261028/page-3.jpg',
      entrySourceUrl: 'https://www.superindo.co.id/promosi/katalog-super-hemat/',
      entryObservedAt: '2026-10-28',
    })
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
    // The page query's binds carry the reason twice (status guard + reason
    // guard). find() skips requireAdmin's own user lookup binds.
    const pageBinds = env.DB.bind.mock.calls.find(
      (call: unknown[]) => call.length === 6 && call[0] === 'pending'
    )
    expect(pageBinds).toEqual(['pending', 'pending', 'taxonomy', 'taxonomy', 50, 0])
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
// Real-SQLite enrichment semantics (issue #380, thermos A2): the fake db
// above matches SQL strings, so it cannot pin ORDER BY / tie-break behavior.
// These run fetchEntryEvidence's REAL SQL through a minimal D1-shaped adapter
// on node:sqlite, on the real migration chain.
describe('fetchEntryEvidence — real-SQLite semantics (thermos A2)', () => {
  it('picks the latest observation across sources and breaks an exact tie deterministically', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
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
    // An older sighting first — it must lose to the 10-28 pair below.
    insertObs.run(
      'obs-old',
      'src-superindo',
      '2026-10-20',
      '/api/brochures/superindo/20261020/old.jpg',
      'https://old.example/',
      '2026-10-20T23:00:05Z'
    )
    // An EXACT tie: same observed_date, same scraped_at (scraped_at binds
    // per-payload — ingest.ts) from two different sources. The id tie-break
    // pins the lexicographically-greatest id's evidence on any engine.
    insertObs.run(
      'obs-a',
      'src-superindo',
      '2026-10-28',
      '/api/brochures/superindo/20261028/a.jpg',
      'https://a.example/',
      '2026-10-28T23:00:05Z'
    )
    insertObs.run(
      'obs-b',
      'src-lotte-mart',
      '2026-10-28',
      '/api/brochures/lotte-mart/20261028/b.jpg',
      'https://b.example/',
      '2026-10-28T23:00:05Z'
    )

    const evidence = await fetchEntryEvidence(sqliteD1(sqlite), ['beras--ramos--5-kg'])
    expect(evidence.get('beras--ramos--5-kg')).toEqual({
      entryBrochureUrl: '/api/brochures/lotte-mart/20261028/b.jpg',
      entrySourceUrl: 'https://b.example/',
      entryObservedAt: '2026-10-28',
    })
  })

  it('returns nothing for an entry without observations', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyRealMigrations(sqlite)
    const evidence = await fetchEntryEvidence(sqliteD1(sqlite), ['never-seen--null--1-kg'])
    expect(evidence.size).toBe(0)
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

  it('leaves the no-reason read unchanged and tolerates the malformed blob', async () => {
    const db = sqliteD1Batch(freshDb())
    const page = await listReviewItems(db)
    // Six pending rows exist; the corrupted one is dropped from the page by
    // the pair parser, exactly as before issue #628.
    expect(page.items.map((item) => item.id).sort()).toEqual([
      'rev-p1',
      'rev-p2',
      'rev-t1',
      'rev-t2',
      'rev-v1',
    ])
    expect(page.counts).toEqual({
      pending: 6,
      approved: 1,
      rejected: 0,
      pendingByReason: { price_ratio: 2, verifier_unresolved: 1, taxonomy: 2 },
    })
    expect(page.filteredTotal).toBe(6)

    // Filtering must not 500 on the corrupted row: it simply has no reason.
    const price = await listReviewItems(db, { reason: 'price_ratio' })
    expect(price.items.map((item) => item.id).sort()).toEqual(['rev-p1', 'rev-p2'])
    expect(price.filteredTotal).toBe(2)
  })
})
