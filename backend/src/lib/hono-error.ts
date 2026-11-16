// The ONE error handler every Hono app mounts (audit 2026-11-16 L10/L11 —
// six per-app copies collapsed into this factory; auth, which had none, gets
// the same fallback. BACKEND_CONVENTIONS.md "Errors": a consistent error
// shape and a shared handler across apps). Two behaviors are load-bearing:
//
// 1. Typed lib errors (each app passes its own mapping) keep their
//    intentional, user-facing message — the lib classes own the wording, the
//    handler only picks the status (and the cache directive).
// 2. Anything UNCAUGHT returns FIXED text and is logged server-side — D1 /
//    SQL / valibot text must never reach a client (BACKEND_CONVENTIONS.md
//    "Errors"; the api app echoed `err.message` here until audit L10 flagged
//    it).
//
// Every response carries the NO_CACHE directive (lib/request.ts): error
// bodies ride per-household facts, so the edge must never cache them.

import type { Env as HonoEnv, ErrorHandler } from 'hono'
import { NO_CACHE } from './request.js'

/** A lib error class mapped to its client status. `cache` appends the shared
 * NO_CACHE directive — each app passes exactly what it answered before the
 * handler was shared, so no route's headers change. */
type TypedErrorMapping = readonly [
  error: new (...args: any[]) => Error,
  status: 400 | 403 | 404 | 409 | 413 | 415,
  cache?: boolean,
]

/** The fixed body an uncaught error answers with — the one string a client
 * may see when the handler itself cannot name the failure. */
export const INTERNAL_ERROR_BODY = 'Internal server error'

export function createAppOnError<E extends HonoEnv>(
  mappings: readonly TypedErrorMapping[] = []
): ErrorHandler<E> {
  return (err, c) => {
    for (const [error, status, cache] of mappings) {
      if (err instanceof error) {
        return c.json({ error: err.message }, status, cache ? NO_CACHE : undefined)
      }
    }
    console.error(err)
    return c.json({ error: INTERNAL_ERROR_BODY }, 500, NO_CACHE)
  }
}
