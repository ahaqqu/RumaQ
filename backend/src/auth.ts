import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
import { timingSafeEqualStrings } from './lib/crypto.js'
import type { Env } from './types.js'

export function base64UrlEncode(buffer: ArrayBuffer | Uint8Array) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(str: string): ArrayBuffer {
  const normalized = str.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)).buffer as ArrayBuffer
}

export async function signJwt(payload: Record<string, unknown>, secret: string) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const header = { alg: 'HS256', typ: 'JWT' }
  const body = `${base64UrlEncode(encoder.encode(JSON.stringify(header)))}.${base64UrlEncode(
    encoder.encode(JSON.stringify(payload))
  )}`
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
  return `${body}.${base64UrlEncode(sig)}`
}

export async function verifyJwt(token: string, secret: string) {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h, p, s] = parts
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    base64UrlDecode(s),
    encoder.encode(`${h}.${p}`)
  )
  if (!ok) return null

  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(p)))

  if (payload.exp && typeof payload.exp === 'number' && Date.now() > payload.exp) {
    return null
  }

  return payload
}

export function randomState() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

const PBKDF2_ITERATIONS = 100000
const HASH_PREFIX = 'pbkdf2_sha256'

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  )
  const saltB64 = base64UrlEncode(salt.buffer)
  const hashB64 = base64UrlEncode(bits)
  return `${HASH_PREFIX}$${PBKDF2_ITERATIONS}$${saltB64}$${hashB64}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== HASH_PREFIX) return false
  const iterations = parseInt(parts[1], 10)
  const salt = new Uint8Array(base64UrlDecode(parts[2]))
  const expectedHash = parts[3]
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  )
  const hashB64 = base64UrlEncode(bits)
  return hashB64 === expectedHash
}

// Active-household resolution (ahaqqu/RumaQ#331), extracted as a constant so
// the real-SQL tests (migrations.test.ts pattern) run the EXACT statement the
// middleware runs against real SQLite — semantics and the index plan are
// regression-guarded there (review C1).
// Subquery 1: user_settings.active_household_id wins ONLY while the user is
// still a member of that household — a stale pointer (the member was removed)
// must not keep granting access. Subquery 2: otherwise the oldest membership
// is the baseline, deterministic (joined_at then id) where the old LIMIT 1
// picked an arbitrary row. Both are index seeks via
// idx_household_members_user (0020) — see the migration for the EXPLAIN proof.
// A NULL answer means the session is unauthorized; in practice every
// membership-less user is re-baselined atomically by leaveHousehold /
// removeMember (lib/households.ts) and by the login flows, so the 401 below
// is unreachable for sessions this app issued after those guarantees (review
// A2 keeps join/create behind the same resolution — the respawn makes that
// safe, rather than exempting the routes from it).
// Session-epoch revocation (ahaqqu/RumaQ#405): the third subquery rides in
// the SAME round trip — users.id is the primary key, so it is an indexed
// seek, keeping the per-request budget at one statement. The middleware
// compares the epoch signed into the JWT against it; logout bumps the stored
// value, so every token issued before the bump fails closed.
export const ACTIVE_HOUSEHOLD_SQL = `SELECT COALESCE(
     (SELECT m.household_id
        FROM household_members m
        JOIN user_settings s ON s.user_id = m.user_id AND s.active_household_id = m.household_id
       WHERE m.user_id = ?
       LIMIT 1),
     (SELECT household_id
        FROM household_members
       WHERE user_id = ?
       ORDER BY joined_at, household_id
       LIMIT 1)
   ) AS household_id,
   (SELECT session_epoch FROM users WHERE id = ?) AS session_epoch`

export const propsAuthMiddleware = createMiddleware<Env>(async (c, next) => {
  const props = c.env.props
  if (props?.userId && props?.householdId) {
    c.set('userId', props.userId)
    c.set('householdId', props.householdId)
    await next()
    return
  }
  let token: string | undefined
  try {
    token = getCookie(c, 'rumaq_session')
  } catch {
    // c.req.raw not available (test mock)
  }
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const payload = await verifyJwt(token, c.env.WORKER_JWT_SECRET)
  if (!payload || typeof payload.sub !== 'string') {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const row = await c.env.DB.prepare(ACTIVE_HOUSEHOLD_SQL)
    .bind(payload.sub, payload.sub, payload.sub)
    .first<{ household_id: string | null; session_epoch: number | null }>()

  const householdId = row?.household_id

  if (!householdId) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  // Session-epoch revocation (#405): a token whose epoch claim does not match
  // the stored value is revoked — logout bumped it. Tokens minted before the
  // claim existed carry no epoch, and invite-created accounts sit at the
  // default 0: both normalize to 0 on each side, so pre-feature tokens and
  // fresh accounts compare equal (additive rollout with no forced re-login).
  // Only a signed claim is trusted — unsigned payload fields cannot exist
  // here, verifyJwt already rejected tokens failing the HMAC.
  const tokenEpoch = typeof payload.epoch === 'number' ? payload.epoch : 0
  if (tokenEpoch !== (row.session_epoch ?? 0)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  c.set('userId', payload.sub)
  c.set('householdId', householdId)
  await next()
})

// Scripted review access (ahaqqu/RumaQ#656): the two review surfaces a local
// script drives — GET /api/admin/review/queue-report (read-only aggregates)
// and POST /api/admin/review/evaluate (assist-mode verdict fill) — accept a
// dedicated bearer token INSTEAD of the admin session cookie. A script has no
// browser: no cookie jar, and it sends no Origin/Referer, which is exactly the
// caller class the CSRF guard already allows (lib/csrf.ts) — so a header-token
// caller adds no CSRF surface. Comparison is timing-safe (lib/crypto.ts, the
// same primitive the ingest channel uses); _NEXT rides during a rotation
// window exactly like HAQITA_INGEST_SECRET_NEXT.
type ReviewScriptTokenEnv = Pick<
  Env['Bindings'],
  'REVIEW_SCRIPT_TOKEN' | 'REVIEW_SCRIPT_TOKEN_NEXT'
>

function reviewScriptTokenCandidates(env: ReviewScriptTokenEnv): string[] {
  return [env.REVIEW_SCRIPT_TOKEN, env.REVIEW_SCRIPT_TOKEN_NEXT].filter(
    (secret): secret is string => typeof secret === 'string' && secret.length > 0
  )
}

export async function matchesReviewScriptToken(
  presented: string,
  env: ReviewScriptTokenEnv
): Promise<boolean> {
  const candidates = reviewScriptTokenCandidates(env)
  if (candidates.length === 0 || presented.length === 0) return false
  // Every non-empty candidate is compared on every request — no precedence,
  // no early exit — so a match on one secret cannot be timed apart from the
  // other. Same discipline as the ingest channel (apps/api.ts).
  let matched = false
  for (const candidate of candidates) {
    if (await timingSafeEqualStrings(presented, candidate)) matched = true
  }
  return matched
}

export function bearerTokenOf(c: {
  req: { header(name: string): string | undefined }
}): string | undefined {
  try {
    const header = c.req.header('Authorization') || ''
    return header.startsWith('Bearer ') ? header.slice(7).trim() || undefined : undefined
  } catch {
    // c.req not available (test mock)
    return undefined
  }
}

// A presented-but-rejected script token must not fail silently (#451
// discipline): the ingest-auth incidents (#425/#448) were undiagnosable
// because the Worker never logged WHY a call was rejected. One structured
// line per rejection — route + candidate count + token LENGTH only (never
// the token's content), same shape as the ingest channel's ingest_401.
function logReviewScriptTokenRejection(
  c: {
    req: { url: string; header(name: string): string | undefined }
  },
  tokenLength: number,
  candidateCount: number
): void {
  console.log(
    JSON.stringify({
      evt: 'review_script_token_rejected',
      route: new URL(c.req.url).pathname,
      tokenLength,
      candidates: candidateCount,
      matched: false,
      ray: c.req.header('cf-ray') ?? null,
    })
  )
}

// The script acts AS the deployment's admin user (is_admin = 1; one row in
// practice, id order makes it deterministic if more ever exist): the AI access
// resolution and audit columns (decided_by, decided_source = ai_assist) keep
// working unchanged. Cookie sessions take the propsAuth path untouched — the
// token never widens a cookie request, and requireAdmin still runs in the
// route chain on both paths.
export const propsOrReviewScriptAuth = createMiddleware<Env>(async (c, next) => {
  const presented = bearerTokenOf(c)
  if (presented && (await matchesReviewScriptToken(presented, c.env))) {
    const admin = await c.env.DB.prepare(
      'SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1'
    ).first<{ id: string }>()
    if (!admin) return c.json({ error: 'Forbidden' }, 403)
    const row = await c.env.DB.prepare(ACTIVE_HOUSEHOLD_SQL)
      .bind(admin.id, admin.id, admin.id)
      .first<{ household_id: string | null; session_epoch: number | null }>()
    if (!row?.household_id) return c.json({ error: 'Forbidden' }, 403)
    c.set('userId', admin.id)
    c.set('householdId', row.household_id)
    await next()
    return
  }
  if (presented) {
    logReviewScriptTokenRejection(c, presented.length, reviewScriptTokenCandidates(c.env).length)
  }
  return propsAuthMiddleware(c, next)
})
