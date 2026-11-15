import { describe, it, expect, vi } from 'vite-plus/test'
import { matchesReviewScriptToken, propsOrReviewScriptAuth } from '../auth.js'
import { fetchReviewQueueReport, fetchReviewItemsByIds } from '../lib/match-review.js'
// The queue-report aggregates run on real SQLite (node:sqlite — D1 is
// SQLite) with the repo's migrations applied, same pattern as
// match-review.test.ts: the band/precision math is SQL-adjacent enough that
// a string-matching fake db cannot pin it.
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

// The real-SQL adapter for batch readers (same shape as match-review.test.ts's
// sqliteD1Batch): prepare/bind/all over node:sqlite, batch resolving every
// statement.
function sqliteD1Of(db: SqliteDb): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        all: async () => ({ results: db.prepare(sql).all(...params) }),
      }),
    }),
    batch: async (statements: Array<{ all: () => Promise<{ results: unknown[] }> }>) =>
      Promise.all(statements.map((statement) => statement.all())),
  } as unknown as D1Database
}

function createContext(env: Record<string, unknown>, authHeader?: string) {
  const set = vi.fn()
  const json = vi.fn((body: unknown, status?: number) => ({
    body,
    status,
    headers: { set: vi.fn() },
  }))
  const c = {
    env,
    set,
    json,
    req: {
      // The rejection-log helper (#451 discipline) reads the route pathname.
      url: 'https://rumaq.test/api/admin/review/queue-report',
      header: vi.fn((name: string) =>
        name.toLowerCase() === 'authorization' ? authHeader : undefined
      ),
    },
  }
  return {
    c: c as unknown as Parameters<typeof propsOrReviewScriptAuth>[0],
    set,
    json,
    next: vi.fn(),
  }
}

function adminDbMock(rows: {
  admin?: { id: string } | null
  household?: { household_id: string } | null
}) {
  const prepare = vi
    .fn()
    .mockReturnValueOnce({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(rows.admin === undefined ? undefined : rows.admin),
    })
    .mockReturnValueOnce({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(rows.household === undefined ? undefined : rows.household),
    })
  return { DB: { prepare } }
}

describe('matchesReviewScriptToken', () => {
  const env = { REVIEW_SCRIPT_TOKEN: 'tok-current', REVIEW_SCRIPT_TOKEN_NEXT: 'tok-next' }

  it('accepts the primary token', async () => {
    expect(await matchesReviewScriptToken('tok-current', env)).toBe(true)
  })

  it('accepts the rotation successor', async () => {
    expect(await matchesReviewScriptToken('tok-next', env)).toBe(true)
  })

  it('rejects a wrong token', async () => {
    expect(await matchesReviewScriptToken('tok-wrong', env)).toBe(false)
  })

  it('rejects an empty presentation', async () => {
    expect(await matchesReviewScriptToken('', env)).toBe(false)
  })

  it('rejects everything when no secret is configured', async () => {
    expect(await matchesReviewScriptToken('tok-current', {})).toBe(false)
  })

  it('works with only the primary configured', async () => {
    expect(
      await matchesReviewScriptToken('tok-current', { REVIEW_SCRIPT_TOKEN: 'tok-current' })
    ).toBe(true)
    expect(await matchesReviewScriptToken('tok-next', { REVIEW_SCRIPT_TOKEN: 'tok-current' })).toBe(
      false
    )
  })
})

describe('propsOrReviewScriptAuth', () => {
  it('token path: acts as the admin user and calls next', async () => {
    const env = {
      REVIEW_SCRIPT_TOKEN: 'tok-current',
      ...adminDbMock({ admin: { id: 'admin-1' }, household: { household_id: 'hh-1' } }),
    }
    const { c, next, set } = createContext(env, 'Bearer tok-current')
    await propsOrReviewScriptAuth(c, next)
    expect(next).toHaveBeenCalled()
    expect(set).toHaveBeenCalledWith('userId', 'admin-1')
    expect(set).toHaveBeenCalledWith('householdId', 'hh-1')
  })

  it('token path: 403 when no admin user exists', async () => {
    const env = { REVIEW_SCRIPT_TOKEN: 'tok-current', ...adminDbMock({ admin: null }) }
    const { c, next, json } = createContext(env, 'Bearer tok-current')
    await propsOrReviewScriptAuth(c, next)
    expect(next).not.toHaveBeenCalled()
    expect(json).toHaveBeenCalledWith({ error: 'Forbidden' }, 403)
  })

  it('token path: 403 when the admin has no household', async () => {
    const env = {
      REVIEW_SCRIPT_TOKEN: 'tok-current',
      ...adminDbMock({ admin: { id: 'admin-1' }, household: null }),
    }
    const { c, next, json } = createContext(env, 'Bearer tok-current')
    await propsOrReviewScriptAuth(c, next)
    expect(next).not.toHaveBeenCalled()
    expect(json).toHaveBeenCalledWith({ error: 'Forbidden' }, 403)
  })

  it('a wrong token falls through to the cookie path (401 without a session)', async () => {
    const env = { REVIEW_SCRIPT_TOKEN: 'tok-current' }
    const { c, next, json } = createContext(env, 'Bearer tok-wrong')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await propsOrReviewScriptAuth(c, next)
    expect(next).not.toHaveBeenCalled()
    expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' }, 401)
    // #451 discipline: the rejection is one structured line, token LENGTH
    // only — never the token's content.
    expect(log).toHaveBeenCalledTimes(1)
    const line = JSON.parse(log.mock.calls[0]?.[0] as string) as Record<string, unknown>
    expect(line).toMatchObject({
      evt: 'review_script_token_rejected',
      route: '/api/admin/review/queue-report',
      tokenLength: 'tok-wrong'.length,
      candidates: 1,
      matched: false,
    })
    expect(JSON.stringify(line)).not.toContain('tok-wrong')
    log.mockRestore()
  })

  it('no token and no cookie: cookie path 401 (session middleware untouched)', async () => {
    const env = { REVIEW_SCRIPT_TOKEN: 'tok-current' }
    const { c, next, json } = createContext(env)
    await propsOrReviewScriptAuth(c, next)
    expect(next).not.toHaveBeenCalled()
    expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' }, 401)
  })
})

describe('fetchReviewQueueReport', () => {
  it('aggregates coverage, model mix, bands and agreement from real SQLite', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyRealMigrations(sqlite)
    // 4 pending (3 with verdicts, 1 without) + 3 decided with verdicts:
    //   approved 0.9 agreed · rejected 0.5 disagreed · approved 0.65 with no
    //   recorded agreement (counts toward decided, toward neither pole).
    const items: Array<{
      id: string
      pairReason: string
      status: 'pending' | 'approved' | 'rejected'
      confidence?: number
      provider?: string | null
      model?: string | null
      agreement?: 'agreed' | 'disagreed' | null
    }> = [
      {
        id: 'it-1',
        pairReason: 'price_ratio',
        status: 'pending',
        confidence: 0.9,
        provider: 'google',
        model: 'google/gemini-3.8-flash',
      },
      {
        id: 'it-2',
        pairReason: 'price_ratio',
        status: 'pending',
        confidence: 0.7,
        provider: null,
        model: null,
      },
      {
        id: 'it-3',
        pairReason: 'verifier_unresolved',
        status: 'pending',
        confidence: 0.85,
        provider: 'google',
        model: 'google/gemini-3.8-flash',
      },
      { id: 'it-4', pairReason: 'taxonomy', status: 'pending' },
      {
        id: 'it-5',
        pairReason: 'price_ratio',
        status: 'approved',
        confidence: 0.9,
        provider: 'google',
        model: 'google/gemini-3.8-flash',
        agreement: 'agreed',
      },
      {
        id: 'it-6',
        pairReason: 'price_ratio',
        status: 'rejected',
        confidence: 0.5,
        provider: 'google',
        model: 'google/gemini-3.8-flash',
        agreement: 'disagreed',
      },
      {
        id: 'it-7',
        pairReason: 'price_ratio',
        status: 'approved',
        confidence: 0.65,
        provider: null,
        model: null,
        agreement: null,
      },
    ]
    for (const it of items) {
      sqlite.exec(
        `INSERT INTO match_review_items
           (id, item_product_key, entry_product_key, pair_data, reason, match_method,
            confidence, run_started_at, first_flagged_at, last_flagged_at, status,
            decided_at, decided_by, decided_source)
         VALUES ('${it.id}', 'pk-${it.id}', 'ek-${it.id}', '{"reason":"${it.pairReason}"}',
                 'price_ratio', 'ai', 0.9,
                 '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z',
                 '${it.status}',
                 ${it.status === 'pending' ? 'NULL' : `'2026-11-13T01:00:00Z'`},
                 ${it.status === 'pending' ? 'NULL' : `'admin-1'`}, 'human')`
      )
      if (it.confidence !== undefined) {
        sqlite.exec(
          `INSERT INTO review_ai_verdicts
             (id, review_item_id, verdict, confidence, provider, model, mode, human_agreement)
           VALUES ('v-${it.id}', '${it.id}', 'same', ${it.confidence},
                   ${it.provider ? `'${it.provider}'` : 'NULL'},
                   ${it.model ? `'${it.model}'` : 'NULL'}, 'assist',
                   ${it.agreement ? `'${it.agreement}'` : 'NULL'})`
        )
      }
    }

    const report = await fetchReviewQueueReport(sqliteD1Of(sqlite))

    expect(report.counts).toEqual({
      pending: 4,
      approved: 2,
      rejected: 1,
      pendingByReason: { price_ratio: 2, verifier_unresolved: 1, taxonomy: 1 },
    })
    expect(report.ai.pendingWithVerdict).toBe(3)
    expect(report.ai.pendingWithoutVerdict).toBe(1)
    expect(report.ai.models).toEqual([
      { provider: 'google', model: 'google/gemini-3.8-flash', count: 2 },
      { provider: null, model: null, count: 1 },
    ])
    expect(report.ai.confidenceBands).toEqual([
      { band: '<0.6', count: 0 },
      { band: '0.6-0.8', count: 1 },
      { band: '>=0.8', count: 2 },
    ])
    expect(report.ai.autoEligible).toBe(2)
    expect(report.agreement).toEqual([
      { band: '<0.6', decided: 1, agreed: 0, disagreed: 1, precision: 0 },
      { band: '0.6-0.8', decided: 1, agreed: 0, disagreed: 0, precision: null },
      { band: '>=0.8', decided: 1, agreed: 1, disagreed: 0, precision: 1 },
    ])
  })
})

// #691 Phase A: the queue-report ids mode's per-item read. Real SQLite again:
// the shape and the frozen-vs-CURRENT-evidence contrast are exactly what the
// Phase B diagnosis compares, and the prefix-resolution/enrichment SQL is
// string-matching-fake-proof. Rows are seeded with PRODUCTION-shaped ids —
// the full ingest UUIDs (recordReviewItems binds crypto.randomUUID()) — and
// requested through both forms humans actually hold: the queue card's 8-hex
// short id (#aa11aa11) and the copy button's full UUID. Seeding 8-hex rows is
// what masked the resolution bug this suite now pins.
describe('fetchReviewItemsByIds (#691 Phase A)', () => {
  const PAIR_BLOB = JSON.stringify({
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
  })

  // Production-shaped row ids — the short forms the card renders are their
  // first 8 hex chars.
  const AA11 = 'aa11aa11-1111-4111-8111-111111111111'
  const BB22 = 'bb22bb22-2222-4222-8222-222222222222'
  const CC33 = 'cc33cc33-3333-4333-8333-333333333333'

  function seedItem(
    sqlite: SqliteDb,
    id: string,
    itemProductKey: string,
    entryProductKey: string,
    pairData: string,
    status: string,
    decidedAt: string | null,
    decidedBy: string | null,
    decidedSource: string | null
  ): void {
    sqlite
      .prepare(
        `INSERT INTO match_review_items
           (id, item_product_key, entry_product_key, pair_data, reason, match_method,
            confidence, run_started_at, first_flagged_at, last_flagged_at, status,
            decided_at, decided_by, decided_source)
         VALUES (?, ?, ?, ?,
                 'price_ratio', 'exact', 0.9,
                 '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z',
                 ?, ?, ?, ?)`
      )
      .run(
        id,
        itemProductKey,
        entryProductKey,
        pairData,
        status,
        decidedAt,
        decidedBy,
        decidedSource
      )
  }

  function seedItems(sqlite: SqliteDb): void {
    applyRealMigrations(sqlite)
    // aa11aa11-… pending · bb22bb22-… decided · cc33cc33-… a corrupt legacy
    // blob. Distinct (item, entry) pair keys — the table's natural key is
    // UNIQUE.
    seedItem(
      sqlite,
      AA11,
      'beras-ramos-5kg----5-kg',
      'beras-ramos-5kg--ramos--5-kg',
      PAIR_BLOB,
      'pending',
      null,
      null,
      null
    )
    seedItem(
      sqlite,
      BB22,
      'gula-pasir-1kg----1-kg',
      'gula-pasir-1kg--gulaku--1-kg',
      JSON.stringify({
        ...JSON.parse(PAIR_BLOB),
        itemName: 'Gula Pasir 1 kg',
        itemProductKey: 'gula-pasir-1kg----1-kg',
        itemPrice: 18000,
        entryProductKey: 'gula-pasir-1kg--gulaku--1-kg',
        entryName: 'Gula Gulaku 1 kg',
        entryPrice: 17500,
      }),
      'approved',
      '2026-11-13T01:00:00Z',
      'admin-1',
      'human'
    )
    seedItem(
      sqlite,
      CC33,
      'mi-instant----sesawi',
      'mi-instant--sesawi--63-g',
      '{not json',
      'pending',
      null,
      null,
      null
    )

    // The entry's CURRENT evidence at the frozen store — newer than the flag
    // (2026-11-13) on purpose: the tool must show what the card renders NOW.
    sqlite
      .prepare(`INSERT INTO price_products (id, product_key, name)
                VALUES ('prod-1', 'beras-ramos-5kg--ramos--5-kg', 'Beras Ramos')`)
      .run()
    sqlite
      .prepare(`INSERT INTO price_sources (id, slug, name)
                VALUES ('src-superindo', 'superindo', 'Superindo')`)
      .run()
    sqlite
      .prepare(
        `INSERT INTO price_observations
           (id, product_id, source_id, observed_date, price, match_confidence,
            brochure_url, source_url, scraped_at)
         VALUES ('obs-1', 'prod-1', 'src-superindo', '2026-11-14', 29000, 1.0,
                 '/api/brochures/superindo/20261114/page-3.jpg',
                 'https://www.superindo.co.id/promosi/katalog-super-hemat/',
                 '2026-11-14T23:00:05Z')`
      )
      .run()
  }

  function freshDb(): D1Database {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    seedItems(sqlite)
    return sqliteD1Of(sqlite)
  }

  it('resolves 8-hex short ids to UUID rows — card shape with CURRENT evidence, in requested order', async () => {
    const lookups = await fetchReviewItemsByIds(freshDb(), ['bb22bb22', 'aa11aa11'])
    expect(lookups.map((entry) => entry.id)).toEqual(['bb22bb22', 'aa11aa11'])
    // The resolved row surfaces its FULL ingest UUID in item.id — the
    // disambiguation handle when a short prefix ever matched twice.
    // The decided row: full frozen shape. Its entry has NO observation, so
    // the evidence stays null (renders evidence-less, honestly).
    expect(lookups[0]).toMatchObject({
      id: 'bb22bb22',
      found: true,
      item: {
        id: BB22,
        status: 'approved',
        decidedAt: '2026-11-13T01:00:00Z',
        decidedBy: 'admin-1',
        decidedSource: 'human',
        aiVerdict: null,
        flagCount: 1,
        itemProductKey: 'gula-pasir-1kg----1-kg',
        itemName: 'Gula Pasir 1 kg',
        itemStore: 'lotte-mart',
        itemPrice: 18000,
        entryProductKey: 'gula-pasir-1kg--gulaku--1-kg',
        entryName: 'Gula Gulaku 1 kg',
        entryStore: 'superindo',
        entryPrice: 17500,
        reason: 'price_ratio',
        matchMethod: 'exact',
        entryBrochureUrl: null,
        entrySourceUrl: null,
        entryObservedAt: null,
      },
    })
    // The pending beras row rides the CURRENT evidence — the 2026-11-14
    // observation, newer than the 2026-11-13 flag: what the card renders NOW.
    expect(lookups[1]).toMatchObject({
      id: 'aa11aa11',
      found: true,
      item: {
        id: AA11,
        status: 'pending',
        itemProductKey: 'beras-ramos-5kg----5-kg',
        itemName: 'Beras Ramos 5 kg',
        entryProductKey: 'beras-ramos-5kg--ramos--5-kg',
        entryStore: 'superindo',
        entryBrochureUrl: '/api/brochures/superindo/20261114/page-3.jpg',
        entrySourceUrl: 'https://www.superindo.co.id/promosi/katalog-super-hemat/',
        entryObservedAt: '2026-11-14',
      },
    })
  })

  it('a requested full UUID resolves to the same row as its short prefix', async () => {
    // The copy button form: the pattern can only match its own row.
    const lookups = await fetchReviewItemsByIds(freshDb(), [BB22])
    expect(lookups).toMatchObject([
      { id: BB22, found: true, item: { id: BB22, status: 'approved' } },
    ])
  })

  it('a prefix matching nothing stays found:false — distinct from a prefix matching one row', async () => {
    // The regression this guards: aa11aa11 prefix-resolves a UUID row while
    // deadbeef matches nothing — a short id must never read as "rows gone"
    // when the row exists (the pre-review exact-IN-list failure).
    const lookups = await fetchReviewItemsByIds(freshDb(), ['aa11aa11', 'deadbeef'])
    expect(lookups[0]).toMatchObject({ id: 'aa11aa11', found: true })
    expect(lookups[1]).toEqual({ id: 'deadbeef', found: false, item: null })
  })

  it('a short id matching several rows resolves deterministically to the first id', async () => {
    const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDb
    applyRealMigrations(sqlite)
    const AA11_TWIN = 'aa11aa11-9999-4999-8999-999999999999'
    seedItem(sqlite, AA11, 'p-key-1', 'e-key-1', PAIR_BLOB, 'pending', null, null, null)
    seedItem(sqlite, AA11_TWIN, 'p-key-2', 'e-key-2', PAIR_BLOB, 'pending', null, null, null)
    const lookups = await fetchReviewItemsByIds(sqliteD1Of(sqlite), ['aa11aa11'])
    expect(lookups).toEqual([
      { id: 'aa11aa11', found: true, item: expect.objectContaining({ id: AA11 }) },
    ])
  })

  it('reports a malformed pair blob as found:true with a null item', async () => {
    // The row IS there — the diagnosis tool must see that distinct from an
    // unknown id (which is found:false). toReviewItem drops the unparseable
    // pair, so item is null while found stays true.
    const lookups = await fetchReviewItemsByIds(freshDb(), ['cc33cc33'])
    expect(lookups).toEqual([{ id: 'cc33cc33', found: true, item: null }])
  })

  it('an empty ids list returns an empty items array without querying', async () => {
    expect(await fetchReviewItemsByIds(freshDb(), [])).toEqual([])
  })
})
