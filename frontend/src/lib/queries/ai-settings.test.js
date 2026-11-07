import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { useGeneratePersonaCopy } from './ai-settings.js'
import { generatePersonaCopy } from '../persona.js'

// The persona rewrite is the one MUTATION that bills the household (#523 P5).
// Its result is persona state (localStorage), but its cost is server state, so
// the day's usage meter must be invalidated on settle — a failed rewrite is a
// 502 whose usage row was still written (the #523 P4 A1 rule). Mocking the API
// client boundary keeps these tests on the hook's lifecycle, not transport.
vi.mock('../persona.js', () => ({ generatePersonaCopy: vi.fn() }))

const DRAFT = { enabled: true, userRole: 'raja', aiRole: 'prajurit' }

function createWrapper(queryClient) {
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

describe('useGeneratePersonaCopy (#523 P5)', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    vi.clearAllMocks()
  })

  it('invalidates the usage meter after a successful rewrite', async () => {
    generatePersonaCopy.mockResolvedValue({ homeLead: 'Sire, the kitchen is calm.' })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const { result } = renderHook(() => useGeneratePersonaCopy(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate(DRAFT))

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ai-usage'] }))
    expect(generatePersonaCopy).toHaveBeenCalledWith(DRAFT)
  })

  it('invalidates even when the rewrite fails — the 502 was billed too', async () => {
    generatePersonaCopy.mockRejectedValue(new Error('AI persona rewrite failed'))
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const { result } = renderHook(() => useGeneratePersonaCopy(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate(DRAFT))

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ai-usage'] }))
    expect(result.current.isError).toBe(true)
  })
})
