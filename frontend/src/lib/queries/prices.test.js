import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { usePrices, usePriceMeta, usePriceSources, usePricePromos } from './prices.js'
import { getPrices, getPricesMeta, getPromos } from '../api'

vi.mock('../api', () => ({
  getPrices: vi.fn(),
  getPricesMeta: vi.fn(),
  getPriceDetail: vi.fn(),
  getPriceRuns: vi.fn(),
  getPromos: vi.fn(),
}))

function createWrapper(queryClient) {
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

describe('usePrices', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    vi.clearAllMocks()
    getPrices.mockResolvedValue({ items: [], total: 0 })
  })

  it('threads q, source, and sort into the query and the cache key', async () => {
    const { result } = renderHook(
      () => usePrices({ q: 'beras', source: 'superindo', sort: 'cheapest' }),
      { wrapper: createWrapper(queryClient) }
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(getPrices).toHaveBeenCalledWith(
      { q: 'beras', source: 'superindo', sort: 'cheapest' },
      expect.anything()
    )
    expect(queryClient.getQueryData(['prices', 'beras', 'superindo', 'cheapest'])).toEqual({
      items: [],
      total: 0,
    })
  })

  it('defaults the sort key slot so unsorted and sorted queries cache apart', async () => {
    const { result } = renderHook(() => usePrices(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    // No sort sent — this is the slot usePriceSources also hits.
    expect(getPrices).toHaveBeenCalledWith(
      { q: undefined, source: undefined, sort: undefined },
      expect.anything()
    )
    expect(queryClient.getQueryData(['prices', '', '', ''])).toEqual({ items: [], total: 0 })
  })

  it('auto-refreshes every 5 minutes while the tab is visible', async () => {
    const { result } = renderHook(() => usePrices({ sort: 'savings' }), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    // react-query only polls when the tab is visible (its default), so the
    // interval itself is the visible-tab semantics.
    expect(queryClient.getQueryCache().getAll()[0].options.refetchInterval).toBe(300_000)
  })
})

describe('usePriceMeta', () => {
  it('polls the freshness meta endpoint on its own cache key', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.clearAllMocks()
    getPricesMeta.mockResolvedValue({
      latestScrapedAt: '2026-10-29T01:00:05Z',
      latestObservedDate: '2026-10-29',
      observationCount: 42,
    })

    const { result } = renderHook(() => usePriceMeta(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(getPricesMeta).toHaveBeenCalledTimes(1)
    expect(result.current.data.observationCount).toBe(42)
    expect(queryClient.getQueryCache().getAll()[0].options.refetchInterval).toBe(300_000)
  })
})

describe('usePricePromos', () => {
  it('polls the promo catalog on its own cache key with the shared refresh', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.clearAllMocks()
    getPromos.mockResolvedValue({ types: [], total: 0 })

    const { result } = renderHook(() => usePricePromos(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(getPromos).toHaveBeenCalledTimes(1)
    // Same 5-min visible-tab cadence as usePrices so the two segments' counts
    // cannot disagree mid-session (PM §7.6).
    expect(queryClient.getQueryCache().getAll()[0].options.refetchInterval).toBe(300_000)
    expect(queryClient.getQueryData(['prices', 'promos'])).toEqual({ types: [], total: 0 })
  })
})

describe('usePriceSources', () => {
  it('queries the endpoint without sort so the chip bar cannot shrink', async () => {
    // PM §7.4: chips come from the legacy no-sort response. Sending a sort
    // here would page products away and silently shrink the chip bar.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.clearAllMocks()
    getPrices.mockResolvedValue({
      items: [
        { product_key: 'a', source_slug: 'lotte-mart', source_name: 'Lotte Mart' },
        { product_key: 'b', source_slug: 'superindo', source_name: 'Superindo' },
        { product_key: 'a', source_slug: 'superindo', source_name: 'Superindo' },
      ],
      total: 3,
    })

    const { result } = renderHook(() => usePriceSources(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(getPrices).toHaveBeenCalledWith({}, expect.anything())
    expect(result.current.data).toEqual([
      { slug: 'lotte-mart', name: 'Lotte Mart' },
      { slug: 'superindo', name: 'Superindo' },
    ])
  })
})
