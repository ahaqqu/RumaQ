import { describe, it, expect, beforeEach, vi } from 'vite-plus/test'
import { useMeQueryOptions } from './me'

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    get: vi.fn(),
    setConfig: vi.fn(),
  },
}))

vi.mock('../api-client/client.gen.js', () => ({
  client: clientMock,
}))

// The response stub models the real fetch Response surface unwrap() reads —
// status/ok plus the headers it inspects (Retry-After on 429s).
const ok = (data) => ({
  data,
  error: undefined,
  response: { ok: true, status: 200, headers: { get: () => null } },
})
const fail = (error, status = 500) => ({
  data: undefined,
  error,
  response: { ok: false, status, headers: { get: () => null } },
})

beforeEach(() => {
  clientMock.get.mockReset()
})

describe('me query', () => {
  it('revalidates on every mount so a stale persisted session cannot survive', () => {
    expect(useMeQueryOptions().refetchOnMount).toBe('always')
  })

  it('resolves to null on 401 so the logged-out state overwrites persisted cache', async () => {
    clientMock.get.mockResolvedValueOnce(fail({ error: 'Unauthorized' }, 401))
    await expect(useMeQueryOptions().queryFn()).resolves.toBeNull()
  })

  it('still throws on non-401 errors', async () => {
    clientMock.get.mockResolvedValueOnce(fail({ error: 'Server error' }, 500))
    await expect(useMeQueryOptions().queryFn()).rejects.toThrow('Server error')
  })

  it('returns the user on success', async () => {
    const user = { user: { id: '1', email: 'a@b.com' } }
    clientMock.get.mockResolvedValueOnce(ok(user))
    await expect(useMeQueryOptions().queryFn()).resolves.toEqual(user)
  })
})
