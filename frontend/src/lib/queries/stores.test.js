import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { useCreateStore, useDeleteStore } from './stores.js'
import { createStore, deleteStore } from '../api'

vi.mock('../api', () => ({
  getStores: vi.fn(),
  createStore: vi.fn(),
  deleteStore: vi.fn(),
}))

const STORES_KEY = ['stores']

function createWrapper(queryClient) {
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

describe('useCreateStore', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(STORES_KEY, {
      stores: [{ id: 's-1', label: 'Indomaret' }],
    })
    vi.clearAllMocks()
  })

  it('adds the store optimistically before the server responds', async () => {
    let resolveCreate
    createStore.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve
      })
    )

    const { result } = renderHook(() => useCreateStore(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      result.current.mutate('Alfamart')
    })

    const cached = queryClient.getQueryData(STORES_KEY)
    expect(cached.stores).toHaveLength(2)
    expect(cached.stores.find((s) => s.label === 'Alfamart')).toBeTruthy()

    await act(async () => {
      resolveCreate({ id: 's-2', label: 'Alfamart' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  it('rolls back the optimistic add when the mutation fails', async () => {
    createStore.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useCreateStore(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      result.current.mutate('Alfamart')
    })

    await waitFor(() => expect(result.current.isError).toBe(true))
    const cached = queryClient.getQueryData(STORES_KEY)
    expect(cached.stores).toHaveLength(1)
    expect(cached.stores.find((s) => s.label === 'Alfamart')).toBeFalsy()
  })

  it('invalidates stores on settle', async () => {
    createStore.mockResolvedValue({ id: 's-2', label: 'Alfamart' })

    const { result } = renderHook(() => useCreateStore(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      result.current.mutate('Alfamart')
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(queryClient.getQueryState(STORES_KEY).isInvalidated).toBe(true)
  })
})

describe('useDeleteStore', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(STORES_KEY, {
      stores: [
        { id: 's-1', label: 'Indomaret' },
        { id: 's-2', label: 'Alfamart' },
      ],
    })
    vi.clearAllMocks()
  })

  it('removes the store optimistically before the server responds', async () => {
    let resolveDelete
    deleteStore.mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = resolve
      })
    )

    const { result } = renderHook(() => useDeleteStore(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      result.current.mutate('s-2')
    })

    const cached = queryClient.getQueryData(STORES_KEY)
    expect(cached.stores).toHaveLength(1)
    expect(cached.stores.find((s) => s.id === 's-2')).toBeFalsy()

    await act(async () => {
      resolveDelete({ ok: true })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  it('rolls back the optimistic delete when the mutation fails', async () => {
    deleteStore.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useDeleteStore(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      result.current.mutate('s-2')
    })

    await waitFor(() => expect(result.current.isError).toBe(true))
    const cached = queryClient.getQueryData(STORES_KEY)
    expect(cached.stores).toHaveLength(2)
    expect(cached.stores.find((s) => s.id === 's-2')).toBeTruthy()
  })

  it('invalidates stores on settle', async () => {
    deleteStore.mockResolvedValue({ ok: true })

    const { result } = renderHook(() => useDeleteStore(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      result.current.mutate('s-2')
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(queryClient.getQueryState(STORES_KEY).isInvalidated).toBe(true)
  })
})
