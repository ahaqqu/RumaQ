import { describe, it, expect, vi } from 'vite-plus/test'
import type { ReviewItemPair } from '@rumaq/contract'
import { apiApp } from '../apps/api.js'
import {
  recordReviewItems,
  listReviewItems,
  decideReviewItem,
  undoReviewDecision,
  exportReviewDecisions,
} from '../lib/match-review.js'

// The run report ride-along lands pairs in D1 (issue #294). The fake DB
// follows the price-runs.test.ts pattern; the export test drives keyset
// paging for real so the non-truncation pin means something.

type FakeStatement = { sql: string; params: unknown[]; results?: unknown[] }

function createFakeDb(
  config: {
    batchResults?: Array<{ results?: unknown[] }>
    firstRow?: unknown
    exportRows?: Array<Record<string, unknown>>
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
    expect(page.counts).toEqual({ pending: 3, approved: 0, rejected: 1 })
    expect(page.filteredTotal).toBe(3)
  })

  it('binds the requested filter and window', async () => {
    const { db, statements } = createFakeDb({
      batchResults: [{ results: [] }, { results: [] }, { results: [] }],
    })
    await listReviewItems(db, { status: 'approved', limit: 10, offset: 25 })
    const [pageStmt, , filteredStmt] = statements
    expect(pageStmt!.params).toEqual(['approved', 'approved', 10, 25])
    expect(filteredStmt!.params).toEqual(['approved', 'approved'])
    expect(statements[0]!.sql).toContain('LEFT JOIN price_runs p ON p.run_started_at')
    expect(statements[0]!.sql).toContain('ORDER BY r.last_flagged_at DESC')
  })

  it('survives a malformed pair_data blob without losing the rest of the page', async () => {
    const { db } = createFakeDb({
      batchResults: [
        {
          results: [rowFor({ id: 'bad', pair_data: '{not json' }), rowFor({ id: 'good' })],
        },
        { results: [{ status: 'pending', count: 2 }] },
        { results: [{ count: 2 }] },
      ],
    })
    const page = await listReviewItems(db)
    expect(page.items.map((item) => item.id)).toEqual(['good'])
    expect(page.counts.pending).toBe(2)
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
    const update = statements[0]!
    expect(update.sql).toContain('SET status = ?, decided_at = ?, decided_by = ?')
    expect(update.params[0]).toBe('rejected')
    expect(update.params[2]).toBe('admin-9')
  })

  it('overwrites a previous verdict — last verdict wins', async () => {
    const { db, statements } = createFakeDb({ firstRow: decidedRow })
    await decideReviewItem(db, 'rev-1', 'approved', 'admin-1')
    await decideReviewItem(db, 'rev-1', 'rejected', 'admin-2')
    // Each decide = UPDATE then re-SELECT; the second UPDATE carries the
    // newer verdict and admin.
    expect(statements[0]!.params[0]).toBe('approved')
    expect(statements[2]!.params[0]).toBe('rejected')
    expect(statements[2]!.params[2]).toBe('admin-2')
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

  it('streams an empty decisions array when nothing was decided', async () => {
    const { db } = createFakeDb({ exportRows: [] })
    const text = await new Response(exportReviewDecisions(db)).text()
    const parsed = JSON.parse(text) as { schema: number; decisions: unknown[] }
    expect(parsed.schema).toBe(1)
    expect(parsed.decisions).toEqual([])
  })
})

describe('review routes', () => {
  const adminEnv = () => ({
    DB: {
      prepare: vi.fn().mockReturnThis(),
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ email: 'admin@rumaq.dev' }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      batch: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    },
    WORKER_JWT_SECRET: 'test-secret',
    ADMIN_EMAILS: 'admin@rumaq.dev',
    props: { userId: 'admin-1', householdId: 'h1' },
  })

  it('401s logged-out on every review route', async () => {
    const paths: Array<[string, RequestInit]> = [
      ['/api/admin/review', {}],
      ['/api/admin/review/export', {}],
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
        first: vi.fn().mockResolvedValue({ email: 'shopper@rumaq.dev' }),
      },
      ADMIN_EMAILS: 'admin@rumaq.dev',
      props: { userId: 'u2', householdId: 'h1' },
    }
    const paths: Array<[string, RequestInit]> = [
      ['/api/admin/review', {}],
      ['/api/admin/review/export', {}],
      ['/api/admin/review/rev-1/decision', { method: 'POST' }],
      ['/api/admin/review/rev-1/decision', { method: 'DELETE' }],
    ]
    for (const [path, init] of paths) {
      const res = await apiApp.request(path, init, nonAdmin as never)
      expect(res.status).toBe(403)
    }
  })

  it('an admin list request returns 200 with private cache headers', async () => {
    const env = adminEnv()
    env.DB.batch = vi
      .fn()
      .mockResolvedValue([{ results: [] }, { results: [] }, { results: [{ count: 0 }] }])
    const res = await apiApp.request('/api/admin/review', {}, env as never)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
    const body = (await res.json()) as { counts: unknown; filteredTotal: number }
    expect(body.counts).toEqual({ pending: 0, approved: 0, rejected: 0 })
    expect(body.filteredTotal).toBe(0)
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
      .mockResolvedValueOnce({ email: 'admin@rumaq.dev' })
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
