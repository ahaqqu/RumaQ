import type { MiddlewareHandler } from 'hono'

import type { Env } from '../types.js'

// Operator allowlist for admin-only surfaces (the scraping monitor,
// haqita-integration.md §7.1). Configured as the comma-separated
// ADMIN_EMAILS Worker secret; empty/unset means nobody is admin.
// Google emails are case-insensitive, so matching is too.
export function isAdminEmail(
  allowlist: string | undefined,
  email: string | null | undefined
): boolean {
  if (!allowlist || !email) return false
  const admins = allowlist
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  return admins.includes(email.toLowerCase())
}

// Must run after propsAuthMiddleware (needs the resolved userId).
export const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
  const user = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?')
    .bind(c.get('userId'))
    .first<{ email: string | null }>()
  if (!isAdminEmail(c.env.ADMIN_EMAILS, user?.email)) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await next()
}
