import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { useUpdateStock } from './stock.js'
import { patchStock } from '../api'

vi.mock('../api', () => ({
  getStock: vi.fn(),
  patchStock: vi.fn(),
}))

const STOCK_KEY = ['stock', { location: undefined, q: undefined }]

function createWrapper(queryClient) {
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

describe('useUpdateStock', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(STOCK_KEY, {
      stock: [
        { id: 's1', name: 'Milk', qty: 5, unit: 'L' },
        { id: 's2', name: 'Eggs', qty: 10, unit: 'pcs' },
      ],
    })
    vi.clearAllMocks()
  })

  it('applies the optimistic update before the server responds', async () => {
    let resolvePatch
    patchStock.mockReturnValue(
      new Promise((resolve) => {
        resolvePatch = resolve
      })
    )

    const { result } = renderHook(() => useUpdateStock(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      result.current.mutate({ id: 's1', payload: { qty: 6 } })
    })

    const cached = queryClient.getQueryData(STOCK_KEY)
    expect(cached.stock.find((i) => i.id === 's1').qty).toBe(6)
    expect(cached.stock.find((i) => i.id === 's2').qty).toBe(10)
    await waitFor(() => expect(result.current.isPending).toBe(true))

    await act(async () => {
      resolvePatch({ id: 's1', qty: 6 })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  it('rolls back when the mutation fails', async () => {
    patchStock.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useUpdateStock(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      result.current.mutate({ id: 's1', payload: { qty: 6 } })
    })

    await waitFor(() => expect(result.current.isError).toBe(true))
    const cached = queryClient.getQueryData(STOCK_KEY)
    expect(cached.stock.find((i) => i.id === 's1').qty).toBe(5)
  })

  it('invalidates stock queries on settle', async () => {
    patchStock.mockResolvedValue({ id: 's1', qty: 6 })

    const { result } = renderHook(() => useUpdateStock(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      result.current.mutate({ id: 's1', payload: { qty: 6 } })
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(queryClient.getQueryState(STOCK_KEY).isInvalidated).toBe(true)
  })
})
