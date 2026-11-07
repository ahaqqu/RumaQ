import type { Env } from '../types.js'
import { isConfiguredOrigin, isDevOrigin } from '../cors.js'
import { getRequestOrigin } from './request.js'

/**
 * CSRF guard for state-changing API requests (ahaqqu/RumaQ#528).
 *
 * Why this exists: the session is a cookie, so a page on any other origin can
 * make the browser attach it to a state-changing request (a no-JS form POST
 * needs no CORS approval). The cookie's SameSite policy is the first layer
 * (apps/auth.ts sets `Lax`, so cross-site requests never carry it); this
 * Origin/Referer check is the second, enforced server-side.
 *
 * Policy:
 *  - Only POST/PUT/PATCH/DELETE are in scope; reads are untouched so GET
 *    navigations from other sites (link previews, prefetch, OAuth redirects)
 *    keep working.
 *  - A request that supplies neither `Origin` nor `Referer` is allowed: a
 *    browser always sends at least one on these methods, while curl and
 *    scripted admin flows send neither. (Same-origin GET navigations and old
 *    clients may also omit them.)
 *  - A supplied origin must equal the request's own origin (`getRequestOrigin`,
 *    which honours the proxy's X-Forwarded-* in the local stack) or be an origin
 *    this deployment is configured on (`isConfiguredOrigin`: `PAGES_ORIGIN`,
 *    branch previews). Local dev's separate SPA port is accepted only when the
 *    request is itself loopback — a page on the user's localhost is not this
 *    app and must not authorize a production write (#528 review A2).
 *    `Origin: null` — a sandboxed iframe or opaque origin — is rejected.
 *  - Machine-to-machine callers are exempt: the internal scraper channel
 *    (`/api/internal/*`) authenticates with a bearer secret and never carries
 *    the session cookie, so there is no cookie-driven CSRF to stop. A
 *    browser can only attach `Authorization` cross-origin after a CORS
 *    preflight, which `cors.ts` refuses for unknown origins.
 *
 * The guard runs once in the gateway, before any app/plugin handler is
 * dispatched, so it covers every domain app (auth, api, households, tasks,
 * calendar, plugins) and every plugin route without per-app wiring to forget.
 *
 * Not `hono/csrf`: its defaults reject a request that carries neither `Origin`
 * nor `Sec-Fetch-Site` (which would break the scripted admin flows this issue
 * must keep working) and its origin check only knows the request URL, not the
 * shared allow-list that also has to admit local dev's separate SPA port. The
 * checks below are the same idea with this app's policy.
 */

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const INTERNAL_PATH_PREFIX = '/api/internal/'

/** Stable machine-readable error the frontend/scripts can branch on. */
export const CSRF_ORIGIN_MISMATCH = 'csrf_origin_mismatch'

/** Serialize an Origin/Referer value to `scheme://host[:port]`, or null. */
function parseOrigin(value: string): string | null {
  try {
    const origin = new URL(value).origin
    // `new URL('null')` throws already, but guard the serialized opaque
    // origin explicitly — Node/browser parsers differ on it.
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

function hasBearerCredentials(request: Request): boolean {
  const authorization = request.headers.get('Authorization')
  return !!authorization && authorization.trim().toLowerCase().startsWith('bearer ')
}

/** `localhost`, `127.0.0.1`, `[::1]` — where `bun dev` and the Docker harness run. */
function isLoopbackOrigin(origin: string | null): boolean {
  if (!origin) return false
  try {
    const { hostname } = new URL(origin)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  } catch {
    return false
  }
}

function rejection(): Response {
  return new Response(JSON.stringify({ error: CSRF_ORIGIN_MISMATCH }), {
    status: 403,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-cache' },
  })
}

/**
 * Returns a 403 Response when a state-changing request's supplied origin
 * disagrees with this deployment, or null when the request may proceed.
 * Takes the raw Request rather than a Hono Context so the single call site in
 * `gateway.ts` can run it before dispatch (and tests can drive it directly).
 */
export function csrfOriginGuard(request: Request, env: Env['Bindings']): Response | null {
  if (!STATE_CHANGING_METHODS.has(request.method.toUpperCase())) return null

  // Bearer-secret machine channel (#376/#451 ingest, brochures, scrape
  // commands): no session cookie, no CSRF. Exempted by path AND by credential
  // so neither side of that contract can drift into a 403.
  if (new URL(request.url).pathname.startsWith(INTERNAL_PATH_PREFIX)) return null
  if (hasBearerCredentials(request)) return null

  const originHeader = request.headers.get('Origin')
  const refererHeader = request.headers.get('Referer')
  const supplied = originHeader?.trim() ? originHeader : refererHeader
  // No Origin and no Referer: curl / scripted admin flows (and same-origin
  // navigations in older clients) must keep working.
  if (!supplied?.trim()) return null

  const suppliedOrigin = parseOrigin(supplied)
  if (suppliedOrigin === null) return rejection()

  const ownOrigin = parseOrigin(
    getRequestOrigin({
      req: { url: request.url, header: (name) => request.headers.get(name) ?? undefined },
    })
  )
  if (suppliedOrigin === ownOrigin) return null
  if (isConfiguredOrigin(suppliedOrigin, env)) return null
  // Local dev's SPA port (:5173/:8788) is cross-origin but same-site, so it is
  // on the CORS *read* list. It may drive writes only when this request is
  // itself loopback: in production a page served from the user's own localhost
  // is not this app, and letting it authorize writes would reopen — for the
  // pre-fix `SameSite=None` sessions this guard exists to cover — exactly what
  // SameSite=Lax just closed (#528 review A2).
  if (isDevOrigin(suppliedOrigin) && isLoopbackOrigin(ownOrigin)) return null

  return rejection()
}
