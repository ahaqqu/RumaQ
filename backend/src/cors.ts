import { cors } from 'hono/cors'
import type { Env } from './types.js'

/**
 * Local development: the SPA runs on its own port and calls the API
 * cross-origin (VITE_API_BASE / the Vite proxy), so these are origins the app
 * legitimately runs on — but only *locally*. They may read responses from
 * anywhere (CORS, below); the CSRF guard only lets them drive writes when the
 * request itself is loopback (#528 review A2).
 */
const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:8788'] as const

/** True for the local dev SPA ports (`bun dev`, `vite preview`). */
export function isDevOrigin(origin: string): boolean {
  return (DEV_ORIGINS as readonly string[]).includes(origin)
}

/**
 * True for an origin this deployment is actually served from: the configured
 * origin (`PAGES_ORIGIN`, default the canonical one) and branch previews under
 * a `*.pages.dev` project. Excludes the dev origins — callers that grant
 * authority (writes) rather than visibility use this, not `isAllowedOrigin`.
 * `origin` is expected in serialized form (`https://host[:port]`, no trailing
 * slash) — callers normalize through `new URL().origin`.
 */
export function isConfiguredOrigin(origin: string, env: Env['Bindings']): boolean {
  const allowed = env.PAGES_ORIGIN || 'https://rumaq.ahaqqu.com'

  // Exact production / configured origin
  if (origin === allowed) {
    return true
  }

  // Branch previews under the allowed Pages hostname
  if (origin.endsWith('.pages.dev')) {
    try {
      const allowedHost = new URL(allowed).hostname
      if (allowedHost.endsWith('.pages.dev') && origin.endsWith('.' + allowedHost)) {
        return true
      }
    } catch {
      // malformed PAGES_ORIGIN, fall through to reject
    }
  }

  return false
}

/**
 * The CORS read allow-list (ahaqqu/RumaQ#528): which origins may read
 * responses. Wider than `isConfiguredOrigin` on purpose — local dev's separate
 * SPA port has to read too. Reads are the question this list answers; who may
 * *write* is decided in `lib/csrf.ts`, which additionally requires the request
 * to be loopback before trusting a dev origin.
 */
export function isAllowedOrigin(origin: string, env: Env['Bindings']): boolean {
  return isConfiguredOrigin(origin, env) || isDevOrigin(origin)
}

export function createCors() {
  return cors({
    origin: (origin, c) => {
      if (!origin) return 'null'
      // Reject unknown origins in production. Returning 'null' here tells Hono
      // to send Access-Control-Allow-Origin: null, which browsers will treat as
      // a failed preflight / CORS check for authenticated requests.
      return isAllowedOrigin(origin, c.env as Env['Bindings']) ? origin : 'null'
    },
    credentials: true,
  })
}
