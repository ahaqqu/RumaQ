import { describe, it, expect, vi } from 'vite-plus/test'
import { requireAdmin } from '../lib/admin.js'

// Admin access is the users.is_admin column (migration 0014) — requireAdmin
// reads it from the users SELECT it already runs; there is no env fallback.
function createContext(overrides: {
  userId?: string
  userRow?: { email: string | null; is_admin?: number } | null
}) {
  const json = vi.fn(() => ({ headers: { set: vi.fn() } }))
  const c = {
    env: { DB: { prepare: vi.fn() } },
    get: vi.fn((key: string) => (key === 'userId' ? overrides.userId : undefined)),
    json,
  }
  if (overrides.userRow !== undefined) {
    c.env.DB.prepare.mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(overrides.userRow),
    })
  }
  const next = vi.fn()
  return { c: c as unknown as Parameters<typeof requireAdmin>[0], next, json }
}

describe('requireAdmin', () => {
  it('calls next when users.is_admin is 1', async () => {
    const { c, next } = createContext({
      userId: 'user-1',
      userRow: { email: 'angga.haqqu@gmail.com', is_admin: 1 },
    })
    await requireAdmin(c, next)
    expect(next).toHaveBeenCalled()
  })

  it('returns 403 when users.is_admin is 0', async () => {
    const { c, next, json } = createContext({
      userId: 'user-2',
      userRow: { email: 'someone.else@gmail.com', is_admin: 0 },
    })
    await requireAdmin(c, next)
    expect(next).not.toHaveBeenCalled()
    expect(json).toHaveBeenCalledWith({ error: 'Forbidden' }, 403)
  })

  it('returns 403 when the row has no is_admin value', async () => {
    const { c, next, json } = createContext({
      userId: 'user-4',
      userRow: { email: 'angga.haqqu@gmail.com' },
    })
    await requireAdmin(c, next)
    expect(next).not.toHaveBeenCalled()
    expect(json).toHaveBeenCalledWith({ error: 'Forbidden' }, 403)
  })

  it('returns 403 when the user row is missing', async () => {
    const { c, next, json } = createContext({ userId: 'user-3', userRow: null })
    await requireAdmin(c, next)
    expect(next).not.toHaveBeenCalled()
    expect(json).toHaveBeenCalledWith({ error: 'Forbidden' }, 403)
  })
})
