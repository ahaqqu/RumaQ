import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
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

  // Active-household resolution (ahaqqu/RumaQ#331): user_settings
  // .active_household_id wins ONLY while the user is still a member of that
  // household — a stale pointer (the member was removed) must not keep
  // granting access. Otherwise the oldest membership is the baseline. One
  // COALESCE round trip; the fallback is deterministic (joined_at then id)
  // where the old LIMIT 1 picked an arbitrary row. If neither yields a
  // household the session is unauthorized — the login flows (re)create a
  // baseline household for membership-less users.
  const row = await c.env.DB.prepare(
    `SELECT COALESCE(
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
     ) AS household_id`
  )
    .bind(payload.sub, payload.sub)
    .first<{ household_id: string | null }>()

  const householdId = row?.household_id

  if (!householdId) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  c.set('userId', payload.sub)
  c.set('householdId', householdId)
  await next()
})
