import { cors } from 'hono/cors'
import type { Env } from './types.js'

export function createCors() {
  return cors({
    origin: (origin, c) => {
      if (!origin) return 'null'
      const env = c.env as Env['Bindings']
      const allowed = env.PAGES_ORIGIN || 'https://rumaq.ahaqqu.com'

      // Exact production / configured origin
      if (origin === allowed) {
        return origin
      }

      // Local development
      if (origin === 'http://localhost:5173' || origin === 'http://localhost:8788') {
        return origin
      }

      // Branch previews under the allowed Pages hostname
      if (origin.endsWith('.pages.dev')) {
        try {
          const allowedHost = new URL(allowed).hostname
          if (allowedHost.endsWith('.pages.dev') && origin.endsWith('.' + allowedHost)) {
            return origin
          }
        } catch {
          // malformed PAGES_ORIGIN, fall through to reject
        }
      }

      // Reject unknown origins in production. Returning 'null' here tells Hono
      // to send Access-Control-Allow-Origin: null, which browsers will treat as
      // a failed preflight / CORS check for authenticated requests.
      return 'null'
    },
    credentials: true,
  })
}
