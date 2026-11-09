import { describe, it, expect } from 'vite-plus/test'
import { parse, safeParse } from 'valibot'
import { runReportSchema, RUN_FAILURES_LIMIT } from '@rumaq/contract'
import { recordRunReport, listPriceRuns } from '../lib/price-runs.js'
import { apiApp } from '../apps/api.js'
import { createDb } from './support/d1-sqlite.js'

type FakeRow = Record<string, unknown>
type FakeStatement = { sql: string; params: unknown[] }

function createFakeDb(selects: Array<{ match: RegExp; rows: FakeRow[] }> = []) {
  const statements: FakeStatement[] = []
  const db = {
    prepare(sql: string) {
      const stmt = {
        sql,
        params: [] as unknown[],
        bind(...params: unknown[]) {
          stmt.params = params
          return stmt
        },
        async all() {
          const hit = selects.find((s) => s.match.test(sql))
          return { results: hit ? hit.rows : [] }
        },
        async first() {
          const hit = selects.find((s) => s.match.test(sql))
          return hit && hit.rows.length > 0 ? hit.rows[0] : null
        },
        async run() {
          statements.push({ sql, params: stmt.params })
          return { success: true }
        },
      }
      return stmt
    },
    async batch(bound: FakeStatement[]) {
      return bound.map(() => ({ success: true }))
    },
  }
  return { db: db as unknown as D1Database, statements }
}

function sampleReport() {
  return {
    schemaVersion: 1 as const,
    runStartedAt: '2026-10-26T23:00:05Z',
    finishedAt: '2026-10-26T23:04:11Z',
    exitCode: 0 as const,
    status: 'success' as const,
    stage: 'done' as const,
    perStore: {
      superindo: {
        pagesFound: 2,
        newImages: 1,
        existingImages: 1,
        skipped: 0,
        itemsExtracted: 7,
        itemsRejected: 1,
      },
      // The by-design Tier-3 skip (§2): expected, not a nightly failure.
      'lotte-mart': {
        pagesFound: 0,
        newImages: 0,
        existingImages: 0,
        skipped: 0,
        itemsExtracted: 0,
        itemsRejected: 0,
        error: 'Tier-3 proxy required but LOTTE_PROXY_URL is not configured',
        needsProxy: true,
      },
    },
    match: {
      exact: 5,
      embedding: 1,
      ai: 0,
      solo: 1,
      reviewItems: 0,
      embeddingsDegraded: false,
    },
    publish: { mode: 'published' as const, accepted: 7, skipped: 0 },
    error: null,
  }
}

function sampleReviewPair() {
  return {
    itemProductKey: 'beras-ramos-5kg----5-kg',
    itemName: 'Beras Ramos 5 kg',
    itemBrand: null,
    itemUnit: '5 kg',
    itemPrice: 89000,
    itemEffectiveUnitPrice: 89000,
    itemStore: 'lotte-mart',
    entryProductKey: 'beras-ramos-5kg----5-kg',
    entryName: 'Beras Ramos 5kg',
    entryBrand: null,
    entryUnit: '5 kg',
    entryPrice: 27000,
    entryEffectiveUnitPrice: 27000,
    entryStore: 'superindo',
    matchMethod: 'exact' as const,
    confidence: 1,
    reason: 'price_ratio' as const,
  }
}

describe('runReportSchema', () => {
  it('accepts a canonical report', () => {
    expect(safeParse(runReportSchema, sampleReport()).success).toBe(true)
  })

  it('accepts a report carrying review item pairs (issue #294)', () => {
    const report = {
      ...sampleReport(),
      match: {
        ...sampleReport().match!,
        reviewItemPairs: [sampleReviewPair()],
        reviewItemsTotal: 1,
        reviewItemsTruncated: false,
      },
    }
    expect(safeParse(runReportSchema, report).success).toBe(true)
    expect(parse(runReportSchema, report).match?.reviewItemPairs).toEqual([sampleReviewPair()])
  })

  it('still accepts an old-scraper report without the review fields (additive)', () => {
    // sampleReport() predates issue #294 — no review fields on match.
    expect(sampleReport().match).not.toHaveProperty('reviewItemPairs')
    expect(safeParse(runReportSchema, sampleReport()).success).toBe(true)
  })

  it('rejects a bad review reason, confidence, or truncation flag', () => {
    const withPairs = (over: Record<string, unknown>) => ({
      ...sampleReport(),
      match: { ...sampleReport().match!, reviewItemPairs: [{ ...sampleReviewPair(), ...over }] },
    })
    expect(safeParse(runReportSchema, withPairs({ reason: 'vibes' })).success).toBe(false)
    expect(safeParse(runReportSchema, withPairs({ confidence: 1.5 })).success).toBe(false)
    expect(safeParse(runReportSchema, withPairs({ confidence: -0.1 })).success).toBe(false)
    expect(
      safeParse(runReportSchema, {
        ...sampleReport(),
        match: { ...sampleReport().match!, reviewItemsTruncated: 'yes' },
      }).success
    ).toBe(false)
  })

  it('rejects an over-cap pair array — the 200 transport cap is a checked boundary (thermos A4)', () => {
    const atCap = {
      ...sampleReport(),
      match: {
        ...sampleReport().match!,
        reviewItemPairs: Array.from({ length: 200 }, () => sampleReviewPair()),
      },
    }
    expect(safeParse(runReportSchema, atCap).success).toBe(true)
    const overCap = {
      ...atCap,
      match: { ...atCap.match!, reviewItemPairs: [...atCap.match!.reviewItemPairs!] },
    }
    overCap.match!.reviewItemPairs!.push(sampleReviewPair())
    expect(safeParse(runReportSchema, overCap).success).toBe(false)
  })

  it('rejects an unknown exit code or stage', () => {
    expect(safeParse(runReportSchema, { ...sampleReport(), exitCode: 3 }).success).toBe(false)
    expect(safeParse(runReportSchema, { ...sampleReport(), stage: 'ocr' }).success).toBe(false)
  })

  it('rejects unknown fields (contract drift must be explicit)', () => {
    expect(safeParse(runReportSchema, { ...sampleReport(), surprise: true }).success).toBe(false)
  })

  it('accepts the by-design needs-proxy store state', () => {
    expect(safeParse(runReportSchema, sampleReport()).success).toBe(true)
    // Absent marker on a healthy store stays valid too.
    const withoutMarker = {
      ...sampleReport(),
      perStore: { superindo: sampleReport().perStore['superindo'] },
    }
    expect(safeParse(runReportSchema, withoutMarker).success).toBe(true)
  })

  // Issue #463: the v2 receipt's index version and bounded product summary are
  // additive OPTIONAL fields — schemaVersion stays 1.
  it('accepts a report carrying the v2 receipt fields (issue #463)', () => {
    const report = {
      ...sampleReport(),
      perStore: {
        ...sampleReport().perStore,
        superindo: { ...sampleReport().perStore['superindo'], provisionalMatches: 2 },
      },
      indexVersion: 42,
      products: { created: 5, existing: 2 },
    }
    expect(safeParse(runReportSchema, report).success).toBe(true)
    const parsed = parse(runReportSchema, report)
    expect(parsed.indexVersion).toBe(42)
    expect(parsed.products).toEqual({ created: 5, existing: 2 })
    expect(parsed.perStore['superindo']!.provisionalMatches).toBe(2)
  })

  it('still accepts an old-scraper report without the v2 receipt fields (additive, #463)', () => {
    // sampleReport() predates issue #463 — no indexVersion/products and no
    // per-store provisionalMatches.
    expect(sampleReport()).not.toHaveProperty('indexVersion')
    expect(sampleReport()).not.toHaveProperty('products')
    expect(sampleReport().perStore['superindo']).not.toHaveProperty('provisionalMatches')
    expect(safeParse(runReportSchema, sampleReport()).success).toBe(true)
    // An explicit null (a dry-run report) is valid too.
    expect(
      safeParse(runReportSchema, { ...sampleReport(), indexVersion: null, products: null }).success
    ).toBe(true)
  })

  it('rejects out-of-range or mistyped v2 receipt fields (issue #463)', () => {
    const withReceipt = (over: Record<string, unknown>) => ({
      ...sampleReport(),
      indexVersion: 42,
      products: { created: 5, existing: 2 },
      ...over,
    })
    // indexVersion: integer >= 0, strictly typed.
    expect(safeParse(runReportSchema, withReceipt({ indexVersion: -1 })).success).toBe(false)
    expect(safeParse(runReportSchema, withReceipt({ indexVersion: 1.5 })).success).toBe(false)
    expect(safeParse(runReportSchema, withReceipt({ indexVersion: '42' })).success).toBe(false)
    // products: counts are integers >= 0 and the object is strict.
    expect(
      safeParse(runReportSchema, withReceipt({ products: { created: -1, existing: 2 } })).success
    ).toBe(false)
    expect(
      safeParse(runReportSchema, withReceipt({ products: { created: 1.5, existing: 2 } })).success
    ).toBe(false)
    expect(
      safeParse(runReportSchema, withReceipt({ products: { created: 1, existing: '2' } })).success
    ).toBe(false)
    expect(
      safeParse(runReportSchema, withReceipt({ products: { created: 1, existing: 2, extra: 3 } }))
        .success
    ).toBe(false)
    // per-store provisionalMatches follows the same integer >= 0 rule.
    const withStore = (value: unknown) => ({
      ...sampleReport(),
      perStore: {
        superindo: { ...sampleReport().perStore['superindo'], provisionalMatches: value },
      },
    })
    expect(safeParse(runReportSchema, withStore(0)).success).toBe(true)
    expect(safeParse(runReportSchema, withStore(-1)).success).toBe(false)
    expect(safeParse(runReportSchema, withStore(2.5)).success).toBe(false)
    expect(safeParse(runReportSchema, withStore('2')).success).toBe(false)
  })
})

describe('recordRunReport', () => {
  it('binds the report with JSON-encoded detail objects', async () => {
    const { db, statements } = createFakeDb()
    await recordRunReport(db, sampleReport())
    expect(statements).toHaveLength(1)
    const { sql, params } = statements[0]!
    expect(sql).toContain('ON CONFLICT(run_started_at) DO UPDATE')
    expect(params[1]).toBe('2026-10-26T23:00:05Z')
    expect(params[2]).toBe('2026-10-26T23:04:11Z')
    expect(params[3]).toBe(0)
    expect(params[4]).toBe('success')
    expect(params[5]).toBe('done')
    expect(JSON.parse(params[6] as string)).toEqual(sampleReport().perStore)
    expect(JSON.parse(params[7] as string)).toEqual(sampleReport().match)
    expect(JSON.parse(params[8] as string)).toEqual(sampleReport().publish)
    // Issue #463: an old report's absent receipt fields store as NULL.
    expect(params[9]).toBeNull()
    expect(params[10]).toBeNull()
    expect(params[11]).toBeNull()
  })

  it('stores the v2 receipt fields (issue #463)', async () => {
    const { db, statements } = createFakeDb()
    await recordRunReport(db, {
      ...sampleReport(),
      perStore: {
        ...sampleReport().perStore,
        superindo: { ...sampleReport().perStore['superindo'], provisionalMatches: 2 },
      },
      indexVersion: 42,
      products: { created: 5, existing: 2 },
    })
    const { sql, params } = statements[0]!
    expect(sql).toContain('index_version')
    expect(sql).toContain('products_summary')
    // The receipt fields land in their columns, the upsert refreshes them too.
    expect(params[9]).toBe(42)
    expect(JSON.parse(params[10] as string)).toEqual({ created: 5, existing: 2 })
    expect(sql).toContain('index_version = excluded.index_version')
    // provisionalMatches rides the per_store JSON blob — no column of its own.
    expect(JSON.parse(params[6] as string).superindo.provisionalMatches).toBe(2)
  })

  it('stores null for absent match/publish sections and the error message', async () => {
    const { db, statements } = createFakeDb()
    const failed = {
      ...sampleReport(),
      status: 'failed' as const,
      exitCode: 1 as const,
      match: null,
      publish: null,
      error: 'store superindo failed',
    }
    await recordRunReport(db, failed)
    expect(statements[0]!.params[7]).toBeNull()
    expect(statements[0]!.params[8]).toBeNull()
    expect(statements[0]!.params[11]).toBe('store superindo failed')
  })
})

describe('listPriceRuns', () => {
  it('parses the JSON detail columns and reports the last success', async () => {
    const row = {
      id: 'run-1',
      run_started_at: '2026-10-26T23:00:05Z',
      finished_at: '2026-10-26T23:04:11Z',
      exit_code: 0,
      status: 'success',
      stage: 'done',
      per_store: JSON.stringify(sampleReport().perStore),
      match_stats: JSON.stringify(sampleReport().match),
      publish_result: JSON.stringify(sampleReport().publish),
      error: null,
    }
    const { db } = createFakeDb([{ match: /FROM price_runs/, rows: [row] }])
    const feed = await listPriceRuns(db)
    expect(feed.runs).toHaveLength(1)
    expect(feed.runs[0]!.status).toBe('success')
    expect(feed.runs[0]!.stage).toBe('done')
    expect(feed.runs[0]!.perStore['superindo']!.itemsExtracted).toBe(7)
    expect(feed.runs[0]!.perStore['lotte-mart']!.needsProxy).toBe(true)
    expect(feed.runs[0]!.match!.exact).toBe(5)
    expect(feed.lastSuccessAt).toBe('2026-10-26T23:00:05Z')
  })

  it('survives malformed JSON blobs and looks back beyond the page for a success', async () => {
    const broken = {
      id: 'run-2',
      run_started_at: '2026-10-25T23:00:05Z',
      finished_at: '2026-10-25T23:01:00Z',
      exit_code: 1,
      status: 'failed',
      stage: 'publish',
      per_store: '{not json',
      match_stats: null,
      publish_result: null,
      error: 'boom',
    }
    const { db } = createFakeDb([{ match: /FROM price_runs/, rows: [broken] }])
    const feed = await listPriceRuns(db)
    expect(feed.runs[0]!.perStore).toEqual({})
    expect(feed.runs[0]!.match).toBeNull()
    expect(feed.lastSuccessAt).toBeNull()
  })

  // Issue #463: the receipt columns are returned when present and read as
  // null on pre-#463 rows (the monitor must never break on historical runs).
  it('returns the index version and product summary, null for old rows (issue #463)', async () => {
    const withReceipt = {
      id: 'run-3',
      run_started_at: '2026-10-24T23:00:05Z',
      finished_at: '2026-10-24T23:04:11Z',
      exit_code: 0,
      status: 'success',
      stage: 'done',
      per_store: JSON.stringify({
        superindo: { ...sampleReport().perStore['superindo'], provisionalMatches: 2 },
      }),
      match_stats: null,
      publish_result: JSON.stringify(sampleReport().publish),
      index_version: 42,
      products_summary: JSON.stringify({ created: 5, existing: 2 }),
      error: null,
    }
    const legacy = {
      ...withReceipt,
      id: 'run-4',
      run_started_at: '2026-10-23T23:00:05Z',
      index_version: null,
      products_summary: null,
    }
    const { db } = createFakeDb([{ match: /FROM price_runs/, rows: [withReceipt, legacy] }])
    const feed = await listPriceRuns(db)
    expect(feed.runs[0]!.indexVersion).toBe(42)
    expect(feed.runs[0]!.products).toEqual({ created: 5, existing: 2 })
    expect(feed.runs[0]!.perStore['superindo']!.provisionalMatches).toBe(2)
    expect(feed.runs[1]!.indexVersion).toBeNull()
    expect(feed.runs[1]!.products).toBeNull()
  })

  it('treats a malformed products summary as absent', async () => {
    const row = {
      id: 'run-5',
      run_started_at: '2026-10-22T23:00:05Z',
      finished_at: '2026-10-22T23:04:11Z',
      exit_code: 0,
      status: 'success',
      stage: 'done',
      per_store: JSON.stringify(sampleReport().perStore),
      match_stats: null,
      publish_result: null,
      index_version: 7,
      products_summary: '{not json',
      error: null,
    }
    const { db } = createFakeDb([{ match: /FROM price_runs/, rows: [row] }])
    const feed = await listPriceRuns(db)
    expect(feed.runs[0]!.products).toBeNull()
    expect(feed.runs[0]!.indexVersion).toBe(7)
  })
})

// Issue #463: the end-to-end route shape — POST the report through the real
// handler into a real SQLite (the migration chain, including 0040), then read
// it back through listPriceRuns the way GET /api/admin/price-runs does. The
// static-SELECT fake above cannot prove the columns exist or that the SQL
// binds match them.
describe('runs ingest stores the v2 receipt fields (issue #463)', () => {
  it('persists and returns indexVersion, products, and per-store provisionalMatches', async () => {
    const { d1 } = createDb()
    const report = {
      ...sampleReport(),
      perStore: {
        superindo: { ...sampleReport().perStore['superindo'], provisionalMatches: 3 },
      },
      indexVersion: 42,
      products: { created: 5, existing: 2 },
    }
    const res = await apiApp.request(
      '/api/internal/ingest/runs',
      {
        method: 'POST',
        body: JSON.stringify(report),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer s3cret' },
      },
      { HAQITA_INGEST_SECRET: 's3cret', DB: d1 } as never
    )
    expect(res.status).toBe(200)

    const feed = await listPriceRuns(d1)
    expect(feed.runs).toHaveLength(1)
    expect(feed.runs[0]!.indexVersion).toBe(42)
    expect(feed.runs[0]!.products).toEqual({ created: 5, existing: 2 })
    expect(feed.runs[0]!.perStore['superindo']!.provisionalMatches).toBe(3)
  })

  it('keeps an old report without the fields readable (null receipt columns)', async () => {
    const { d1 } = createDb()
    const res = await apiApp.request(
      '/api/internal/ingest/runs',
      {
        method: 'POST',
        body: JSON.stringify(sampleReport()),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer s3cret' },
      },
      { HAQITA_INGEST_SECRET: 's3cret', DB: d1 } as never
    )
    expect(res.status).toBe(200)

    const feed = await listPriceRuns(d1)
    expect(feed.runs[0]!.indexVersion).toBeNull()
    expect(feed.runs[0]!.products).toBeNull()
    expect(feed.runs[0]!.perStore['superindo']!.provisionalMatches).toBeUndefined()
  })

  // Issue #463 (thermos C1): two invariants the fake-DB tests cannot see.
  // 1. Version 0 is a real canonical index (the initial index), never
  //    "absent" — so neither the write nor the read may turn 0 into NULL
  //    (`||` instead of `??` on either side stayed green before this test).
  // 2. run_started_at is the upsert key, so a replayed report must REFRESH
  //    the receipt columns — dropping products_summary from the DO UPDATE
  //    set (the only assertion was a string match) stayed green too.
  it('keeps index version 0 and refreshes the receipt columns on a replay (issue #463)', async () => {
    const { d1 } = createDb()
    const post = (report: unknown) =>
      apiApp.request(
        '/api/internal/ingest/runs',
        {
          method: 'POST',
          body: JSON.stringify(report),
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer s3cret' },
        },
        { HAQITA_INGEST_SECRET: 's3cret', DB: d1 } as never
      )

    const first = await post({
      ...sampleReport(),
      indexVersion: 0,
      products: { created: 1, existing: 0 },
    })
    expect(first.status).toBe(200)
    const before = await listPriceRuns(d1)
    expect(before.runs[0]!.indexVersion).toBe(0)
    expect(before.runs[0]!.products).toEqual({ created: 1, existing: 0 })

    // Same runStartedAt → the idempotent upsert path, not a second row.
    const replay = await post({
      ...sampleReport(),
      indexVersion: 42,
      products: { created: 5, existing: 2 },
    })
    expect(replay.status).toBe(200)
    const after = await listPriceRuns(d1)
    expect(after.runs).toHaveLength(1)
    expect(after.runs[0]!.indexVersion).toBe(42)
    expect(after.runs[0]!.products).toEqual({ created: 5, existing: 2 })
  })
})

// Issue #537: run cost and per-store failure as first-class typed fields.
// The proof has two halves: the contract validates the new shapes (and the
// closed failure-code enum, which is the whole point of a typed field), and a
// report that carries them survives the real route into D1 — the per-store
// failure rides the `per_store` JSON blob the monitor already reads back.
describe('run report cost and typed failures (issue #537)', () => {
  const usage = {
    ocr: { calls: 2, tokensIn: 2400, tokensOut: 600, cost: 0.00084, costMissing: 0 },
    verifier: { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0, costMissing: 0 },
    embedding: { calls: 1, tokensIn: 90, tokensOut: 0, cost: 0.000002, costMissing: 0 },
    // The stage that had no metering before: a ~1,412-call night.
    decision: { calls: 1412, tokensIn: 491_376, tokensOut: 56_480, cost: 0.060014, costMissing: 3 },
  }

  const blockedFailure = {
    store: 'lotte-mart',
    code: 'blocked' as const,
    message: 'blocked: BrowserTierRequired — Incapsula challenge not cleared; reported per-store',
    blocked: true,
  }

  const runLevelFailure = {
    store: null,
    code: 'publish_failed' as const,
    message: 'publish_failed: ingest POST returned HTTP 500',
  }

  function costReport(over: Record<string, unknown> = {}) {
    return {
      ...sampleReport(),
      ai: { usage },
      failures: [blockedFailure, runLevelFailure],
      perStore: {
        ...sampleReport().perStore,
        'lotte-mart': { ...sampleReport().perStore['lotte-mart'], failure: blockedFailure },
      },
      ...over,
    }
  }

  it('accepts the AI spend block and the typed failures', () => {
    const parsed = safeParse(runReportSchema, costReport())
    expect(parsed.success).toBe(true)
    const report = parse(runReportSchema, costReport())
    expect(report.ai!.usage.decision).toEqual(usage.decision)
    expect(report.perStore['lotte-mart']!.failure).toEqual(blockedFailure)
    expect(report.failures).toEqual([blockedFailure, runLevelFailure])
    // The free-text error stays for humans, next to the typed object.
    expect(report.perStore['lotte-mart']!.error).toContain('LOTTE_PROXY_URL')
  })

  it('still accepts an old report without the fields — additive, schemaVersion stays 1', () => {
    const legacy = sampleReport()
    const parsed = parse(runReportSchema, legacy)
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed).not.toHaveProperty('ai')
    expect(parsed).not.toHaveProperty('failures')
    expect(parsed.perStore['superindo']).not.toHaveProperty('failure')
  })

  it('rejects an unknown failure code — the enum is closed', () => {
    const badCode = { ...blockedFailure, code: 'browser_blocked' }
    expect(
      safeParse(runReportSchema, {
        ...costReport(),
        failures: [badCode],
      }).success
    ).toBe(false)
    expect(
      safeParse(runReportSchema, {
        ...costReport(),
        perStore: {
          ...sampleReport().perStore,
          'lotte-mart': { ...sampleReport().perStore['lotte-mart'], failure: badCode },
        },
      }).success
    ).toBe(false)
  })

  it('rejects an over-cap failure message, an over-cap failures array, and unknown fields', () => {
    const longMessage = { ...blockedFailure, message: 'x'.repeat(501) }
    expect(safeParse(runReportSchema, { ...costReport(), failures: [longMessage] }).success).toBe(
      false
    )
    expect(
      safeParse(runReportSchema, {
        ...costReport(),
        failures: Array.from({ length: RUN_FAILURES_LIMIT + 1 }, () => blockedFailure),
      }).success
    ).toBe(false)
    // strictObject: a field the contract does not define is drift.
    expect(
      safeParse(runReportSchema, {
        ...costReport(),
        failures: [{ ...blockedFailure, stack: 'trace' }],
      }).success
    ).toBe(false)
    // A negative or fractional cost/missing count is not a spend.
    expect(
      safeParse(runReportSchema, {
        ...costReport(),
        ai: { usage: { ...usage, decision: { ...usage.decision, cost: -1 } } },
      }).success
    ).toBe(false)
    expect(
      safeParse(runReportSchema, {
        ...costReport(),
        ai: { usage: { ...usage, decision: { ...usage.decision, costMissing: 1.5 } } },
      }).success
    ).toBe(false)
  })

  it('persists the per-store failure through the real route and reads it back', async () => {
    const { d1 } = createDb()
    const res = await apiApp.request(
      '/api/internal/ingest/runs',
      {
        method: 'POST',
        body: JSON.stringify(costReport()),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer s3cret' },
      },
      { HAQITA_INGEST_SECRET: 's3cret', DB: d1 } as never
    )
    expect(res.status).toBe(200)

    const feed = await listPriceRuns(d1)
    expect(feed.runs).toHaveLength(1)
    expect(feed.runs[0]!.perStore['lotte-mart']!.failure).toEqual(blockedFailure)
    // A blocked store is a reported outcome, not a red run.
    expect(feed.runs[0]!.status).toBe('success')
    expect(feed.runs[0]!.exitCode).toBe(0)
    expect(feed.runs[0]!.perStore['superindo']!.failure).toBeUndefined()
  })
})
