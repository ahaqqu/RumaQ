import { describe, it, expect, vi } from 'vite-plus/test'
import { propsAuthMiddleware } from '../auth.js'

describe('propsAuthMiddleware', () => {
  it('sets userId and householdId from env.props', async () => {
    const set = vi.fn()
    const c = {
      env: { props: { userId: 'user-123', householdId: 'house-456' } },
      set,
      json: vi.fn(),
    } as any
    const next = vi.fn()
    await propsAuthMiddleware(c, next)
    expect(set).toHaveBeenCalledWith('userId', 'user-123')
    expect(set).toHaveBeenCalledWith('householdId', 'house-456')
    expect(next).toHaveBeenCalled()
  })

  it('returns 401 when props are missing', async () => {
    const c = {
      env: {},
      set: vi.fn(),
      json: vi.fn((body, status) => new Response(JSON.stringify(body), { status })),
    } as any
    await propsAuthMiddleware(c, vi.fn())
    expect(c.json).toHaveBeenCalledWith({ error: 'Unauthorized' }, 401)
  })

  it('returns 401 when userId is missing', async () => {
    const c = {
      env: { props: { householdId: 'house-456' } },
      set: vi.fn(),
      json: vi.fn((body, status) => new Response(JSON.stringify(body), { status })),
    } as any
    await propsAuthMiddleware(c, vi.fn())
    expect(c.json).toHaveBeenCalledWith({ error: 'Unauthorized' }, 401)
  })

  it('returns 401 when householdId is missing', async () => {
    const c = {
      env: { props: { userId: 'user-123' } },
      set: vi.fn(),
      json: vi.fn((body, status) => new Response(JSON.stringify(body), { status })),
    } as any
    await propsAuthMiddleware(c, vi.fn())
    expect(c.json).toHaveBeenCalledWith({ error: 'Unauthorized' }, 401)
  })
})
