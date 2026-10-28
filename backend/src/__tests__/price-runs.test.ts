import { describe, it, expect } from 'vite-plus/test'
import { parse, safeParse } from 'valibot'
import { runReportSchema } from '@rumaq/contract'
import { recordRunReport, listPriceRuns } from '../lib/price-runs.js'

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
    expect(params[9]).toBeNull()
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
    expect(statements[0]!.params[9]).toBe('store superindo failed')
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
})
