import { describe, it, expect, beforeEach, vi } from 'vite-plus/test'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { useLogout, useMeQueryOptions } from './me'

const { clientMock, apiLogoutMock } = vi.hoisted(() => ({
  clientMock: {
    get: vi.fn(),
    setConfig: vi.fn(),
  },
  apiLogoutMock: vi.fn(),
}))

// Partial mock: the me-query tests exercise the real fetchMe→getMe→client
// chain; only `logout` is replaced so useLogout's ordering is observable.
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, logout: apiLogoutMock }
})

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

// L8 (audit): the cache must be cleared only AFTER the logout succeeds —
// clearing before the await dropped the whole cache and the running mutation
// on a failed logout while the session stayed live.
describe('useLogout', () => {
  let lastQueryClient

  function renderLogoutHook() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    lastQueryClient = queryClient
    queryClient.setQueryData(['me'], { user: { id: 'u1' } })
    const clearSpy = vi.spyOn(queryClient, 'clear')
    const wrapper = ({ children }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children)
    return { queryClient, clearSpy, ...renderHook(() => useLogout(), { wrapper }) }
  }

  beforeEach(() => {
    apiLogoutMock.mockReset()
    lastQueryClient = null
  })

  it('clears the cache after the logout POST succeeds', async () => {
    apiLogoutMock.mockResolvedValue(undefined)
    const { queryClient, clearSpy, result } = renderLogoutHook()
    result.current.mutate()
    // While the request is in flight the cache is still intact.
    expect(clearSpy).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(clearSpy).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(['me'])).toBeUndefined()
  })

  it('keeps the cache when the logout fails', async () => {
    apiLogoutMock.mockRejectedValue(new Error('Logout failed: 500'))
    const { clearSpy, result } = renderLogoutHook()
    result.current.mutate()
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(clearSpy).not.toHaveBeenCalled()
    // The session data the user was looking at survives the failed logout.
    expect(lastQueryClient.getQueryData(['me'])).toBeDefined()
  })
})
