import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import {
  useReviewItems,
  useDecideReview,
  useUndoReview,
  selectReviewPageData,
  useReviewMode,
  useSetReviewMode,
  useEvaluateReview,
  useAcknowledgeTaxonomy,
  REVIEW_MODE_KEY,
} from './review.js'
import {
  getReviewItems,
  decideReviewItem,
  undoReviewDecision,
  getReviewMode,
  setReviewMode,
  evaluateReviewItems,
  acknowledgeTaxonomy,
} from '../api'

vi.mock('../api', () => ({
  getReviewItems: vi.fn(),
  decideReviewItem: vi.fn(),
  undoReviewDecision: vi.fn(),
  getReviewMode: vi.fn(),
  setReviewMode: vi.fn(),
  evaluateReviewItems: vi.fn(),
  acknowledgeTaxonomy: vi.fn(),
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
      // Issue #628: the split is always present (all zeros) so the counts
      // line never has to guard for a missing field.
      counts: {
        pending: 0,
        approved: 0,
        rejected: 0,
        pendingByReason: { price_ratio: 0, verifier_unresolved: 0, taxonomy: 0 },
      },
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

  // Issue #628: the reason is a REQUEST argument and part of the cache key.
  it('sends the reason and keys the cache by it; omitted reason = every reason', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.mocked(getReviewItems).mockResolvedValue(
      page([reviewItem('a')], { pending: 1, approved: 0, rejected: 0 }, 1)
    )

    const { result } = renderHook(() => useReviewItems('pending', 'taxonomy'), {
      wrapper: createWrapper(queryClient),
    })
    await waitFor(() => expect(result.current.data.items).toHaveLength(1))
    expect(getReviewItems).toHaveBeenCalledWith(
      { status: 'pending', reason: 'taxonomy', limit: 50, offset: 0 },
      expect.anything()
    )

    // The unfiltered view is a separate cache entry, not a reuse of the
    // filtered one — otherwise switching back would show taxonomy pages.
    renderHook(() => useReviewItems('pending'), { wrapper: createWrapper(queryClient) })
    await waitFor(() =>
      expect(getReviewItems).toHaveBeenCalledWith(
        { status: 'pending', reason: undefined, limit: 50, offset: 0 },
        expect.anything()
      )
    )
    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey)
    expect(keys).toContainEqual(['review', 'pending', 'taxonomy'])
    expect(keys).toContainEqual(['review', 'pending', null])
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

  it('forwards the agreement and marks the optimistic row ai_assist', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    queryClient.setQueryData(
      ['review', 'all'],
      infiniteData([page([reviewItem('rev-1')], { pending: 1, approved: 0, rejected: 0 }, 1)])
    )
    let resolveRequest
    vi.mocked(decideReviewItem).mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve
      })
    )
    const { result } = renderHook(() => useDecideReview(), {
      wrapper: createWrapper(queryClient),
    })
    result.current.mutate({ id: 'rev-1', decision: 'approved', agreement: 'agreed' })

    await waitFor(() => {
      const row = queryClient.getQueryData(['review', 'all']).pages[0].items[0]
      expect(row.status).toBe('approved')
      expect(row.decidedSource).toBe('ai_assist')
    })
    expect(decideReviewItem).toHaveBeenCalledWith('rev-1', 'approved', 'agreed')

    resolveRequest({ item: reviewItem('rev-1', 'approved') })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  it('marks a plain decision human and sends no agreement', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    queryClient.setQueryData(
      ['review', 'all'],
      infiniteData([page([reviewItem('rev-1')], { pending: 1, approved: 0, rejected: 0 }, 1)])
    )
    vi.mocked(decideReviewItem).mockResolvedValue({ item: reviewItem('rev-1', 'rejected') })
    const { result } = renderHook(() => useDecideReview(), {
      wrapper: createWrapper(queryClient),
    })
    result.current.mutate({ id: 'rev-1', decision: 'rejected' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(decideReviewItem).toHaveBeenCalledWith('rev-1', 'rejected', undefined)
    const row = queryClient.getQueryData(['review', 'all']).pages[0].items[0]
    expect(row.status).toBe('rejected')
    expect(row.decidedSource).toBe('human')
  })

  // M2 (audit): the optimistic write used to move the row only — the header
  // painted counts and filteredTotal from the same cache, so the pending
  // badge contradicted the visible rows until the settle refetch, and
  // `decidedBy: null` blanked the actor chip. These assertions run on the
  // OPTIMISTIC FRAME (the decision promise is held open) — they fail on the
  // base implementation, which only flips the row.
  describe('optimistic frame patches the derived slices (M2/L6)', () => {
    const COUNTS = {
      pending: 2,
      approved: 1,
      rejected: 0,
      pendingByReason: { price_ratio: 2, verifier_unresolved: 0, taxonomy: 0 },
    }
    const FLAGGED = { ...reviewItem('rev-1'), reason: 'price_ratio' }

    function seedSlices(queryClient) {
      queryClient.setQueryData(
        ['review', 'pending', null],
        infiniteData([page([FLAGGED, reviewItem('rev-2')], COUNTS, 2)])
      )
      // The approved list does not contain the row yet, but its badge reads
      // the same whole-queue counts and its filteredTotal grows by one when
      // the row enters it.
      queryClient.setQueryData(
        ['review', 'approved', null],
        infiniteData([page([reviewItem('rev-3', 'approved')], COUNTS, 1)])
      )
      // The caller's identity, for the actor stamp.
      queryClient.setQueryData(['me'], { user: { id: 'user-9' } })
    }

    it('moves counts, pendingByReason, filteredTotal and stamps the caller on the optimistic frame', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })
      seedSlices(queryClient)
      let resolveRequest
      vi.mocked(decideReviewItem).mockReturnValue(
        new Promise((resolve) => {
          resolveRequest = resolve
        })
      )
      const { result } = renderHook(() => useDecideReview(), {
        wrapper: createWrapper(queryClient),
      })
      result.current.mutate({ id: 'rev-1', decision: 'approved' })

      await waitFor(() => {
        const pending = queryClient.getQueryData(['review', 'pending', null])
        const first = pending.pages[0]
        expect(first.items.find((item) => item.id === 'rev-1').status).toBe('approved')
        // counts[from]--, counts[to]++ ...
        expect(first.counts.pending).toBe(1)
        expect(first.counts.approved).toBe(2)
        expect(first.counts.pendingByReason.price_ratio).toBe(1)
        expect(first.filteredTotal).toBe(1)
        // ... the actor is the CALLER, not null.
        const row = first.items.find((item) => item.id === 'rev-1')
        expect(row.decidedBy).toBe('user-9')
        expect(row.decidedSource).toBe('human')
        expect(row.decidedAt).not.toBeNull()
      })
      // The entry whose list the row ENTERS gains the row in its total —
      // even though the row itself is not (yet) among its items.
      const approved = queryClient.getQueryData(['review', 'approved', null])
      expect(approved.pages[0].filteredTotal).toBe(2)
      expect(approved.pages[0].counts.pending).toBe(1)
      expect(approved.pages[0].counts.approved).toBe(2)

      resolveRequest({ item: reviewItem('rev-1', 'approved') })
      await waitFor(() => expect(result.current.isSuccess).toBe(true))
    })

    it('undo restores the counts and clears the actor', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })
      seedSlices(queryClient)
      // Start from the post-decide shape: the row decided. The seeded counts
      // must be internally consistent — pending 1 means the price_ratio split
      // moved down with it.
      const decidedCounts = {
        ...COUNTS,
        pending: 1,
        approved: 2,
        pendingByReason: { ...COUNTS.pendingByReason, price_ratio: 1 },
      }
      queryClient.setQueryData(
        ['review', 'pending', null],
        infiniteData([
          page(
            [{ ...FLAGGED, status: 'approved', decidedBy: 'user-9' }, reviewItem('rev-2')],
            decidedCounts,
            1
          ),
        ])
      )
      vi.mocked(undoReviewDecision).mockResolvedValue({ item: reviewItem('rev-1') })
      const { result } = renderHook(() => useUndoReview(), {
        wrapper: createWrapper(queryClient),
      })
      result.current.mutate({ id: 'rev-1' })

      await waitFor(() => {
        const pending = queryClient.getQueryData(['review', 'pending', null])
        const first = pending.pages[0]
        const row = first.items.find((item) => item.id === 'rev-1')
        expect(row.status).toBe('pending')
        expect(first.counts.pending).toBe(2)
        expect(first.counts.approved).toBe(1)
        expect(first.counts.pendingByReason.price_ratio).toBe(2)
        expect(first.filteredTotal).toBe(2)
        expect(row.decidedBy).toBeNull()
        expect(row.decidedSource).toBeNull()
        expect(row.decidedAt).toBeNull()
      })
    })

    it('rolls the derived slices back with the row when the decide fails', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })
      seedSlices(queryClient)
      vi.mocked(decideReviewItem).mockRejectedValue(new Error('boom'))
      const { result } = renderHook(() => useDecideReview(), {
        wrapper: createWrapper(queryClient),
      })
      result.current.mutate({ id: 'rev-1', decision: 'approved' })

      await waitFor(() => expect(result.current.isError).toBe(true))
      const pending = queryClient.getQueryData(['review', 'pending', null])
      const first = pending.pages[0]
      expect(first.items.find((item) => item.id === 'rev-1').status).toBe('pending')
      expect(first.counts.pending).toBe(2)
      expect(first.counts.approved).toBe(1)
      expect(first.counts.pendingByReason.price_ratio).toBe(2)
      expect(first.filteredTotal).toBe(2)
    })

    // review A2: a double-click inside the optimistic window re-fires the
    // same decision while the cache already reads nextStatus — the derived
    // slices must not move again, or filteredTotal double-decrements until
    // the settle refetch.
    it('a re-fired identical decision does not double-move the derived slices', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })
      seedSlices(queryClient)
      let resolveRequest
      vi.mocked(decideReviewItem).mockReturnValue(
        new Promise((resolve) => {
          resolveRequest = resolve
        })
      )
      const { result } = renderHook(() => useDecideReview(), {
        wrapper: createWrapper(queryClient),
      })
      result.current.mutate({ id: 'rev-1', decision: 'approved' })
      await waitFor(() => {
        const pending = queryClient.getQueryData(['review', 'pending', null])
        expect(pending.pages[0].counts.pending).toBe(1)
      })

      // The row now reads approved in the cache; the second, identical
      // mutate is a no-op on every derived slice.
      result.current.mutate({ id: 'rev-1', decision: 'approved' })
      await act(async () => {})

      const pending = queryClient.getQueryData(['review', 'pending', null])
      const first = pending.pages[0]
      expect(first.items.find((item) => item.id === 'rev-1').status).toBe('approved')
      expect(first.counts.pending).toBe(1)
      expect(first.counts.approved).toBe(2)
      expect(first.counts.pendingByReason.price_ratio).toBe(1)
      expect(first.filteredTotal).toBe(1)
      const approved = queryClient.getQueryData(['review', 'approved', null])
      expect(approved.pages[0].filteredTotal).toBe(2)

      resolveRequest({ item: reviewItem('rev-1', 'approved') })
      await waitFor(() => expect(result.current.isSuccess).toBe(true))
    })
  })
})

describe('AI review mode and evaluation (issue #484)', () => {
  beforeEach(() => {
    vi.mocked(getReviewMode).mockReset()
    vi.mocked(setReviewMode).mockReset()
    vi.mocked(evaluateReviewItems).mockReset()
  })

  it('loads the persisted mode and the provider-configured flag', async () => {
    vi.mocked(getReviewMode).mockResolvedValue({ mode: 'auto', aiConfigured: true })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useReviewMode(), {
      wrapper: createWrapper(queryClient),
    })
    await waitFor(() => expect(result.current.data).toEqual({ mode: 'auto', aiConfigured: true }))
    expect(getReviewMode).toHaveBeenCalledTimes(1)
  })

  it('does not fetch the mode when the surface is disabled', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderHook(() => useReviewMode({ enabled: false }), {
      wrapper: createWrapper(queryClient),
    })
    expect(getReviewMode).not.toHaveBeenCalled()
  })

  it('persists a mode switch, seeds the cache, and invalidates the queue', async () => {
    vi.mocked(setReviewMode).mockResolvedValue({ mode: 'auto', aiConfigured: true })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useSetReviewMode(), {
      wrapper: createWrapper(queryClient),
    })
    result.current.mutate('auto')

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(setReviewMode).toHaveBeenCalledWith('auto')
    expect(queryClient.getQueryData(REVIEW_MODE_KEY)).toEqual({
      mode: 'auto',
      aiConfigured: true,
    })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['review'] })
  })

  it('evaluates the requested window and invalidates the queue on settle', async () => {
    vi.mocked(evaluateReviewItems).mockResolvedValue({
      evaluated: 5,
      applied: 0,
      mode: 'assist',
      aiConfigured: true,
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useEvaluateReview(), {
      wrapper: createWrapper(queryClient),
    })
    result.current.mutate(10)

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(evaluateReviewItems).toHaveBeenCalledWith(10)
    // The settle invalidation is what refetches the queue with the new
    // verdicts (and, in auto mode, the decisions the sweep applied).
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['review'] })
  })
})

describe('useAcknowledgeTaxonomy (issue #626)', () => {
  beforeEach(() => {
    vi.mocked(acknowledgeTaxonomy).mockReset()
  })

  // Regression for the shipped bug: the hook called acknowledgeTaxonomy()
  // WITHOUT importing it — a ReferenceError inside the mutationFn surfaced as
  // "Acknowledge failed" in the UI with no request ever reaching the server
  // (devtools: no network entry). TaxonomyAckPanel.test.jsx mocks this module
  // wholesale, so only a test that loads the REAL module executes the wiring.
  it('calls the acknowledge endpoint and surfaces the counts', async () => {
    vi.mocked(acknowledgeTaxonomy).mockResolvedValue({ acknowledged: 2, remaining: 0 })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const { result } = renderHook(() => useAcknowledgeTaxonomy(), {
      wrapper: createWrapper(queryClient),
    })
    result.current.mutate()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(acknowledgeTaxonomy).toHaveBeenCalledTimes(1)
    expect(result.current.data).toEqual({ acknowledged: 2, remaining: 0 })
  })

  it('invalidates every review query on success — no optimistic write', async () => {
    vi.mocked(acknowledgeTaxonomy).mockResolvedValue({ acknowledged: 622, remaining: 0 })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    queryClient.setQueryData(
      ['review', 'pending', null],
      infiniteData([page([reviewItem('rev-1')], { pending: 1, approved: 0, rejected: 0 }, 1)])
    )
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useAcknowledgeTaxonomy(), {
      wrapper: createWrapper(queryClient),
    })
    result.current.mutate()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['review'] })
    // The row is untouched locally: the ack flips hundreds of rows server-side,
    // and the response's acknowledged/remaining belongs to a refetch, not a
    // guess — the cached page must still carry the pre-ack snapshot.
    const row = queryClient
      .getQueryData(['review', 'pending', null])
      .pages[0].items.find((item) => item.id === 'rev-1')
    expect(row.status).toBe('pending')
  })
})
