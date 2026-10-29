import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { useReviewItems, useDecideReview, useUndoReview, selectReviewPageData } from './review.js'
import { getReviewItems, decideReviewItem, undoReviewDecision } from '../api'

vi.mock('../api', () => ({
  getReviewItems: vi.fn(),
  decideReviewItem: vi.fn(),
  undoReviewDecision: vi.fn(),
}))

function reviewItem(id, status = 'pending') {
  return {
    id,
    itemName: `Item ${id}`,
    entryName: `Entry ${id}`,
    status,
    decidedAt: status === 'pending' ? null : '2026-10-29T10:00:00.000Z',
    decidedBy: status === 'pending' ? null : 'admin-1',
  }
}

function infiniteData(pages) {
  return {
    pages,
    pageParams: pages.map((_, i) => i * 50),
  }
}

function page(items, counts, filteredTotal) {
  return { items, counts, filteredTotal }
}

function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

describe('selectReviewPageData', () => {
  it('flattens pages and reads the exact counts from the FIRST page', () => {
    const data = infiniteData([
      page([reviewItem('a')], { pending: 5, approved: 1, rejected: 2 }, 5),
      page([reviewItem('b')], { pending: 999, approved: 0, rejected: 0 }, 0),
    ])
    const selected = selectReviewPageData(data)
    expect(selected.items.map((item) => item.id)).toEqual(['a', 'b'])
    // Later pages repeat the same server-side GROUP BY — the first page wins,
    // so appended pages never distort the badges.
    expect(selected.counts).toEqual({ pending: 5, approved: 1, rejected: 2 })
    expect(selected.filteredTotal).toBe(5)
  })

  it('survives an absent first page', () => {
    expect(selectReviewPageData(undefined)).toEqual({
      items: [],
      counts: { pending: 0, approved: 0, rejected: 0 },
      filteredTotal: 0,
    })
  })
})

describe('useReviewItems', () => {
  beforeEach(() => {
    vi.mocked(getReviewItems).mockReset()
  })

  it('fetches 50-per-page offset windows and stops when the feed is exhausted', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.mocked(getReviewItems).mockImplementation(async ({ status, limit, offset }) => {
      expect(status).toBe('pending')
      expect(limit).toBe(50)
      if (offset === 0)
        return page([reviewItem('a'), reviewItem('b')], { pending: 3, approved: 0, rejected: 0 }, 3)
      return page([reviewItem('c')], { pending: 3, approved: 0, rejected: 0 }, 3)
    })

    const { result } = renderHook(() => useReviewItems('pending'), {
      wrapper: createWrapper(queryClient),
    })
    await waitFor(() => expect(result.current.data.items).toHaveLength(2))

    await result.current.fetchNextPage()
    await waitFor(() => expect(result.current.data.items).toHaveLength(3))
    expect(getReviewItems).toHaveBeenCalledTimes(2)
    // loaded (3) === filteredTotal (3) → no next page.
    expect(result.current.hasNextPage).toBe(false)
  })
})

describe('useDecideReview / useUndoReview', () => {
  beforeEach(() => {
    vi.mocked(decideReviewItem).mockReset()
    vi.mocked(undoReviewDecision).mockReset()
  })

  function seedQueue(queryClient) {
    const data = infiniteData([
      page(
        [reviewItem('rev-1'), reviewItem('rev-2', 'approved')],
        { pending: 1, approved: 1, rejected: 0 },
        2
      ),
    ])
    queryClient.setQueryData(['review', 'pending'], data)
    queryClient.setQueryData(
      ['review', 'all'],
      infiniteData([page([reviewItem('rev-1')], { pending: 1, approved: 1, rejected: 0 }, 2)])
    )
  }

  it('optimistically marks the row approved in every cached filter, then rolls back on error', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    seedQueue(queryClient)
    vi.mocked(decideReviewItem).mockRejectedValue(new Error('boom'))

    const { result } = renderHook(() => useDecideReview(), {
      wrapper: createWrapper(queryClient),
    })
    result.current.mutate({ id: 'rev-1', decision: 'approved' })

    await waitFor(() => expect(result.current.isError).toBe(true))
    // Rollback restored both cached filters to the pre-mutation snapshot.
    const pending = queryClient.getQueryData(['review', 'pending'])
    expect(pending.pages[0].items.find((item) => item.id === 'rev-1').status).toBe('pending')
    const all = queryClient.getQueryData(['review', 'all'])
    expect(all.pages[0].items.find((item) => item.id === 'rev-1').status).toBe('pending')
  })

  it('optimistically marks the row approved, and undo returns it to pending', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    seedQueue(queryClient)
    vi.mocked(decideReviewItem).mockResolvedValue({ item: reviewItem('rev-1', 'approved') })
    vi.mocked(undoReviewDecision).mockResolvedValue({ item: reviewItem('rev-1') })

    const { result: decide } = renderHook(() => useDecideReview(), {
      wrapper: createWrapper(queryClient),
    })
    decide.current.mutate({ id: 'rev-1', decision: 'approved' })
    await waitFor(() => expect(decide.current.isSuccess).toBe(true))
    const approved = queryClient.getQueryData(['review', 'all'])
    expect(approved.pages[0].items.find((item) => item.id === 'rev-1').status).toBe('approved')

    const { result: undo } = renderHook(() => useUndoReview(), {
      wrapper: createWrapper(queryClient),
    })
    undo.current.mutate({ id: 'rev-1' })
    await waitFor(() => expect(undo.current.isSuccess).toBe(true))
    const undone = queryClient.getQueryData(['review', 'all'])
    const row = undone.pages[0].items.find((item) => item.id === 'rev-1')
    expect(row.status).toBe('pending')
    expect(row.decidedAt).toBeNull()
  })
})
