import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { openAPIRouteHandler, describeRoute } from 'hono-openapi'
import type { Env } from '../types.js'
import { createCors } from '../cors.js'
import { signJwt, verifyPassword, base64UrlEncode, randomState } from '../auth.js'
import { getRequestOrigin } from '../lib/request.js'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
const COOKIE_NAME = 'rumaq_session'
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000

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
    const origin = getRequestOrigin(c)
    const redirectUri = `${origin}/api/auth/callback`
    const sha256 = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    const challenge = base64UrlEncode(sha256)

    setCookie(c, 'rumaq_oauth_state', `${state}:${verifier}:${origin}`, {
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
    const cookie = getCookie(c, 'rumaq_oauth_state') || ''
    deleteCookie(c, 'rumaq_oauth_state')
    const [expectedState, verifier, origin] = cookie.split(':')

    if (!code || !state || state !== expectedState) {
      return c.json({ error: 'Invalid OAuth state' }, 400)
    }

    const redirectUri = `${origin}/api/auth/callback`
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

    const lookupStmt = c.env.DB.prepare('SELECT id FROM users WHERE google_id = ?').bind(
      googleUser.sub
    )

    const batchResults = await c.env.DB.batch([userStmt, lookupStmt])
    const rows = batchResults[1]?.results as { id?: string }[] | undefined
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
          'INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)'
        ).bind(householdId, actualUserId, 'owner'),
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
    description: 'Clears the session cookie. POST returns { ok: true }; GET redirects to /.',
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
  (c) => {
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
    },
  }),
  async (c) => {
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
      'SELECT id, email, name, password_hash FROM users WHERE email = ?'
    )
      .bind(email)
      .first<{
        id: string
        email: string
        name: string
        password_hash: string
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
          'INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)'
        ).bind(householdId, user.id, 'owner'),
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
      { sub: user.id, email: user.email, iat, exp: iat + SESSION_DURATION_MS },
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
