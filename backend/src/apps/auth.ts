import { Hono, type Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { openAPIRouteHandler, describeRoute } from 'hono-openapi'
import type { Env } from '../types.js'
import { createCors } from '../cors.js'
import { signJwt, verifyJwt, verifyPassword, base64UrlEncode, randomState } from '../auth.js'
import { isRateLimited, getClientIp } from '../lib/rate-limit.js'
import { getRequestOrigin } from '../lib/request.js'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
const COOKIE_NAME = 'rumaq_session'
const OAUTH_STATE_COOKIE = 'rumaq_oauth_state'
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000

// QA-F4 (ahaqqu/RumaQ#402): /email-login gets its own, much tighter limiter
// than the general per-IP window (which the auth app does not run at all —
// only api/households/documents do). Credential probing is the cheapest
// attack there is; the window is small so a lockout never outlives a typo
// spree, and the 429 is EXPLICIT — Retry-After header plus retry_after
// seconds in the body — so a client at human pace gets a visible, actionable
// signal instead of an identical 401 on every attempt.
const LOGIN_RATE_WINDOW_MS = 60_000
const LOGIN_RATE_MAX = 10

// The authorize-time and token-exchange redirect_uri must match exactly — Google
// rejects the exchange otherwise — so both routes build it here, derived from the
// request origin: Google returns the browser to the authorize-time redirect_uri,
// so the callback's own origin is always the value Google validated.
const oauthRedirectUri = (c: Context<Env>) => `${getRequestOrigin(c)}/api/auth/callback`

const authApp = new Hono<Env>()

authApp.use('*', createCors())

authApp.get(
  '/openapi.json',
  openAPIRouteHandler(authApp, {
    documentation: {
      info: { title: 'RumaQ API', version: '0.1.0' },
    },
  })
)

authApp.get(
  '/login',
  describeRoute({
    description: 'Redirects to Google OAuth 2.0 login.',
    responses: {
      302: { description: 'Redirect to Google' },
    },
  }),
  async (c) => {
    const state = randomState()
    const verifier = randomState()
    const redirectUri = oauthRedirectUri(c)
    const sha256 = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    const challenge = base64UrlEncode(sha256)

    // Only state:verifier may live in this cookie — both are base64url
    // (colon-free); a delimited origin would be truncated by the callback's
    // split(':'), which re-derives the redirect_uri from its own request origin.
    setCookie(c, OAUTH_STATE_COOKIE, `${state}:${verifier}`, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 600,
    })

    const params = new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })

    return c.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`)
  }
)

authApp.get(
  '/callback',
  describeRoute({
    description: 'Google OAuth callback. Sets rumaq_session and redirects to /.',
    responses: {
      302: { description: 'Redirect to app' },
      400: { description: 'Bad request' },
    },
  }),
  async (c) => {
    const { code, state } = c.req.query()
    const cookie = getCookie(c, OAUTH_STATE_COOKIE) || ''
    deleteCookie(c, OAUTH_STATE_COOKIE)
    const [expectedState, verifier] = cookie.split(':')

    if (!code || !state || state !== expectedState) {
      return c.json({ error: 'Invalid OAuth state' }, 400)
    }

    const redirectUri = oauthRedirectUri(c)
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: c.env.GOOGLE_CLIENT_ID,
        client_secret: c.env.GOOGLE_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }),
    })

    if (!tokenRes.ok) {
      console.error(
        'OAuth token exchange failed:',
        tokenRes.status,
        await tokenRes.text().catch(() => '')
      )
      return c.json({ error: 'Failed to exchange OAuth code' }, 400)
    }

    const { access_token } = (await tokenRes.json()) as { access_token: string }
    const userRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${access_token}` },
    })

    if (!userRes.ok) {
      return c.json({ error: 'Failed to fetch user info' }, 400)
    }

    const googleUser = (await userRes.json()) as {
      sub: string
      email: string
      name?: string
      picture?: string
    }

    const finalUserId = crypto.randomUUID()
    const householdId = crypto.randomUUID()
    const settingsId = crypto.randomUUID()

    const userStmt = c.env.DB.prepare(
      `INSERT INTO users (id, email, name, picture, google_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(google_id) DO UPDATE SET
       name = excluded.name,
       picture = excluded.picture,
       updated_at = datetime('now')`
    ).bind(
      finalUserId,
      googleUser.email,
      googleUser.name || null,
      googleUser.picture || null,
      googleUser.sub
    )

    // session_epoch rides along in the same lookup — the token must carry the
    // CURRENT epoch (ahaqqu/RumaQ#405), not a default, or a post-logout
    // re-login would mint a token the middleware rejects.
    const lookupStmt = c.env.DB.prepare(
      'SELECT id, session_epoch FROM users WHERE google_id = ?'
    ).bind(googleUser.sub)

    const batchResults = await c.env.DB.batch([userStmt, lookupStmt])
    const rows = batchResults[1]?.results as
      | { id?: string; session_epoch?: number | null }[]
      | undefined
    const actualUserId = rows?.[0]?.id || finalUserId

    const existingMember = await c.env.DB.prepare(
      'SELECT 1 FROM household_members WHERE user_id = ?'
    )
      .bind(actualUserId)
      .first()

    if (!existingMember) {
      const locationSeeds = [
        { id: crypto.randomUUID(), label: 'Kulkas', sort_order: 1 },
        { id: crypto.randomUUID(), label: 'Freezer', sort_order: 2 },
        { id: crypto.randomUUID(), label: 'Lemari', sort_order: 3 },
        { id: crypto.randomUUID(), label: 'Rak', sort_order: 4 },
      ]
      const storeSeeds = [
        { id: crypto.randomUUID(), label: 'Indomaret' },
        { id: crypto.randomUUID(), label: 'Alfamart' },
        { id: crypto.randomUUID(), label: 'Pasar' },
      ]

      await c.env.DB.batch([
        c.env.DB.prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)').bind(
          householdId,
          'Rumahku',
          actualUserId
        ),
        c.env.DB.prepare(
          'INSERT INTO household_members (id, household_id, user_id, role) VALUES (?, ?, ?, ?)'
        ).bind(crypto.randomUUID(), householdId, actualUserId, 'owner'),
        c.env.DB.prepare(
          'INSERT INTO user_settings (id, user_id, active_household_id) VALUES (?, ?, ?)'
        ).bind(settingsId, actualUserId, householdId),
        ...locationSeeds.map((loc) =>
          c.env.DB.prepare(
            'INSERT INTO locations (id, household_id, label, sort_order) VALUES (?, ?, ?, ?)'
          ).bind(loc.id, householdId, loc.label, loc.sort_order)
        ),
        ...storeSeeds.map((store) =>
          c.env.DB.prepare('INSERT INTO stores (id, household_id, label) VALUES (?, ?, ?)').bind(
            store.id,
            householdId,
            store.label
          )
        ),
      ])
    }

    const iat = Date.now()
    const jwt = await signJwt(
      {
        sub: actualUserId,
        email: googleUser.email,
        iat,
        exp: iat + SESSION_DURATION_MS,
        epoch: rows?.[0]?.session_epoch ?? 0,
      },
      c.env.WORKER_JWT_SECRET
    )

    const isHttps = new URL(c.req.url).protocol === 'https:'
    setCookie(c, COOKIE_NAME, jwt, {
      path: '/',
      httpOnly: true,
      secure: isHttps,
      sameSite: isHttps ? 'None' : 'Lax',
      maxAge: 60 * 60 * 24 * 30,
    })

    return c.redirect('/')
  }
)

authApp.all(
  '/logout',
  describeRoute({
    description:
      'Revokes the session server-side by bumping the user’s session epoch (ahaqqu/RumaQ#405) — every token issued before the bump stops working, on all devices — then clears the cookie. POST returns { ok: true }; GET redirects to /. Without a valid session cookie it is a no-op that only clears the cookie.',
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          },
        },
      },
      302: { description: 'Redirect to origin (GET)' },
    },
  }),
  async (c) => {
    // The epoch bump needs the user id, which only a VALID token may supply —
    // the sub of an unverified token would let anyone revoke a victim's
    // sessions by crafting a cookie. No/expired/forged cookie: clear the
    // cookie and move on (logout stays idempotent and leak-free).
    let token: string | undefined
    try {
      token = getCookie(c, COOKIE_NAME)
    } catch {
      // c.req.raw not available (test mock)
    }
    if (token) {
      const payload = await verifyJwt(token, c.env.WORKER_JWT_SECRET)
      if (payload && typeof payload.sub === 'string') {
        // Monotonic bump, never a reset: setting the epoch back to 0 would
        // resurrect every pre-feature token (no claim = 0). One UPDATE by
        // primary key.
        await c.env.DB.prepare(
          `UPDATE users
              SET session_epoch = session_epoch + 1,
                  updated_at = datetime('now')
            WHERE id = ?`
        )
          .bind(payload.sub)
          .run()
      }
    }

    const isHttps = new URL(c.req.url).protocol === 'https:'
    setCookie(c, COOKIE_NAME, '', {
      path: '/',
      httpOnly: true,
      secure: isHttps,
      sameSite: isHttps ? 'None' : 'Lax',
      maxAge: 0,
    })
    if (c.req.method === 'GET') {
      return c.redirect('/')
    }
    return c.json({ ok: true })
  }
)

authApp.post(
  '/email-login',
  describeRoute({
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['email', 'password'],
            properties: {
              email: { type: 'string' },
              password: { type: 'string' },
            },
          },
        },
      },
    },
    description: 'Validates credentials and sets rumaq_session.',
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          },
        },
      },
      400: { description: 'Missing email or password' },
      401: { description: 'Invalid email or password' },
      403: { description: 'Email auth is disabled' },
      429: {
        description: 'Too many attempts from this address; retry_after carries the seconds left',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['error', 'retry_after'],
              properties: { error: { type: 'string' }, retry_after: { type: 'integer' } },
            },
          },
        },
      },
    },
  }),
  async (c) => {
    // QA-F4 limiter (see LOGIN_RATE_* above) — counts every attempt, keyed by
    // the same client-IP derivation the shared middleware uses.
    const { limited, retryAfter } = isRateLimited(
      `email-login:${getClientIp(c)}`,
      LOGIN_RATE_WINDOW_MS,
      LOGIN_RATE_MAX
    )
    if (limited) {
      return c.json(
        { error: 'Too many login attempts. Please slow down.', retry_after: retryAfter },
        429,
        { 'Retry-After': String(retryAfter) }
      )
    }

    if (c.env.EMAIL_AUTH_ENABLED !== 'true') {
      return c.json({ error: 'Email auth is disabled' }, 403)
    }

    let body: { email?: string; password?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid request body' }, 400)
    }

    const { email, password } = body
    if (!email || !password) {
      return c.json({ error: 'Email and password are required' }, 400)
    }

    const user = await c.env.DB.prepare(
      'SELECT id, email, name, password_hash, session_epoch FROM users WHERE email = ?'
    )
      .bind(email)
      .first<{
        id: string
        email: string
        name: string
        password_hash: string
        session_epoch: number | null
      }>()

    if (!user || !user.password_hash) {
      return c.json({ error: 'Invalid email or password' }, 401)
    }

    const valid = await verifyPassword(password, user.password_hash)
    if (!valid) {
      return c.json({ error: 'Invalid email or password' }, 401)
    }

    const existingMember = await c.env.DB.prepare(
      'SELECT 1 FROM household_members WHERE user_id = ?'
    )
      .bind(user.id)
      .first()

    if (!existingMember) {
      const householdId = crypto.randomUUID()
      const settingsId = crypto.randomUUID()
      const locationSeeds = [
        { id: crypto.randomUUID(), label: 'Kulkas', sort_order: 1 },
        { id: crypto.randomUUID(), label: 'Freezer', sort_order: 2 },
        { id: crypto.randomUUID(), label: 'Lemari', sort_order: 3 },
        { id: crypto.randomUUID(), label: 'Rak', sort_order: 4 },
      ]
      const storeSeeds = [
        { id: crypto.randomUUID(), label: 'Indomaret' },
        { id: crypto.randomUUID(), label: 'Alfamart' },
        { id: crypto.randomUUID(), label: 'Pasar' },
      ]

      await c.env.DB.batch([
        c.env.DB.prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)').bind(
          householdId,
          'Rumahku',
          user.id
        ),
        c.env.DB.prepare(
          'INSERT INTO household_members (id, household_id, user_id, role) VALUES (?, ?, ?, ?)'
        ).bind(crypto.randomUUID(), householdId, user.id, 'owner'),
        c.env.DB.prepare(
          'INSERT INTO user_settings (id, user_id, active_household_id) VALUES (?, ?, ?)'
        ).bind(settingsId, user.id, householdId),
        ...locationSeeds.map((loc) =>
          c.env.DB.prepare(
            'INSERT INTO locations (id, household_id, label, sort_order) VALUES (?, ?, ?, ?)'
          ).bind(loc.id, householdId, loc.label, loc.sort_order)
        ),
        ...storeSeeds.map((store) =>
          c.env.DB.prepare('INSERT INTO stores (id, household_id, label) VALUES (?, ?, ?)').bind(
            store.id,
            householdId,
            store.label
          )
        ),
      ])
    }

    const iat = Date.now()
    const jwt = await signJwt(
      {
        sub: user.id,
        email: user.email,
        iat,
        exp: iat + SESSION_DURATION_MS,
        epoch: user.session_epoch ?? 0,
      },
      c.env.WORKER_JWT_SECRET
    )

    const isHttps = new URL(c.req.url).protocol === 'https:'
    setCookie(c, COOKIE_NAME, jwt, {
      path: '/',
      httpOnly: true,
      secure: isHttps,
      sameSite: isHttps ? 'None' : 'Lax',
      maxAge: 60 * 60 * 24 * 30,
    })

    return c.json({ ok: true })
  }
)

export { authApp }
