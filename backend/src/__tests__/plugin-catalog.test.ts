import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { pluginsApp } from '../apps/plugins.js'
import { resetRateLimit } from '../lib/rate-limit.js'
import { PLUGIN_MANIFESTS } from '../plugins/manifests.js'
import { deploymentFlagKey } from '../plugins/flags.js'
import type { MockEnv } from './support/env.js'

// The catalog routes run 2-3 reads per request (enablement rows, the cached
// deployment-flags table, and requireOwner's membership lookup on writes), so
// this file routes the fake D1 on SQL fragments (the calendar.test.ts idiom)
// and records every executed statement — tests assert on WHAT was written,
// not when. The real-SQL semantics (upsert, audit receipt, the FK-less
// household survival) are pinned separately in migrations.test.ts.

type Row = Record<string, unknown>

type FakeDb = {
  prepare: (sql: string) => {
    bind: (...params: unknown[]) => {
      first: <T>() => Promise<T | null>
      all: <T>() => Promise<{ results: T[] }>
      run: () => Promise<Record<string, unknown> | undefined>
    }
  }
  batch: (stmts: unknown[]) => Promise<unknown[]>
  log: Array<{ sql: string; params: unknown[] }>
}

function createFakeDb(
  firstRoutes: [RegExp, (params: unknown[]) => Row | null][],
  allRoutes: [RegExp, (params: unknown[]) => Row[]][]
): FakeDb {
  const log: Array<{ sql: string; params: unknown[] }> = []
  const handlers = (
    flat: string,
    sql: string,
    params: unknown[]
  ): {
    first: <T>() => Promise<T | null>
    all: <T>() => Promise<{ results: T[] }>
    run: () => Promise<Record<string, unknown> | undefined>
  } => ({
    first: async <T>() => {
      const hit = firstRoutes.find(([re]) => re.test(flat))
      if (!hit) throw new Error(`fake DB: no first() route for: ${sql}`)
      return ((await hit[1](params)) as T) ?? null
    },
    all: async <T>() => {
      const hit = allRoutes.find(([re]) => re.test(flat))
      if (!hit) throw new Error(`fake DB: no all() route for: ${sql}`)
      return { results: (await hit[1](params)) as T[] }
    },
    run: async () => {
      log.push({ sql: flat, params })
      return undefined
    },
  })
  return {
    log,
    prepare: (sql: string) => {
      const flat = sql.replace(/\s+/g, ' ')
      const bound = handlers(flat, sql, [])
      return {
        // Unbound access matters: the deployment-flags read (flags.ts) is a
        // whole-table statement with no parameters — prepare().all() directly.
        ...bound,
        bind: (...params: unknown[]) => handlers(flat, sql, params),
      }
    },
    batch: async (stmts: unknown[]) => {
      for (const stmt of stmts as Array<{ run: () => Promise<void> }>) {
        await stmt.run()
      }
      return []
    },
  }
}

function createEnv(db: FakeDb, userId = 'u1', overrides: Partial<MockEnv> = {}): MockEnv {
  return {
    DB: db as unknown as MockEnv['DB'],
    RECEIPTS: {},
    BROCHURES: {} as MockEnv['BROCHURES'],
    DOCUMENTS: {} as MockEnv['DOCUMENTS'],
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    WORKER_JWT_SECRET: 'test-secret',
    WORKER_ENCRYPTION_KEY: 'test-enc-key',
    PAGES_ORIGIN: 'http://localhost:5173',
    EMAIL_AUTH_ENABLED: 'false',
    ASSETS: undefined as unknown as Fetcher,
    props: { userId, householdId: 'h1' },
    TEST_MODE: 'true',
    ...overrides,
  }
}

// ibu owns h1; ayah is a plain member — the two roles the toggle cares about.
const CALLER_ROWS: Record<string, Row> = {
  u1: { id: 'h1', name: 'Keluarga Putri', role: 'owner' },
  u2: { id: 'h1', name: 'Keluarga Putri', role: 'member' },
}

const MEMBERSHIP_ROUTE: [RegExp, (params: unknown[]) => Row | null] = [
  /SELECT h\.id, h\.name, m\.role FROM households h JOIN household_members m/,
  (params) => CALLER_ROWS[String(params[0])] ?? null,
]

const ENABLEMENT_ROWS_ROUTE = (rows: Array<{ plugin_id: string; status: string }>) =>
  [/SELECT plugin_id, status FROM household_plugins WHERE household_id = \?/, () => rows] as [
    RegExp,
    (params: unknown[]) => Row[],
  ]

const FLAGS_ROUTE = (rows: Array<{ key: string; value: string }>) =>
  [/SELECT key, value FROM deployment_flags/, () => rows] as [RegExp, (params: unknown[]) => Row[]]

const jsonRequest = (method: string, body: unknown) =>
  ({
    method,
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }) as RequestInit

describe('plugin catalog routes (issue #437)', () => {
  beforeEach(() => {
    resetRateLimit()
  })

  it('401s without a session', async () => {
    const env = createEnv(createFakeDb([MEMBERSHIP_ROUTE], []), 'u1', { props: undefined })
    for (const [method, path, body] of [
      ['GET', '/api/plugins', undefined],
      ['PUT', '/api/plugins/documents/enablement', { status: 'disabled' }],
    ] as const) {
      const res = await pluginsApp.request(
        path,
        body ? jsonRequest(method, body) : ({ method } as RequestInit),
        env
      )
      expect(res.status).toBe(401)
    }
  })

  it('advertises every registered manifest in registry order with its posture', async () => {
    const env = createEnv(
      createFakeDb(
        [],
        [
          ENABLEMENT_ROWS_ROUTE([]),
          FLAGS_ROUTE([{ key: deploymentFlagKey('documents'), value: 'off' }]),
        ]
      )
    )
    const res = await pluginsApp.request('/api/plugins', { method: 'GET' } as RequestInit, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
    const body = (await res.json()) as { plugins: Array<Record<string, unknown>> }
    expect(body.plugins.map((p) => p.id)).toEqual(PLUGIN_MANIFESTS.map((m) => m.id))

    // The documents plugin: absent row + defaultEnabled → enabled by default,
    // the deployment layer off → effective access denied even though the
    // household never chose anything. Every layer is reported separately —
    // the honest posture (issue #437).
    const documents = body.plugins[0]
    expect(documents).toMatchObject({
      id: 'documents',
      name: 'Documents',
      capabilities: ['purge', 'export'],
      default_enabled: true,
      enabled: true,
      source: 'default',
      deployment_available: false,
      plan_entitled: true,
      available: false,
    })
  })

  it('resolves explicit household rows over the default (§4.3 truth table)', async () => {
    const env = createEnv(
      createFakeDb(
        [],
        [ENABLEMENT_ROWS_ROUTE([{ plugin_id: 'documents', status: 'disabled' }]), FLAGS_ROUTE([])]
      )
    )
    const res = await pluginsApp.request('/api/plugins', { method: 'GET' } as RequestInit, env)
    const body = (await res.json()) as { plugins: Array<Record<string, unknown>> }
    expect(body.plugins[0]).toMatchObject({
      enabled: false,
      source: 'household',
      deployment_available: true,
      plan_entitled: true,
      available: false,
    })
  })

  it('writes the enablement row AND the audit event in one batch, then answers the fresh posture', async () => {
    const db = createFakeDb([MEMBERSHIP_ROUTE], [ENABLEMENT_ROWS_ROUTE([]), FLAGS_ROUTE([])])
    const env = createEnv(db)
    const res = await pluginsApp.request(
      '/api/plugins/documents/enablement',
      jsonRequest('PUT', { status: 'disabled' }),
      env
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      id: 'documents',
      enabled: false,
      source: 'household',
      available: false,
      deployment_available: true,
    })

    // The write rode ONE batch: the upsert (status + updated_at only —
    // config_json is untouched) and the lifecycle receipt.
    const written = db.log.filter((entry) => entry.sql.startsWith('INSERT INTO household_plugins'))
    const audited = db.log.filter((entry) =>
      entry.sql.startsWith('INSERT INTO household_plugin_audit')
    )
    expect(written).toHaveLength(1)
    expect(written[0].params).toEqual(['h1', 'documents', 'disabled'])
    expect(audited).toHaveLength(1)
    expect(audited[0].params[1]).toBe('h1')
    expect(audited[0].params[2]).toBe('documents')
    expect(audited[0].params[3]).toBe('u1')
    expect(audited[0].params[4]).toBe('plugin_disabled')
    expect(audited[0].params[0]).toBeTruthy()
  })

  it('is idempotent: setting the resolved state writes nothing and audits nothing', async () => {
    const db = createFakeDb([MEMBERSHIP_ROUTE], [ENABLEMENT_ROWS_ROUTE([]), FLAGS_ROUTE([])])
    const env = createEnv(db)
    const res = await pluginsApp.request(
      '/api/plugins/documents/enablement',
      jsonRequest('PUT', { status: 'enabled' }),
      env
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    // Still the default posture — an explicit "enable" on a default-enabled
    // plugin manufactures no row (and no adoption signal, §3.6).
    expect(body).toMatchObject({ enabled: true, source: 'default' })
    expect(db.log).toEqual([])
  })

  it('answers 403 for a non-owner and 404 for an unknown plugin, writing nothing', async () => {
    const memberDb = createFakeDb([MEMBERSHIP_ROUTE], [ENABLEMENT_ROWS_ROUTE([]), FLAGS_ROUTE([])])
    const memberEnv = createEnv(memberDb, 'u2')
    const forbidden = await pluginsApp.request(
      '/api/plugins/documents/enablement',
      jsonRequest('PUT', { status: 'disabled' }),
      memberEnv
    )
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toMatchObject({ error: 'Only household owners can do that' })

    const unknownDb = createFakeDb([MEMBERSHIP_ROUTE], [ENABLEMENT_ROWS_ROUTE([]), FLAGS_ROUTE([])])
    const unknownEnv = createEnv(unknownDb)
    const missing = await pluginsApp.request(
      '/api/plugins/not-a-plugin/enablement',
      jsonRequest('PUT', { status: 'disabled' }),
      unknownEnv
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: 'Plugin not found' })

    // The 403 ran ahead of the write, and the unknown id never reached one.
    for (const db of [memberDb, unknownDb]) {
      expect(db.log.filter((entry) => entry.sql.startsWith('INSERT'))).toEqual([])
    }
  })

  it('answers 404 when the caller belongs to no household', async () => {
    const db = createFakeDb(
      [[/SELECT h\.id, h\.name, m\.role FROM households h JOIN household_members m/, () => null]],
      [FLAGS_ROUTE([])]
    )
    const env = createEnv(db)
    const res = await pluginsApp.request(
      '/api/plugins/documents/enablement',
      jsonRequest('PUT', { status: 'disabled' }),
      env
    )
    expect(res.status).toBe(404)
  })

  it('rejects a malformed body with 400', async () => {
    const env = createEnv(
      createFakeDb([MEMBERSHIP_ROUTE], [ENABLEMENT_ROWS_ROUTE([]), FLAGS_ROUTE([])])
    )
    const res = await pluginsApp.request(
      '/api/plugins/documents/enablement',
      jsonRequest('PUT', { status: 'paused' }),
      env
    )
    expect(res.status).toBe(400)
  })
})
