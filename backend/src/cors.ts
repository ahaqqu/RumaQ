import { cors } from 'hono/cors'
import type { Env } from './types.js'

/**
 * The one origin allow-list (ahaqqu/RumaQ#528): CORS uses it to decide which
 * origins may read responses, and the CSRF guard (`lib/csrf.ts`) uses it to
 * decide which origins may drive credentialed writes. Keep them one list — an
 * origin the app legitimately runs on (production, local dev's separate SPA
 * port, a branch preview) is exactly an origin allowed to make same-app
 * requests. `origin` is expected in serialized form (`https://host[:port]`,
 * no trailing slash) — callers normalize through `new URL().origin`.
 */
export function isAllowedOrigin(origin: string, env: Env['Bindings']): boolean {
  const allowed = env.PAGES_ORIGIN || 'https://rumaq.ahaqqu.com'

  // Exact production / configured origin
  if (origin === allowed) {
    return true
  }

  // Local development: the SPA runs on its own port and calls the API
  // cross-origin (VITE_API_BASE / the Vite proxy), so these are legitimate
  // same-app origins, not foreign ones.
  if (origin === 'http://localhost:5173' || origin === 'http://localhost:8788') {
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
