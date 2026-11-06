import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { usePluginCatalog, useSetPluginEnablement } from './plugins.js'
import { getPluginCatalog, setPluginEnablement } from '../api'

// The toggle is a household fact: it must land in BOTH caches the UI reads —
// the catalog rows and the /api/me payload the nav gating derives from
// (plugins/context.jsx) — optimistically, roll back cleanly, and re-read
// from the server on settle.

vi.mock('../api', () => ({
  getPluginCatalog: vi.fn(),
  setPluginEnablement: vi.fn(),
}))

const PLUGINS_KEY = ['plugin-catalog']
const ME_KEY = ['me']

function createWrapper(queryClient) {
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

const CATALOG = {
  plugins: [
    {
      id: 'documents',
      name: 'Documents',
      capabilities: ['purge', 'export'],
      default_enabled: true,
      enabled: true,
      source: 'default',
      deployment_available: true,
      plan_entitled: true,
      available: true,
    },
  ],
}

const ME = {
  user: { id: 'u1', email: 'a@b.com', name: 'Alice', isAdmin: false },
  enabledPlugins: ['documents'],
}

describe('usePluginCatalog', () => {
  it('fetches the catalog for the active household', async () => {
    getPluginCatalog.mockResolvedValue(CATALOG)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => usePluginCatalog(), {
      wrapper: createWrapper(queryClient),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(getPluginCatalog).toHaveBeenCalled()
    expect(result.current.data).toEqual(CATALOG)
  })
})

describe('useSetPluginEnablement', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(PLUGINS_KEY, CATALOG)
    queryClient.setQueryData(ME_KEY, ME)
    vi.clearAllMocks()
  })

  it('toggles both caches optimistically (catalog row + /api/me advertisement)', async () => {
    let resolvePut
    setPluginEnablement.mockReturnValue(
      new Promise((resolve) => {
        resolvePut = resolve
      })
    )

    const { result } = renderHook(() => useSetPluginEnablement(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ pluginId: 'documents', status: 'disabled' }))

    expect(queryClient.getQueryData(PLUGINS_KEY).plugins[0]).toMatchObject({
      enabled: false,
      source: 'household',
      available: false,
    })
    expect(queryClient.getQueryData(ME_KEY).enabledPlugins).toEqual([])

    await act(async () => resolvePut(CATALOG.plugins[0]))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  it('rolls both caches back when the server rejects the toggle', async () => {
    setPluginEnablement.mockRejectedValue(new Error('forbidden'))
    const { result } = renderHook(() => useSetPluginEnablement(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ pluginId: 'documents', status: 'disabled' }))
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(queryClient.getQueryData(PLUGINS_KEY).plugins[0]).toMatchObject({
      enabled: true,
      source: 'default',
    })
    expect(queryClient.getQueryData(ME_KEY).enabledPlugins).toEqual(['documents'])
  })

  it('recomputes an absent enabledPlugins as all-catalog-enabled before the toggle', async () => {
    // The §4.5 contract: a me payload WITHOUT the field means every catalog
    // plugin is enabled — disabling one must produce the explicit remainder
    // ([]), not corrupt the fallback.
    queryClient.setQueryData(ME_KEY, { user: ME.user })
    setPluginEnablement.mockResolvedValue(CATALOG.plugins[0])
    const { result } = renderHook(() => useSetPluginEnablement(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ pluginId: 'documents', status: 'disabled' }))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(queryClient.getQueryData(ME_KEY).enabledPlugins).toEqual([])
  })

  it('invalidates the catalog and me caches on settle', async () => {
    setPluginEnablement.mockResolvedValue(CATALOG.plugins[0])
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useSetPluginEnablement(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ pluginId: 'documents', status: 'disabled' }))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const keys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey)
    expect(keys).toContainEqual(PLUGINS_KEY)
    expect(keys).toContainEqual(ME_KEY)
  })
})
