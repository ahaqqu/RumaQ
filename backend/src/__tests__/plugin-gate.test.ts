import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { documentsApp } from '../apps/documents.js'
import { resetRateLimit } from '../lib/rate-limit.js'
import {
  createDocumentsHarness,
  createEnv,
  JOIN_ROUTE,
  type Row,
} from './support/documents-harness.js'

// The plugin enablement gate (ahaqqu/RumaQ#435, §4.3): installed after auth
// inside the app, on the same five path patterns the auth lines cover. The
// acceptance matrix: enabled household → 200 (phase-A default, bit-for-bit),
// non-enabled → 404 fail-closed (handler never runs), deployment flag fail-
// open on a D1 error, household enablement fail-closed on a D1 error. The
// two 404 bodies are distinguishable on purpose: the gate answers the
// standard envelope `{"error":"Not found"}` while the vault's own missing
// document answers "Document not found" — the assertion that the handler
// did NOT run rides the spy, the body, and the status together.

// Test routes are searched BEFORE the harness gate defaults, so declaring
// these overrides the absent-row defaults for a single test.
const HOUSEHOLD_PLUGIN_ROW = (
  result: Row | null | { error: unknown }
): [RegExp, (params: unknown[]) => Row | null] => [
  /FROM household_plugins WHERE household_id = \? AND plugin_id = \?/,
  (params) => {
    if (result !== null && typeof result === 'object' && 'error' in result) throw result.error
    return result === null ? null : { plugin_id: params[1] as string, ...result }
  },
]

const DEPLOYMENT_FLAG_ROWS = (
  rows: Row[] | { error: unknown }
): [RegExp, (params: unknown[]) => Row[]] => [
  /SELECT key, value FROM deployment_flags/,
  () => {
    if (!Array.isArray(rows)) throw rows.error
    return rows
  },
]

// The route handler the gate sits in front of — the spy proves WHO answered.
const SPY_JOIN_ROUTE = (calls: string[]): [RegExp, (params: unknown[]) => Row[]] => [
  JOIN_ROUTE,
  (params) => {
    calls.push(String(params[0] ?? ''))
    return []
  },
]

const FLAG_ON: Row[] = [{ key: 'plugin.documents.available', value: 'on' }]
const FLAG_OFF: Row[] = [{ key: 'plugin.documents.available', value: 'off' }]

describe('plugin gate — documents routes (#435)', () => {
  const h = createDocumentsHarness()

  beforeEach(() => {
    resetRateLimit()
  })

  it('phase-A default (absent rows, flag absent) behaves bit-for-bit: 200', async () => {
    // The harness defaults ARE the phase-A state: no household_plugins rows
    // (manifest defaultEnabled: true), empty deployment_flags.
    const { env } = h.setup()
    const res = await documentsApp.request('/api/documents', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { documents: unknown[] }
    expect(body.documents).toEqual([])
  })

  it('explicitly disabled household → 404 fail-closed, handler never runs', async () => {
    const calls: string[] = []
    const { env } = h.setup(
      [HOUSEHOLD_PLUGIN_ROW({ plugin_id: 'documents', status: 'disabled' })],
      [SPY_JOIN_ROUTE(calls)]
    )
    const res = await documentsApp.request('/api/documents', {}, env)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
    expect(calls).toEqual([])
  })

  it('explicitly enabled household → 200 (explicit rows always win)', async () => {
    const calls: string[] = []
    const { env } = h.setup(
      [HOUSEHOLD_PLUGIN_ROW({ plugin_id: 'documents', status: 'enabled' })],
      [SPY_JOIN_ROUTE(calls)]
    )
    const res = await documentsApp.request('/api/documents', {}, env)
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  it('deployment flag off → 404 for everyone (the ops kill-switch)', async () => {
    const calls: string[] = []
    const { env } = h.setup(
      [HOUSEHOLD_PLUGIN_ROW({ status: 'enabled' })],
      [SPY_JOIN_ROUTE(calls), DEPLOYMENT_FLAG_ROWS(FLAG_OFF)]
    )
    const res = await documentsApp.request('/api/documents', {}, env)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
    expect(calls).toEqual([])
  })

  it('deployment flag read error → FAIL-OPEN: the vault stays up', async () => {
    const calls: string[] = []
    const { env } = h.setup(
      [HOUSEHOLD_PLUGIN_ROW({ status: 'enabled' })],
      [SPY_JOIN_ROUTE(calls), DEPLOYMENT_FLAG_ROWS({ error: new Error('D1 unavailable') })]
    )
    const res = await documentsApp.request('/api/documents', {}, env)
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  it('household enablement read error → FAIL-CLOSED: 404, handler never runs', async () => {
    const calls: string[] = []
    const { env } = h.setup(
      [HOUSEHOLD_PLUGIN_ROW({ error: new Error('D1 unavailable') })],
      [SPY_JOIN_ROUTE(calls), DEPLOYMENT_FLAG_ROWS(FLAG_ON)]
    )
    const res = await documentsApp.request('/api/documents', {}, env)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
    expect(calls).toEqual([])
  })

  it('the gate sits AFTER auth: no session still answers 401, not 404', async () => {
    const calls: string[] = []
    const { db } = h.setup([HOUSEHOLD_PLUGIN_ROW({ status: 'disabled' })], [SPY_JOIN_ROUTE(calls)])
    const unauth = await documentsApp.request(
      '/api/documents',
      {},
      createEnv(db, { props: undefined })
    )
    expect(unauth.status).toBe(401)
    expect(calls).toEqual([])
  })

  it('gates the :id depth too — disabled 404s before the handler, enabled reaches it', async () => {
    const calls: string[] = []
    const { env } = h.setup([HOUSEHOLD_PLUGIN_ROW({ status: 'disabled' })], [SPY_JOIN_ROUTE(calls)])
    const disabled = await documentsApp.request('/api/documents/doc-1', {}, env)
    expect(disabled.status).toBe(404)
    expect(await disabled.json()).toEqual({ error: 'Not found' })
    expect(calls).toEqual([])

    // Same route with the gate satisfied: the HANDLER answers — its 404 is
    // the vault's own "Document not found", not the gate's envelope.
    const callsEnabled: string[] = []
    const { env: enabledEnv } = h.setup([], [SPY_JOIN_ROUTE(callsEnabled)])
    const enabled = await documentsApp.request('/api/documents/doc-1', {}, enabledEnv)
    expect(enabled.status).toBe(404)
    expect(await enabled.json()).toEqual({ error: 'Document not found' })
    expect(callsEnabled).toHaveLength(1)
  })
})
