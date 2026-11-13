import { describe, it, expect, vi } from 'vite-plus/test'
import { matchesReviewScriptToken, propsOrReviewScriptAuth } from '../auth.js'
import { fetchReviewQueueReport } from '../lib/match-review.js'
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
    await propsOrReviewScriptAuth(c, next)
    expect(next).not.toHaveBeenCalled()
    expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' }, 401)
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
