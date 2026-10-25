import { describe, it, expect, beforeEach, vi } from 'vite-plus/test'
import { useMeQueryOptions } from './me'

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    GET: vi.fn(),
  },
}))

vi.mock('openapi-fetch', () => ({
  default: () => clientMock,
}))

const ok = (data) => ({ data, error: undefined, response: { ok: true, status: 200 } })
const fail = (error, status = 500) => ({
  data: undefined,
  error,
  response: { ok: false, status },
})

beforeEach(() => {
  clientMock.GET.mockReset()
})

describe('me query', () => {
  it('revalidates on every mount so a stale persisted session cannot survive', () => {
    expect(useMeQueryOptions().refetchOnMount).toBe('always')
  })

  it('resolves to null on 401 so the logged-out state overwrites persisted cache', async () => {
    clientMock.GET.mockResolvedValueOnce(fail({ error: 'Unauthorized' }, 401))
    await expect(useMeQueryOptions().queryFn()).resolves.toBeNull()
  })

  it('still throws on non-401 errors', async () => {
    clientMock.GET.mockResolvedValueOnce(fail({ error: 'Server error' }, 500))
    await expect(useMeQueryOptions().queryFn()).rejects.toThrow('Server error')
  })

  it('returns the user on success', async () => {
    const user = { user: { id: '1', email: 'a@b.com' } }
    clientMock.GET.mockResolvedValueOnce(ok(user))
    await expect(useMeQueryOptions().queryFn()).resolves.toEqual(user)
  })
})
