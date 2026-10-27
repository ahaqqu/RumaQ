import { describe, it, expect, vi } from 'vite-plus/test'
import { isAdminEmail, requireAdmin } from '../lib/admin.js'

describe('isAdminEmail', () => {
  it('matches case-insensitively and ignores whitespace', () => {
    expect(isAdminEmail('Angga.Haqqu@gmail.com', 'angga.haqqu@gmail.com')).toBe(true)
    expect(isAdminEmail(' angga.haqqu@gmail.com ', 'ANGGA.HAQQU@GMAIL.COM')).toBe(true)
  })

  it('supports a comma-separated allowlist', () => {
    const allowlist = 'a@rumaq.dev, b@rumaq.dev ,c@rumaq.dev'
    expect(isAdminEmail(allowlist, 'b@rumaq.dev')).toBe(true)
    expect(isAdminEmail(allowlist, 'd@rumaq.dev')).toBe(false)
  })

  it('returns false when the allowlist or email is missing', () => {
    expect(isAdminEmail(undefined, 'angga.haqqu@gmail.com')).toBe(false)
    expect(isAdminEmail('', 'angga.haqqu@gmail.com')).toBe(false)
    expect(isAdminEmail('angga.haqqu@gmail.com', null)).toBe(false)
    expect(isAdminEmail('angga.haqqu@gmail.com', undefined)).toBe(false)
  })
})

function createContext(overrides: {
  userId?: string
  userRow?: { email: string | null } | null
  adminEmails?: string
}) {
  const json = vi.fn(() => ({ headers: { set: vi.fn() } }))
  const c = {
    env: { ADMIN_EMAILS: overrides.adminEmails, DB: { prepare: vi.fn() } },
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
  it('calls next for allowlisted users', async () => {
    const { c, next } = createContext({
      userId: 'user-1',
      userRow: { email: 'angga.haqqu@gmail.com' },
      adminEmails: 'angga.haqqu@gmail.com',
    })
    await requireAdmin(c, next)
    expect(next).toHaveBeenCalled()
  })

  it('returns 403 for users not on the allowlist', async () => {
    const { c, next, json } = createContext({
      userId: 'user-2',
      userRow: { email: 'someone.else@gmail.com' },
      adminEmails: 'angga.haqqu@gmail.com',
    })
    await requireAdmin(c, next)
    expect(next).not.toHaveBeenCalled()
    expect(json).toHaveBeenCalledWith({ error: 'Forbidden' }, 403)
  })

  it('returns 403 when the user row is missing', async () => {
    const { c, next, json } = createContext({
      userId: 'user-3',
      userRow: null,
      adminEmails: 'angga.haqqu@gmail.com',
    })
    await requireAdmin(c, next)
    expect(next).not.toHaveBeenCalled()
    expect(json).toHaveBeenCalledWith({ error: 'Forbidden' }, 403)
  })

  it('returns 403 when ADMIN_EMAILS is not configured', async () => {
    const { c, next, json } = createContext({
      userId: 'user-4',
      userRow: { email: 'angga.haqqu@gmail.com' },
      adminEmails: undefined,
    })
    await requireAdmin(c, next)
    expect(next).not.toHaveBeenCalled()
    expect(json).toHaveBeenCalledWith({ error: 'Forbidden' }, 403)
  })
})
