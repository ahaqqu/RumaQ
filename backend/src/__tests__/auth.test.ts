import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test'
import {
  verifyJwt,
  signJwt,
  base64UrlEncode,
  base64UrlDecode,
  randomState,
  hashPassword,
  verifyPassword,
} from '../auth.js'
import { authApp } from '../apps/auth.js'
import { resetRateLimit } from '../lib/rate-limit.js'

const SECRET = 'test-secret-12345'

// The /email-login limiter (QA-F4) keys the module-global window — tests must
// start from an empty one, or counts leak across cases.
beforeEach(() => {
  resetRateLimit()
})

describe('base64UrlEncode / base64UrlDecode', () => {
  it('round-trips a buffer', () => {
    const input = new TextEncoder().encode('hello world')
    const encoded = base64UrlEncode(input)
    const decoded = base64UrlDecode(encoded)
    expect(new TextDecoder().decode(decoded)).toBe('hello world')
  })

  it('encodes without padding or +/', () => {
    const input = new TextEncoder().encode('test')
    const encoded = base64UrlEncode(input)
    expect(encoded).not.toContain('=')
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
  })

  it('decodes properly padded base64url', () => {
    const decoded = base64UrlDecode('dGVzdA')
    expect(new TextDecoder().decode(decoded)).toBe('test')
  })

  it('encodes empty buffer', () => {
    const input = new Uint8Array(0)
    expect(base64UrlEncode(input)).toBe('')
  })
})

describe('signJwt / verifyJwt', () => {
  it('signJwt produces a 3-part token', async () => {
    const token = await signJwt({ sub: 'u1' }, SECRET)
    expect(token.split('.')).toHaveLength(3)
  })

  it('round-trips with verifyJwt', async () => {
    const token = await signJwt({ sub: 'u1', email: 'a@b.com' }, SECRET)
    const payload = await verifyJwt(token, SECRET)
    expect(payload).not.toBeNull()
    expect((payload as any).sub).toBe('u1')
    expect((payload as any).email).toBe('a@b.com')
  })

  it('returns null for a tampered token', async () => {
    const token = await signJwt({ sub: 'u1' }, SECRET)
    const [h, p] = token.split('.')
    const tampered = `${h}.${p}.invalidsig`
    const payload = await verifyJwt(tampered, SECRET)
    expect(payload).toBeNull()
  })

  it('returns null for a token with wrong secret', async () => {
    const token = await signJwt({ sub: 'u1' }, SECRET)
    const payload = await verifyJwt(token, 'wrong-secret')
    expect(payload).toBeNull()
  })

  it('returns null for an expired token', async () => {
    const token = await signJwt({ sub: 'u1', exp: Date.now() - 1000 }, SECRET)
    const payload = await verifyJwt(token, SECRET)
    expect(payload).toBeNull()
  })

  it('accepts a token that has not expired yet', async () => {
    const token = await signJwt({ sub: 'u1', exp: Date.now() + 60_000 }, SECRET)
    const payload = await verifyJwt(token, SECRET)
    expect(payload).not.toBeNull()
  })

  it('returns null for malformed token strings', async () => {
    expect(await verifyJwt('', SECRET)).toBeNull()
    expect(await verifyJwt('a.b', SECRET)).toBeNull()
    expect(await verifyJwt('a.b.c.d', SECRET)).toBeNull()
    expect(await verifyJwt('not-a-jwt', SECRET)).toBeNull()
  })

  it('preserves extra payload fields', async () => {
    const token = await signJwt({ sub: 'u1', iat: Date.now() }, SECRET)
    const payload = await verifyJwt(token, SECRET)
    expect(payload).toHaveProperty('iat')
  })
})

afterEach(() => {
  delete (globalThis as any).fetch
})

describe('randomState', () => {
  it('returns a base64url string', () => {
    const state = randomState()
    expect(typeof state).toBe('string')
    expect(state.length).toBeGreaterThan(0)
    expect(state).not.toContain('+')
    expect(state).not.toContain('/')
    expect(state).not.toContain('=')
  })

  it('produces different values on each call', () => {
    const s1 = randomState()
    const s2 = randomState()
    expect(s1).not.toBe(s2)
  })
})

describe('hashPassword / verifyPassword', () => {
  it('hashPassword returns a pbkdf2_sha256 formatted string', async () => {
    const hash = await hashPassword('password123')
    expect(hash).toMatch(/^pbkdf2_sha256\$100000\$/)
    const parts = hash.split('$')
    expect(parts).toHaveLength(4)
  })

  it('verifyPassword accepts the correct password', async () => {
    const hash = await hashPassword('password123')
    expect(await verifyPassword('password123', hash)).toBe(true)
  })

  it('verifyPassword rejects a wrong password', async () => {
    const hash = await hashPassword('password123')
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })

  it('verifyPassword rejects a malformed hash', async () => {
    expect(await verifyPassword('password123', 'not-a-valid-hash')).toBe(false)
    expect(await verifyPassword('password123', 'sha256$100000$abc$def')).toBe(false)
  })

  it('produces different hashes for the same password (random salt)', async () => {
    const h1 = await hashPassword('password123')
    const h2 = await hashPassword('password123')
    expect(h1).not.toBe(h2)
  })

  it('verifies a pre-seeded test user hash', async () => {
    const seedHash =
      'pbkdf2_sha256$100000$pGW_FQUWkZ4LWR5SAXwDbg$eavlQExxmqixP0sIhu9HM8OIZqaxNm5ngKDMQd7Ge3s'
    expect(await verifyPassword('password123', seedHash)).toBe(true)
    expect(await verifyPassword('wrong', seedHash)).toBe(false)
  })
})

describe('authApp Hono routes', () => {
  it('exports authApp', () => {
    expect(authApp).toBeDefined()
    expect(typeof authApp.fetch).toBe('function')
  })

  it('/logout returns ok', async () => {
    const res = await authApp.request('/logout', { method: 'POST' }, {
      PAGES_ORIGIN: 'http://localhost:5173',
    } as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
  })

  it('/login redirects to Google', async () => {
    const env = {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      WORKER_JWT_SECRET: SECRET,
      WORKER_ENCRYPTION_KEY: 'test-enc-key',
      DB: {},
      PAGES_ORIGIN: 'http://localhost:5173',
    }
    const res = await authApp.request('/login', {}, env as any)
    expect(res.status).toBe(302)
    const location = res.headers.get('Location') || ''
    expect(location).toContain('accounts.google.com')
    expect(location).toContain('client_id=test-client-id')
  })

  it('/callback returns 400 for missing state', async () => {
    const res = await authApp.request('/callback?code=abc', {}, {
      PAGES_ORIGIN: 'http://localhost:5173',
    } as any)
    expect(res.status).toBe(400)
  })

  it('/callback returns 400 when state does not match', async () => {
    const env = {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      WORKER_JWT_SECRET: SECRET,
      WORKER_ENCRYPTION_KEY: 'test-enc-key',
      DB: {},
      PAGES_ORIGIN: 'http://localhost:5173',
    }
    const res = await authApp.request(
      '/callback?code=abc&state=wrong',
      {
        headers: {
          Cookie: 'rumaq_oauth_state=expected:verifier',
        },
      },
      env as any
    )
    expect(res.status).toBe(400)
  })

  it('/callback returns 400 when token exchange fails', async () => {
    globalThis.fetch = async () => new Response('{}', { status: 400 }) as any
    const env = {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      WORKER_JWT_SECRET: SECRET,
      WORKER_ENCRYPTION_KEY: 'test-enc-key',
      DB: {},
      PAGES_ORIGIN: 'http://localhost:5173',
    }
    const res = await authApp.request(
      '/callback?code=abc&state=test-state',
      {
        headers: {
          Cookie: 'rumaq_oauth_state=test-state:verifier',
        },
      },
      env as any
    )
    expect(res.status).toBe(400)
  })

  // Regression: the state cookie used to embed the origin after a ':' delimiter,
  // so split(':') truncated `https://…` to `https` and the token exchange sent
  // redirect_uri=https/api/auth/callback, which Google rejects (prod SSO 400).
  it('/callback sends the request-origin redirect_uri to the token endpoint', async () => {
    let tokenBody = ''
    let callCount = 0
    globalThis.fetch = async (_input: any, init?: any) => {
      callCount++
      if (callCount === 1) {
        tokenBody = String(init?.body || '')
        return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }) as any
      }
      return new Response('{}', { status: 400 }) as any
    }
    const env = {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      WORKER_JWT_SECRET: SECRET,
      WORKER_ENCRYPTION_KEY: 'test-enc-key',
      DB: {},
      PAGES_ORIGIN: 'http://localhost:5173',
    }
    const res = await authApp.request(
      '/callback?code=abc&state=test-state',
      {
        headers: {
          Cookie: 'rumaq_oauth_state=test-state:verifier',
        },
      },
      env as any
    )
    // User info fetch fails (400) — the token-exchange body is what we assert on.
    expect(res.status).toBe(400)
    expect(tokenBody).toContain(
      `redirect_uri=${encodeURIComponent('http://localhost/api/auth/callback')}`
    )
  })

  it('/callback returns 400 when user info fetch fails', async () => {
    let callCount = 0
    globalThis.fetch = async () => {
      callCount++
      if (callCount === 1)
        return new Response(JSON.stringify({ access_token: 'tok' }), {
          status: 200,
        }) as any
      return new Response('{}', { status: 400 }) as any
    }
    const env = {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      WORKER_JWT_SECRET: SECRET,
      WORKER_ENCRYPTION_KEY: 'test-enc-key',
      DB: {},
      PAGES_ORIGIN: 'http://localhost:5173',
    }
    const res = await authApp.request(
      '/callback?code=abc&state=test-state',
      {
        headers: {
          Cookie: 'rumaq_oauth_state=test-state:verifier',
        },
      },
      env as any
    )
    expect(res.status).toBe(400)
  })

  it('/callback succeeds with new user', async () => {
    let callCount = 0
    const sqlStatements: string[] = []
    globalThis.fetch = async () => {
      callCount++
      if (callCount === 1)
        return new Response(JSON.stringify({ access_token: 'tok' }), {
          status: 200,
        }) as any
      return new Response(JSON.stringify({ sub: 'g123', email: 'a@b.com', name: 'Alice' }), {
        status: 200,
      }) as any
    }
    const mockDb = {
      prepare: (sql: string) => {
        sqlStatements.push(sql)
        return {
          bind: () => ({
            first: async () => null,
            all: async () => ({ results: [] }),
            batch: async () => {},
            sql,
          }),
        }
      },
      first: async () => null,
      all: async () => ({ results: [] }),
      batch: async (stmts: any[]) => {
        const results = Array.from({ length: stmts.length }, (_, i) => {
          if (i === 1) return { results: [{ id: 'new-id' }] }
          return {}
        })
        return results
      },
    }
    const env = {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      WORKER_JWT_SECRET: SECRET,
      WORKER_ENCRYPTION_KEY: 'test-enc-key',
      DB: mockDb,
      PAGES_ORIGIN: 'http://localhost:5173',
    }
    const res = await authApp.request(
      '/callback?code=abc&state=test-state',
      {
        headers: {
          Cookie: 'rumaq_oauth_state=test-state:verifier',
        },
      },
      env as any
    )
    expect(res.status).toBe(302)
    const insertLocations = sqlStatements.filter((s) => s.includes('INSERT INTO locations'))
    const insertStores = sqlStatements.filter((s) => s.includes('INSERT INTO stores'))
    expect(insertLocations).toHaveLength(4)
    expect(insertStores).toHaveLength(3)
  })

  it('/callback skips household creation for existing member', async () => {
    let callCount = 0
    globalThis.fetch = async () => {
      callCount++
      if (callCount === 1)
        return new Response(JSON.stringify({ access_token: 'tok' }), {
          status: 200,
        }) as any
      return new Response(JSON.stringify({ sub: 'g456', email: 'b@b.com' }), {
        status: 200,
      }) as any
    }
    const mockDb = {
      prepare: () => mockDb,
      bind: () => mockDb,
      first: async () => ({ household_id: 'existing-house' }),
      all: async () => ({ results: [] }),
      batch: async () => [{}, { results: [] }],
    }
    const env = {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      WORKER_JWT_SECRET: SECRET,
      WORKER_ENCRYPTION_KEY: 'test-enc-key',
      DB: mockDb,
      PAGES_ORIGIN: 'http://localhost:5173',
    }
    const res = await authApp.request(
      '/callback?code=abc&state=test-state',
      {
        headers: {
          Cookie: 'rumaq_oauth_state=test-state:verifier',
        },
      },
      env as any
    )
    expect(res.status).toBe(302)
  })

  it('/email-login returns 403 when disabled', async () => {
    const env = {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      WORKER_JWT_SECRET: SECRET,
      WORKER_ENCRYPTION_KEY: 'test-enc-key',
      DB: {},
      PAGES_ORIGIN: 'http://localhost:5173',
      EMAIL_AUTH_ENABLED: 'false',
    }
    const res = await authApp.request(
      '/email-login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@rumaq.dev',
          password: 'password123',
        }),
      },
      env as any
    )
    expect(res.status).toBe(403)
  })

  it('/email-login returns 400 for missing fields', async () => {
    const env = {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      WORKER_JWT_SECRET: SECRET,
      WORKER_ENCRYPTION_KEY: 'test-enc-key',
      DB: {},
      PAGES_ORIGIN: 'http://localhost:5173',
      EMAIL_AUTH_ENABLED: 'true',
    }
    const res = await authApp.request(
      '/email-login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@rumaq.dev' }),
      },
      env as any
    )
    expect(res.status).toBe(400)
  })

  it('/email-login returns 401 for unknown user', async () => {
    const mockDb = {
      prepare: () => mockDb,
      bind: () => mockDb,
      first: async () => null,
      all: async () => ({ results: [] }),
      batch: async () => [],
    }
    const env = {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      WORKER_JWT_SECRET: SECRET,
      WORKER_ENCRYPTION_KEY: 'test-enc-key',
      DB: mockDb,
      PAGES_ORIGIN: 'http://localhost:5173',
      EMAIL_AUTH_ENABLED: 'true',
    }
    const res = await authApp.request(
      '/email-login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'nobody@rumaq.dev',
          password: 'password123',
        }),
      },
      env as any
    )
    expect(res.status).toBe(401)
  })

  it('/email-login returns 401 for wrong password', async () => {
    const mockDb = {
      prepare: () => mockDb,
      bind: () => mockDb,
      first: async () => ({
        id: 'u1',
        email: 'test@rumaq.dev',
        name: 'Test User One',
        password_hash:
          'pbkdf2_sha256$100000$pGW_FQUWkZ4LWR5SAXwDbg$eavlQExxmqixP0sIhu9HM8OIZqaxNm5ngKDMQd7Ge3s',
      }),
      all: async () => ({ results: [] }),
      batch: async () => [],
    }
    const env = {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      WORKER_JWT_SECRET: SECRET,
      WORKER_ENCRYPTION_KEY: 'test-enc-key',
      DB: mockDb,
      PAGES_ORIGIN: 'http://localhost:5173',
      EMAIL_AUTH_ENABLED: 'true',
    }
    const res = await authApp.request(
      '/email-login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@rumaq.dev',
          password: 'wrong-password',
        }),
      },
      env as any
    )
    expect(res.status).toBe(401)
  })

  it('/email-login succeeds with valid credentials and sets session cookie', async () => {
    const mockDb = {
      prepare: () => mockDb,
      bind: () => mockDb,
      first: async () => ({
        id: 'u1',
        email: 'test@rumaq.dev',
        name: 'Test User One',
        password_hash:
          'pbkdf2_sha256$100000$pGW_FQUWkZ4LWR5SAXwDbg$eavlQExxmqixP0sIhu9HM8OIZqaxNm5ngKDMQd7Ge3s',
      }),
      all: async () => ({ results: [] }),
      batch: async () => [],
    }
    const env = {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      WORKER_JWT_SECRET: SECRET,
      WORKER_ENCRYPTION_KEY: 'test-enc-key',
      DB: mockDb,
      PAGES_ORIGIN: 'http://localhost:5173',
      EMAIL_AUTH_ENABLED: 'true',
    }
    const res = await authApp.request(
      '/email-login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@rumaq.dev',
          password: 'password123',
        }),
      },
      env as any
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
    const setCookie = res.headers.get('set-cookie') || ''
    expect(setCookie).toContain('rumaq_session=')
  })

  // Session epoch (ahaqqu/RumaQ#405): the token must carry the user's CURRENT
  // epoch — a re-login after a logout bump would otherwise mint a token the
  // middleware rejects.
  it('/email-login signs the user’s current session_epoch into the token', async () => {
    const mockDb = {
      prepare: () => mockDb,
      bind: () => mockDb,
      first: async () => ({
        id: 'u-epoch3',
        email: 'test@rumaq.dev',
        name: 'Test User One',
        password_hash:
          'pbkdf2_sha256$100000$pGW_FQUWkZ4LWR5SAXwDbg$eavlQExxmqixP0sIhu9HM8OIZqaxNm5ngKDMQd7Ge3s',
        session_epoch: 3,
      }),
      all: async () => ({ results: [] }),
      batch: async () => [],
    }
    const env = {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      WORKER_JWT_SECRET: SECRET,
      WORKER_ENCRYPTION_KEY: 'test-enc-key',
      DB: mockDb,
      PAGES_ORIGIN: 'http://localhost:5173',
      EMAIL_AUTH_ENABLED: 'true',
    }
    const res = await authApp.request(
      '/email-login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@rumaq.dev',
          password: 'password123',
        }),
      },
      env as any
    )
    expect(res.status).toBe(200)
    const cookie = (res.headers.get('set-cookie') || '').match(/rumaq_session=([^;]+)/)?.[1] || ''
    const payload = await verifyJwt(cookie, SECRET)
    expect(payload).toMatchObject({ sub: 'u-epoch3', epoch: 3 })
  })

  it('/email-login mints epoch 0 for a user whose stored epoch is unset', async () => {
    const mockDb = {
      prepare: () => mockDb,
      bind: () => mockDb,
      first: async () => ({
        id: 'u-legacy',
        email: 'test@rumaq.dev',
        name: 'Test User One',
        password_hash:
          'pbkdf2_sha256$100000$pGW_FQUWkZ4LWR5SAXwDbg$eavlQExxmqixP0sIhu9HM8OIZqaxNm5ngKDMQd7Ge3s',
        session_epoch: null,
      }),
      all: async () => ({ results: [] }),
      batch: async () => [],
    }
    const env = {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      WORKER_JWT_SECRET: SECRET,
      WORKER_ENCRYPTION_KEY: 'test-enc-key',
      DB: mockDb,
      PAGES_ORIGIN: 'http://localhost:5173',
      EMAIL_AUTH_ENABLED: 'true',
    }
    const res = await authApp.request(
      '/email-login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@rumaq.dev',
          password: 'password123',
        }),
      },
      env as any
    )
    expect(res.status).toBe(200)
    const cookie = (res.headers.get('set-cookie') || '').match(/rumaq_session=([^;]+)/)?.[1] || ''
    const payload = await verifyJwt(cookie, SECRET)
    expect(payload).toMatchObject({ sub: 'u-legacy', epoch: 0 })
  })

  // Session epoch (ahaqqu/RumaQ#405): logout revokes server-side. The bump
  // needs a VERIFIED sub — an unverified token's sub would let anyone revoke
  // a victim's sessions.
  it('/logout bumps the session epoch for the verified session user', async () => {
    const bound: unknown[][] = []
    const sqls: string[] = []
    const mockDb = {
      prepare: (sql: string) => {
        sqls.push(sql)
        return {
          bind: (...params: unknown[]) => {
            bound.push(params)
            return { run: async () => ({ meta: { changes: 1 } }) }
          },
        }
      },
    }
    const env = {
      WORKER_JWT_SECRET: SECRET,
      DB: mockDb,
      PAGES_ORIGIN: 'http://localhost:5173',
    }
    const token = await signJwt({ sub: 'u1', exp: Date.now() + 60_000, epoch: 2 }, SECRET)
    const res = await authApp.request(
      '/logout',
      { method: 'POST', headers: { Cookie: `rumaq_session=${token}` } },
      env as any
    )
    expect(res.status).toBe(200)
    const updates = sqls.filter((s) => s.includes('session_epoch'))
    expect(updates).toHaveLength(1)
    expect(bound[0]).toEqual(['u1'])
    const setCookie = res.headers.get('set-cookie') || ''
    expect(setCookie).toContain('rumaq_session=;')
  })

  it('/logout without a valid session cookie never touches the DB', async () => {
    let prepareCalls = 0
    const mockDb = {
      prepare: () => {
        prepareCalls++
        return { bind: () => ({ run: async () => ({}) }) }
      },
    }
    const env = {
      WORKER_JWT_SECRET: SECRET,
      DB: mockDb,
      PAGES_ORIGIN: 'http://localhost:5173',
    }
    const forged = await signJwt({ sub: 'victim', exp: Date.now() + 60_000 }, 'wrong-secret')
    const noCookie = await authApp.request('/logout', { method: 'POST' }, env as any)
    expect(noCookie.status).toBe(200)
    const forgedCookie = await authApp.request(
      '/logout',
      { method: 'POST', headers: { Cookie: `rumaq_session=${forged}` } },
      env as any
    )
    expect(forgedCookie.status).toBe(200)
    expect(prepareCalls).toBe(0)
  })

  // QA-F4 (ahaqqu/RumaQ#402): the limiter's signal must be explicit — 429
  // with a clear body (error + retry_after seconds) and a Retry-After header,
  // not an identical 401 on every attempt.
  it('/email-login returns an explicit 429 after the per-IP budget is exhausted', async () => {
    const mockDb = {
      prepare: () => mockDb,
      bind: () => mockDb,
      first: async () => null,
      all: async () => ({ results: [] }),
      batch: async () => [],
    }
    const env = {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      WORKER_JWT_SECRET: SECRET,
      WORKER_ENCRYPTION_KEY: 'test-enc-key',
      DB: mockDb,
      PAGES_ORIGIN: 'http://localhost:5173',
      EMAIL_AUTH_ENABLED: 'true',
    }
    const attempt = () =>
      authApp.request(
        '/email-login',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '203.0.113.7',
          },
          body: JSON.stringify({ email: 'nobody@rumaq.dev', password: 'password123' }),
        },
        env as any
      )

    // 10 attempts inside the window go through (401 — unknown user), then the
    // 11th hits the explicit 429.
    for (let i = 0; i < 10; i++) {
      expect((await attempt()).status).toBe(401)
    }
    const limited = await attempt()
    expect(limited.status).toBe(429)
    const body = (await limited.json()) as { error: string; retry_after: number }
    expect(body.error).toContain('Too many login attempts')
    expect(Number.isInteger(body.retry_after)).toBe(true)
    expect(body.retry_after).toBeGreaterThan(0)
    expect(body.retry_after).toBeLessThanOrEqual(60)
    expect(limited.headers.get('Retry-After')).toBe(String(body.retry_after))

    // A different address still gets through — the window is per-IP.
    const otherIp = await authApp.request(
      '/email-login',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '203.0.113.8',
        },
        body: JSON.stringify({ email: 'nobody@rumaq.dev', password: 'password123' }),
      },
      env as any
    )
    expect(otherIp.status).toBe(401)
  })

  // ahaqqu/RumaQ#499: the local/e2e harness raises the login budget through
  // LOGIN_RATE_MAX / LOGIN_RATE_WINDOW_SEC (browser logins share one Docker
  // IP). The route must honour the override — and return the identical 429
  // shape — without the production default moving.
  it('/email-login honours LOGIN_RATE_MAX / LOGIN_RATE_WINDOW_SEC', async () => {
    const mockDb = {
      prepare: () => mockDb,
      bind: () => mockDb,
      first: async () => null,
      all: async () => ({ results: [] }),
      batch: async () => [],
    }
    const env = {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      WORKER_JWT_SECRET: SECRET,
      WORKER_ENCRYPTION_KEY: 'test-enc-key',
      DB: mockDb,
      PAGES_ORIGIN: 'http://localhost:5173',
      EMAIL_AUTH_ENABLED: 'true',
      LOGIN_RATE_MAX: '12',
      LOGIN_RATE_WINDOW_SEC: '30',
    }
    const attempt = () =>
      authApp.request(
        '/email-login',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '203.0.113.20',
          },
          body: JSON.stringify({ email: 'nobody@rumaq.dev', password: 'password123' }),
        },
        env as any
      )

    // The override is the budget: 12 attempts pass, the 13th is limited.
    for (let i = 0; i < 12; i++) {
      expect((await attempt()).status).toBe(401)
    }
    const limited = await attempt()
    expect(limited.status).toBe(429)
    const body = (await limited.json()) as { error: string; retry_after: number }
    expect(body.error).toContain('Too many login attempts')
    expect(Number.isInteger(body.retry_after)).toBe(true)
    // The window override is honoured too: retry_after can never exceed it.
    expect(body.retry_after).toBeGreaterThan(0)
    expect(body.retry_after).toBeLessThanOrEqual(30)
    expect(limited.headers.get('Retry-After')).toBe(String(body.retry_after))
  })

  // Session epoch (ahaqqu/RumaQ#405): the Google path signs the CURRENT epoch
  // from the same lookup that resolves the id.
  it('/callback signs the looked-up session_epoch into the token', async () => {
    let callCount = 0
    globalThis.fetch = async () => {
      callCount++
      if (callCount === 1)
        return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }) as any
      return new Response(JSON.stringify({ sub: 'g-epoch', email: 'e@b.com' }), {
        status: 200,
      }) as any
    }
    const mockDb = {
      prepare: () => mockDb,
      bind: () => mockDb,
      first: async () => null,
      all: async () => ({ results: [] }),
      batch: async () => [{}, { results: [{ id: 'u-epoch7', session_epoch: 7 }] }],
    }
    const env = {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      WORKER_JWT_SECRET: SECRET,
      WORKER_ENCRYPTION_KEY: 'test-enc-key',
      DB: mockDb,
      PAGES_ORIGIN: 'http://localhost:5173',
    }
    const res = await authApp.request(
      '/callback?code=abc&state=test-state',
      {
        headers: { Cookie: 'rumaq_oauth_state=test-state:verifier' },
      },
      env as any
    )
    expect(res.status).toBe(302)
    const cookie = (res.headers.get('set-cookie') || '').match(/rumaq_session=([^;]+)/)?.[1] || ''
    const payload = await verifyJwt(cookie, SECRET)
    expect(payload).toMatchObject({ sub: 'u-epoch7', epoch: 7 })
  })
})
