import { describe, expect, it, vi } from 'vite-plus/test'
import { parse } from 'valibot'

import { gateway } from '../gateway.js'
import { apiApp } from '../apps/api.js'
import { createDb } from './support/d1-sqlite.js'
import { createBrochuresStub } from './support/env.js'
import { ingestPayloadV2Schema } from '@rumaq/contract'
import fixture from '../../../contract/fixtures/valid/ingest-v2.json'
import type { Env } from '../types.js'

// Gateway dispatch boundary (2026-11-17 nightly publish incident). The apps'
// Hono `onError` handlers answer typed JSON 500s, but a rejection that escapes
// the dispatch itself used to reject `gateway.fetch` outright — Cloudflare
// answered the nightly's final ingest chunk with the generic "Worker threw
// exception" HTML page (error 1101), and the pipeline's failure report carried
// 400 characters of HTML instead of the one message naming the fault.
//
// Two behaviors are pinned here:
//
//  1. a dispatch failure (the CachedApi entrypoint throwing or rejecting) is
//     answered by the boundary's typed JSON 500, logged server-side, with NO
//     fallback re-dispatch: the old catch sat around the whole CachedApi block,
//     so a failed dispatch silently fell through to a SECOND apiApp run — the
//     ingest below re-executed on the fallback path before the eventual escape;
//  2. the production dispatch path itself (ctx.exports.CachedApi → the real
//     entrypoint) still works, so the narrowed catch cannot shadow it.

const SECRET = 'test-secret'
const INGEST_SECRET = 'test-ingest-secret'

function createEnv(db: D1Database, broker: unknown): Env['Bindings'] {
  return {
    DB: db,
    RECEIPTS: {} as R2Bucket,
    BROCHURES: broker as unknown as R2Bucket,
    DOCUMENTS: broker as unknown as R2Bucket,
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    WORKER_JWT_SECRET: SECRET,
    WORKER_ENCRYPTION_KEY: 'test-enc-key',
    HAQITA_INGEST_SECRET: INGEST_SECRET,
    PAGES_ORIGIN: 'https://rumaq.ahaqqu.com',
    EMAIL_AUTH_ENABLED: 'true',
    ASSETS: undefined as unknown as Fetcher,
    TEST_MODE: 'true',
    props: undefined,
  } as unknown as Env['Bindings']
}

function ingestRequest(): Request {
  const payload = parse(ingestPayloadV2Schema, fixture)
  return new Request('https://rumaq.ahaqqu.com/api/internal/ingest/prices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INGEST_SECRET}` },
    body: JSON.stringify(payload),
  })
}

describe('gateway dispatch boundary', () => {
  it('answers a typed 500 when the CachedApi dispatch throws — no fallback re-dispatch', async () => {
    const { sqlite, d1 } = createDb()
    const broker = createBrochuresStub()
    const env = createEnv(d1, broker)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ctx = {
        exports: {
          CachedApi: {
            fetch: () => {
              throw new Error('simulated CachedApi dispatch failure')
            },
          },
        },
      } as unknown as ExecutionContext

      const res = await gateway.fetch(ingestRequest(), env, ctx)

      // The failure is typed, data-free, and cache-suppressed — the pipeline's
      // errorDetail carries `{error: ...}`, not the Cloudflare HTML page.
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'Internal server error' })
      expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
      // The cause is on the server log, not the wire.
      expect(logged.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(
        'simulated CachedApi dispatch failure'
      )
      // The old swallow-and-fall-through re-ran the request on the fallback
      // dispatch — the ingest below actually executed. It must not.
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM price_sources').get()).toEqual({
        count: 0,
      })
    } finally {
      logged.mockRestore()
    }
  })

  it('answers the same typed 500 when the CachedApi dispatch rejects', async () => {
    const { sqlite, d1 } = createDb()
    const broker = createBrochuresStub()
    const env = createEnv(d1, broker)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ctx = {
        exports: {
          CachedApi: {
            fetch: () => Promise.reject(new Error('simulated CachedApi dispatch rejection')),
          },
        },
      } as unknown as ExecutionContext

      const res = await gateway.fetch(ingestRequest(), env, ctx)
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'Internal server error' })
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM price_sources').get()).toEqual({
        count: 0,
      })
    } finally {
      logged.mockRestore()
    }
  })

  it('still dispatches through the exports-wired entrypoint when exports carry it', async () => {
    const { d1 } = createDb()
    const broker = createBrochuresStub()
    const env = createEnv(d1, broker)
    // The CachedApi entrypoint's contract (entrypoints.ts): fetch(request, env)
    // — no execution context, the app must not need one. `cloudflare:workers`
    // cannot load in the unit environment, so the contract is mirrored here.
    const ctx = {
      exports: {
        CachedApi: {
          fetch: (request: Request, entrypointEnv: Env['Bindings']) =>
            apiApp.fetch(request, entrypointEnv),
        },
      },
    } as unknown as ExecutionContext

    const res = await gateway.fetch(ingestRequest(), env, ctx)

    expect(res.status).toBe(200)
    const receipt = (await res.json()) as { accepted: number; productsCreated: number }
    expect(receipt).toMatchObject({ accepted: 1, productsCreated: 1 })
  })

  it('falls back to the direct apiApp dispatch when exports are unavailable', async () => {
    const { d1 } = createDb()
    const broker = createBrochuresStub()
    const env = createEnv(d1, broker)
    // The test/Miniflare shape: no exports member at all.
    const ctx = { exports: undefined } as unknown as ExecutionContext

    const res = await gateway.fetch(ingestRequest(), env, ctx)

    expect(res.status).toBe(200)
    const receipt = (await res.json()) as { accepted: number }
    expect(receipt.accepted).toBe(1)
  })

  it('does not break the app-level typed errors: the ingest route still 400s a bad payload', async () => {
    const { d1 } = createDb()
    const broker = createBrochuresStub()
    const env = createEnv(d1, broker)
    const ctx = { exports: undefined } as unknown as ExecutionContext

    const bad = new Request('https://rumaq.ahaqqu.com/api/internal/ingest/prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INGEST_SECRET}` },
      body: JSON.stringify({ schemaVersion: 1 }),
    })
    const res = await gateway.fetch(bad, env, ctx)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Validation failed')
  })
})
