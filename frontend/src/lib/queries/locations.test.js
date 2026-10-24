import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { useCreateLocation, useDeleteLocation } from './locations.js'
import { createLocation, deleteLocation } from '../api'

vi.mock('../api', () => ({
  getLocations: vi.fn(),
  createLocation: vi.fn(),
  deleteLocation: vi.fn(),
}))

const LOCATIONS_KEY = ['locations']

function createWrapper(queryClient) {
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

describe('useCreateLocation', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(LOCATIONS_KEY, {
      locations: [{ id: 'loc-1', label: 'Fridge' }],
    })
    vi.clearAllMocks()
  })

  it('adds the location optimistically before the server responds', async () => {
    let resolveCreate
    createLocation.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve
      })
    )

    const { result } = renderHook(() => useCreateLocation(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      result.current.mutate('Pantry')
    })

    const cached = queryClient.getQueryData(LOCATIONS_KEY)
    expect(cached.locations).toHaveLength(2)
    expect(cached.locations.find((l) => l.label === 'Pantry')).toBeTruthy()

    await act(async () => {
      resolveCreate({ id: 'loc-2', label: 'Pantry' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  it('rolls back the optimistic add when the mutation fails', async () => {
    createLocation.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useCreateLocation(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      result.current.mutate('Pantry')
    })

    await waitFor(() => expect(result.current.isError).toBe(true))
    const cached = queryClient.getQueryData(LOCATIONS_KEY)
    expect(cached.locations).toHaveLength(1)
    expect(cached.locations.find((l) => l.label === 'Pantry')).toBeFalsy()
  })

  it('invalidates locations on settle', async () => {
    createLocation.mockResolvedValue({ id: 'loc-2', label: 'Pantry' })

    const { result } = renderHook(() => useCreateLocation(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      result.current.mutate('Pantry')
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(queryClient.getQueryState(LOCATIONS_KEY).isInvalidated).toBe(true)
  })
})

describe('useDeleteLocation', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(LOCATIONS_KEY, {
      locations: [
        { id: 'loc-1', label: 'Fridge' },
        { id: 'loc-2', label: 'Pantry' },
      ],
    })
    vi.clearAllMocks()
  })

  it('removes the location optimistically before the server responds', async () => {
    let resolveDelete
    deleteLocation.mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = resolve
      })
    )

    const { result } = renderHook(() => useDeleteLocation(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      result.current.mutate('loc-2')
    })

    const cached = queryClient.getQueryData(LOCATIONS_KEY)
    expect(cached.locations).toHaveLength(1)
    expect(cached.locations.find((l) => l.id === 'loc-2')).toBeFalsy()

    await act(async () => {
      resolveDelete({ ok: true })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  it('rolls back the optimistic delete when the mutation fails', async () => {
    deleteLocation.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useDeleteLocation(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      result.current.mutate('loc-2')
    })

    await waitFor(() => expect(result.current.isError).toBe(true))
    const cached = queryClient.getQueryData(LOCATIONS_KEY)
    expect(cached.locations).toHaveLength(2)
    expect(cached.locations.find((l) => l.id === 'loc-2')).toBeTruthy()
  })

  it('invalidates locations on settle', async () => {
    deleteLocation.mockResolvedValue({ ok: true })

    const { result } = renderHook(() => useDeleteLocation(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      result.current.mutate('loc-2')
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(queryClient.getQueryState(LOCATIONS_KEY).isInvalidated).toBe(true)
  })
})
