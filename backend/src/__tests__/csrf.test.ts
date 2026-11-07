import { describe, it, expect, beforeEach } from 'vite-plus/test'

import { gateway } from '../gateway.js'
import { csrfOriginGuard, CSRF_ORIGIN_MISMATCH } from '../lib/csrf.js'
import { signJwt } from '../auth.js'
import { resetRateLimit } from '../lib/rate-limit.js'
import { createDb, type Db } from './support/d1-sqlite.js'
import { createBrochuresStub } from './support/env.js'
import type { Env } from '../types.js'

// CSRF guard (ahaqqu/RumaQ#528). Two layers of coverage:
//
//  1. the policy itself (`csrfOriginGuard`) on raw Requests — every branch,
//     including the ones that must NOT reject (no Origin, safe methods,
//     bearer/internal machine calls);
//  2. the wiring: real requests through `gateway.fetch` against real SQLite
//     (the migrations chain), proving the guard runs BEFORE any app handler
//     — a cross-origin write leaves no row, a same-origin/no-Origin one does.
//
// The session cookie's `SameSite=Lax` decision is pinned here too: a cookie
// the browser refuses to attach cross-site is the first layer, this guard the
// second.

const SECRET = 'test-secret'
const INGEST_SECRET = 'test-ingest-secret'
// Migration 0002 seeds this user (password `password123`), so the login-cookie
// decision test can drive a real credential check.
const USER_ID = 'fa900ae3-0fc9-4f0c-a6ae-dddf8f8b84bb'
const HOUSEHOLD_ID = 'household-1'

type Broker = ReturnType<typeof createBrochuresStub>

function createEnv(db: D1Database, broker: Broker, overrides: Partial<Env['Bindings']> = {}) {
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
    ...overrides,
  } as Env['Bindings']
}

function seed(sqlite: Db): void {
  sqlite
    .prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)')
    .run(HOUSEHOLD_ID, 'Rumah', USER_ID)
  sqlite
    .prepare('INSERT INTO household_members (id, household_id, user_id, role) VALUES (?, ?, ?, ?)')
    .run('member-1', HOUSEHOLD_ID, USER_ID, 'owner')
  sqlite
    .prepare('INSERT INTO user_settings (id, user_id, active_household_id) VALUES (?, ?, ?)')
    .run('settings-1', USER_ID, HOUSEHOLD_ID)
}

const cookieFor = (sub = USER_ID) =>
  signJwt({ sub, exp: Date.now() + 60_000 }, SECRET).then((token) => `rumaq_session=${token}`)

async function callGateway(
  env: Env['Bindings'],
  input: string,
  init: RequestInit = {}
): Promise<Response> {
  const ctx = { exports: undefined } as unknown as ExecutionContext
  return gateway.fetch(new Request(input, init), env, ctx)
}

// A Hono-less env is enough for the policy tests: only PAGES_ORIGIN is read.
const policyEnv = {
  PAGES_ORIGIN: 'https://rumaq.ahaqqu.com',
} as unknown as Env['Bindings']

function request(origin: string | undefined, init: RequestInit = {}) {
  const headers: Record<string, string> = {}
  if (origin !== undefined) headers.Origin = origin
  return new Request('https://rumaq.ahaqqu.com/api/locations', {
    method: 'POST',
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
  })
}

describe('csrfOriginGuard policy', () => {
  it('rejects a cross-origin state-changing request', async () => {
    const res = csrfOriginGuard(request('https://evil.example'), policyEnv)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    expect(await res!.json()).toEqual({ error: CSRF_ORIGIN_MISMATCH })
    expect(res!.headers.get('Cache-Control')).toBe('private, no-cache')
  })

  it("allows the request's own origin", () => {
    expect(csrfOriginGuard(request('https://rumaq.ahaqqu.com'), policyEnv)).toBeNull()
  })

  it('normalizes default ports before comparing', () => {
    expect(csrfOriginGuard(request('https://rumaq.ahaqqu.com:443'), policyEnv)).toBeNull()
  })

  it('allows an origin on the shared CORS allow-list (local dev SPA)', () => {
    expect(csrfOriginGuard(request('http://localhost:5173'), policyEnv)).toBeNull()
  })

  it('allows a request with no Origin at all (curl / scripted admin)', () => {
    expect(csrfOriginGuard(request(undefined), policyEnv)).toBeNull()
  })

  it('rejects a same-site subdomain origin (SameSite alone would not)', () => {
    const res = csrfOriginGuard(request('https://evil.rumaq.ahaqqu.com'), policyEnv)
    expect(res!.status).toBe(403)
  })

  it('falls back to Referer when Origin is absent', async () => {
    const foreign = request(undefined, { headers: { Referer: 'https://evil.example/page' } })
    expect(csrfOriginGuard(foreign, policyEnv)!.status).toBe(403)
    const same = request(undefined, { headers: { Referer: 'https://rumaq.ahaqqu.com/prices' } })
    expect(csrfOriginGuard(same, policyEnv)).toBeNull()
  })

  it('trusts a present Origin over a same-origin Referer', () => {
    const res = csrfOriginGuard(
      request('https://evil.example', { headers: { Referer: 'https://rumaq.ahaqqu.com/' } }),
      policyEnv
    )
    expect(res!.status).toBe(403)
  })

  it('rejects a malformed or opaque origin', () => {
    expect(csrfOriginGuard(request('not-a-url'), policyEnv)!.status).toBe(403)
    expect(csrfOriginGuard(request('null'), policyEnv)!.status).toBe(403)
  })

  it('only guards state-changing methods', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const req = new Request('https://rumaq.ahaqqu.com/api/locations', {
        method,
        headers: { Origin: 'https://evil.example' },
      })
      expect(csrfOriginGuard(req, policyEnv)).toBeNull()
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const req = new Request('https://rumaq.ahaqqu.com/api/locations', {
        method,
        headers: { Origin: 'https://evil.example' },
      })
      expect(csrfOriginGuard(req, policyEnv)!.status).toBe(403)
    }
  })

  it('reconstructs the own origin from proxy X-Forwarded-* headers', () => {
    const req = new Request('http://worker-internal:8787/api/locations', {
      method: 'POST',
      headers: {
        Origin: 'https://rumaq.ahaqqu.com',
        'X-Forwarded-Host': 'rumaq.ahaqqu.com',
        'X-Forwarded-Proto': 'https',
      },
    })
    expect(csrfOriginGuard(req, policyEnv)).toBeNull()

    // The Docker harness sends a port in the host AND in X-Forwarded-Port.
    const harness = new Request('http://api:8787/api/locations', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:3000',
        'X-Forwarded-Host': 'localhost:3000',
        'X-Forwarded-Port': '3000',
        'X-Forwarded-Proto': 'http',
      },
    })
    expect(csrfOriginGuard(harness, policyEnv)).toBeNull()
  })

  it('exempts bearer-authenticated machine calls', () => {
    const req = request('https://scraper.example', {
      headers: { Authorization: `Bearer ${INGEST_SECRET}` },
    })
    expect(csrfOriginGuard(req, policyEnv)).toBeNull()
  })

  it('exempts the internal secret channel even without a visible bearer header', () => {
    const req = new Request('https://rumaq.ahaqqu.com/api/internal/ingest/runs', {
      method: 'POST',
      headers: { Origin: 'https://scraper.example' },
    })
    expect(csrfOriginGuard(req, policyEnv)).toBeNull()
  })

  it('does not exempt a cookie write just because it names the internal prefix elsewhere', () => {
    const req = new Request('https://rumaq.ahaqqu.com/api/locations/internal', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    })
    expect(csrfOriginGuard(req, policyEnv)!.status).toBe(403)
  })
})

describe('CSRF guard through the gateway (real SQL)', () => {
  let sqlite: Db
  let env: Env['Bindings']
  let broker: Broker

  beforeEach(() => {
    resetRateLimit()
    const db = createDb()
    sqlite = db.sqlite
    seed(sqlite)
    broker = createBrochuresStub()
    env = createEnv(db.d1, broker)
  })

  const locations = () =>
    sqlite.prepare('SELECT COUNT(*) AS n FROM locations').get() as { n: number } | undefined

  it('rejects a cross-origin cookie POST and performs no write', async () => {
    const res = await callGateway(env, 'http://localhost:3000/api/locations', {
      method: 'POST',
      headers: {
        Cookie: await cookieFor(),
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ label: 'Forged' }),
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: CSRF_ORIGIN_MISMATCH })
    expect(locations()?.n).toBe(0)
  })

  it('rejects a cross-origin cookie POST that supplies only a foreign Referer', async () => {
    const res = await callGateway(env, 'http://localhost:3000/api/locations', {
      method: 'POST',
      headers: {
        Cookie: await cookieFor(),
        Referer: 'https://evil.example/form.html',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ label: 'Forged' }),
    })
    expect(res.status).toBe(403)
    expect(locations()?.n).toBe(0)
  })

  it('accepts a same-origin cookie POST', async () => {
    const res = await callGateway(env, 'http://localhost:3000/api/locations', {
      method: 'POST',
      headers: {
        Cookie: await cookieFor(),
        Origin: 'http://localhost:3000',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ label: 'Kulkas Atas' }),
    })
    expect(res.status).toBe(201)
    expect(locations()?.n).toBe(1)
  })

  it('accepts a cookie POST with no Origin and no Referer (curl/scripted admin)', async () => {
    const res = await callGateway(env, 'http://localhost:3000/api/locations', {
      method: 'POST',
      headers: { Cookie: await cookieFor(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Rak Bawah' }),
    })
    expect(res.status).toBe(201)
    expect(locations()?.n).toBe(1)
  })

  it('leaves GET requests with a foreign Origin untouched', async () => {
    const res = await callGateway(env, 'http://localhost:3000/api/locations', {
      headers: { Cookie: await cookieFor(), Origin: 'https://evil.example' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ locations: [] })
  })

  it('guards the other domain apps dispatched by the gateway too', async () => {
    const res = await callGateway(env, 'http://localhost:3000/api/households', {
      method: 'POST',
      headers: {
        Cookie: await cookieFor(),
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Forged Household' }),
    })
    expect(res.status).toBe(403)
    const households = sqlite.prepare('SELECT COUNT(*) AS n FROM households').get() as
      | { n: number }
      | undefined
    expect(households?.n).toBe(1) // only the seeded one
  })

  it('rejects a cross-origin logout and keeps the session alive', async () => {
    const res = await callGateway(env, 'http://localhost:3000/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: await cookieFor(), Origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
    const row = sqlite.prepare('SELECT session_epoch FROM users WHERE id = ?').get(USER_ID) as
      | { session_epoch: number }
      | undefined
    expect(row?.session_epoch).toBe(0)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('accepts a same-origin logout and revokes the session', async () => {
    const res = await callGateway(env, 'http://localhost:3000/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: await cookieFor(), Origin: 'http://localhost:3000' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const row = sqlite.prepare('SELECT session_epoch FROM users WHERE id = ?').get(USER_ID) as
      | { session_epoch: number }
      | undefined
    expect(row?.session_epoch).toBe(1)
  })

  it('lets the bearer ingest channel write with a foreign Origin', async () => {
    const key = 'lotte-mart/20261102/promo.png'
    const res = await callGateway(env, `http://localhost:3000/api/internal/brochures/${key}`, {
      method: 'PUT',
      headers: {
        Origin: 'https://scraper.example',
        Authorization: `Bearer ${INGEST_SECRET}`,
        'Content-Type': 'image/png',
      },
      body: 'png',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(broker.objects.has(key)).toBe(true)
  })

  it('routes internal requests past the guard (401 from the secret check, not 403)', async () => {
    const res = await callGateway(env, 'http://localhost:3000/api/internal/ingest/runs', {
      method: 'POST',
      headers: { Origin: 'https://scraper.example', 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
  })

  it('guards the session-issuing login route (login CSRF) and mints a Lax cookie same-origin', async () => {
    const crossOrigin = await callGateway(env, 'https://rumaq.ahaqqu.com/api/auth/email-login', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@rumaq.dev', password: 'password123' }),
    })
    expect(crossOrigin.status).toBe(403)
    expect(crossOrigin.headers.get('set-cookie')).toBeNull()

    const sameOrigin = await callGateway(env, 'https://rumaq.ahaqqu.com/api/auth/email-login', {
      method: 'POST',
      headers: { Origin: 'https://rumaq.ahaqqu.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@rumaq.dev', password: 'password123' }),
    })
    expect(sameOrigin.status).toBe(200)
    const setCookie = sameOrigin.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('rumaq_session=')
    expect(setCookie).toMatch(/SameSite=Lax/i)
    expect(setCookie).not.toMatch(/SameSite=None/i)
    expect(setCookie).toMatch(/Secure/i)
  })
})
