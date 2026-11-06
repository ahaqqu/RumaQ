import { describe, it, expect } from 'vite-plus/test'
import {
  PLUGIN_ENABLEMENT_SQL,
  HOUSEHOLD_ENABLEMENT_ROWS_SQL,
  resolvePluginEnabled,
  resolveEnabledPluginIds,
  type EnablementSpec,
} from '../plugins/enablement.js'
import { PLUGIN_MANIFESTS } from '../plugins/manifests.js'

// The §4.3 truth table, table-tested: enablement is RESOLVED (optional row
// against the manifest default), explicit rows always win, and a read error
// FAILS CLOSED — the privacy posture the deployment flag deliberately does
// not share. The fake D1 answers only the two statements the resolver owns.

type FirstResult = { row: Record<string, unknown> | null } | { error: unknown }
type AllResult = { rows: Array<Record<string, unknown>> } | { error: unknown }

function createEnablementDb(first?: FirstResult, all?: AllResult): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          if (!first) throw new Error(`fake DB: unexpected first(): ${sql}`)
          if ('error' in first) throw first.error
          return (first.row as unknown) ?? null
        },
        all: async () => {
          if (!all) throw new Error(`fake DB: unexpected all(): ${sql}`)
          if ('error' in all) throw all.error
          return { results: all.rows as never[] }
        },
        run: async () => {
          throw new Error(`fake DB: unexpected run(): ${sql}`)
        },
        raw: async () => {
          throw new Error(`fake DB: unexpected raw(): ${sql}`)
        },
      }),
    }),
  } as unknown as D1Database
}

const spec = (id: string, defaultEnabled: boolean): EnablementSpec => ({ id, defaultEnabled })

// The exact statements the resolver runs — pinned here so a refactor cannot
// quietly change what the gate asks the database (the real-SQL EXPLAIN proof
// of both statements lives in migrations.test.ts).
describe('enablement statements', () => {
  it('asks one indexed question per request and one listing for the bootstrap', () => {
    expect(PLUGIN_ENABLEMENT_SQL).toBe(
      'SELECT status FROM household_plugins WHERE household_id = ? AND plugin_id = ?'
    )
    expect(HOUSEHOLD_ENABLEMENT_ROWS_SQL).toBe(
      'SELECT plugin_id, status FROM household_plugins WHERE household_id = ?'
    )
  })
})

describe('resolvePluginEnabled — the §4.3 truth table', () => {
  it.each([
    ['absent row + default enabled → enabled', null, true, true],
    ['absent row + default disabled → disabled', null, false, false],
    [
      'explicit enabled row + default disabled → enabled (household wins)',
      { status: 'enabled' },
      false,
      true,
    ],
    [
      'explicit disabled row + default enabled → disabled (household wins)',
      { status: 'disabled' },
      true,
      false,
    ],
  ])('%s', async (_name, row, defaultEnabled, expected) => {
    const verdict = await resolvePluginEnabled(
      createEnablementDb({ row }),
      'h1',
      spec('documents', defaultEnabled)
    )
    expect(verdict).toBe(expected)
  })

  it('treats any non-enabled status as disabled (a hand-edited row cannot enable)', async () => {
    // The 0028 CHECK makes this unrepresentable in D1; the resolver's
    // comparison is pinned anyway — only 'enabled' means enabled.
    const verdict = await resolvePluginEnabled(
      createEnablementDb({ row: { status: 'paused' } }),
      'h1',
      spec('documents', true)
    )
    expect(verdict).toBe(false)
  })

  it('fails CLOSED on a read error (privacy posture, §3.3/§4.4)', async () => {
    const verdict = await resolvePluginEnabled(
      createEnablementDb({ error: new Error('D1 unavailable') }),
      'h1',
      spec('documents', true)
    )
    expect(verdict).toBe(false)
  })
})

describe('resolveEnabledPluginIds — the /api/me advertisement (§4.5)', () => {
  const manifests = [spec('a', true), spec('b', false), spec('c', true)]

  it('applies defaults to absent rows and lets explicit rows win, in manifest order', async () => {
    const ids = await resolveEnabledPluginIds(
      createEnablementDb(undefined, {
        rows: [
          { plugin_id: 'a', status: 'disabled' }, // explicit beats the default
          { plugin_id: 'b', status: 'enabled' }, // explicit beats the default
          // c has no row → default enabled
        ],
      }),
      'h1',
      manifests
    )
    expect(ids).toEqual(['b', 'c'])
  })

  it('returns the ids only — never status, never config (ids are the contract)', async () => {
    const ids = await resolveEnabledPluginIds(
      createEnablementDb(undefined, {
        rows: [{ plugin_id: 'a', status: 'enabled' }],
      }),
      'h1',
      manifests
    )
    expect(ids).toEqual(['a', 'c'])
    expect(JSON.stringify(ids)).not.toContain('status')
  })

  it('returns null on a read error — the caller omits the field (absent = all enabled, §4.5)', async () => {
    const ids = await resolveEnabledPluginIds(
      createEnablementDb(undefined, { error: new Error('D1 unavailable') }),
      'h1',
      manifests
    )
    expect(ids).toBeNull()
  })

  it('phase A: every existing household advertises documents (manifest default, zero rows)', async () => {
    const ids = await resolveEnabledPluginIds(
      createEnablementDb(undefined, { rows: [] }),
      'h1',
      PLUGIN_MANIFESTS
    )
    expect(ids).toEqual(['documents'])
  })
})
