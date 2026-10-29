import type { MiddlewareHandler } from 'hono'

import type { Env } from '../types.js'

// Must run after propsAuthMiddleware (needs the resolved userId).
// Admin access is the users.is_admin column (migration 0014) — the single
// source of truth, read per-request. Grant/revoke is a manual SQL runbook
// (folds case because OAuth stores the Google-provided email verbatim):
//   cf d1 execute rumaq --remote --command \
//     "UPDATE users SET is_admin = 1 WHERE lower(email) = lower('…');"
export const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
  const user = await c.env.DB.prepare('SELECT email, is_admin FROM users WHERE id = ?')
    .bind(c.get('userId'))
    .first<{ email: string | null; is_admin: number }>()
  if (user?.is_admin !== 1) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await next()
}
