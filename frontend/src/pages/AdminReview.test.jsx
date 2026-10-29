import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { AdminReview } from './AdminReview.jsx'

vi.mock('../lib/queries/me.js', () => ({
  useMe: vi.fn(),
}))

vi.mock('../lib/queries/index.js', () => ({
  usePriceSources: vi.fn(),
}))

vi.mock('../lib/queries/review.js', () => ({
  useReviewItems: vi.fn(),
  useDecideReview: vi.fn(),
  useUndoReview: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  fetchReviewExport: vi.fn(),
}))

import { useMe } from '../lib/queries/me.js'
import { usePriceSources } from '../lib/queries/index.js'
import { useReviewItems, useDecideReview, useUndoReview } from '../lib/queries/review.js'
import { fetchReviewExport } from '../lib/api'

const decideMutate = vi.fn()
const undoMutate = vi.fn()
const fetchNextPage = vi.fn()

const reviewItem = {
  id: 'rev-1',
  itemProductKey: 'beras-ramos-5kg----5-kg',
  itemName: 'Beras Ramos 5 kg',
  itemBrand: null,
  itemUnit: '5 kg',
  itemPrice: 89000,
  itemEffectiveUnitPrice: 89000,
  itemStore: 'lotte-mart',
  entryProductKey: 'beras-ramos-5kg--ramos--5-kg',
  entryName: 'Beras Ramos 5kg',
  entryBrand: 'Ramos',
  entryUnit: '5 kg',
  entryPrice: 27000,
  entryEffectiveUnitPrice: 27000,
  entryStore: 'superindo',
  matchMethod: 'exact',
  confidence: 1,
  reason: 'price_ratio',
  status: 'pending',
  decidedAt: null,
  decidedBy: null,
  flagCount: 2,
  firstFlaggedAt: '2026-10-28T23:00:05Z',
  lastFlaggedAt: '2026-10-28T23:00:05Z',
  runStartedAt: '2026-10-28T23:00:05Z',
  runId: 'run-uuid-1',
}

function mockReviewData(dataOverrides = {}, hookOverrides = {}) {
  return {
    data: {
      items: [reviewItem],
      counts: { pending: 3, approved: 1, rejected: 2 },
      filteredTotal: 3,
      ...dataOverrides,
    },
    hasNextPage: false,
    fetchNextPage,
    isFetchingNextPage: false,
    isLoading: false,
    isError: false,
    ...hookOverrides,
  }
}

function renderAdmin() {
  return render(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      React.createElement(AdminReview, null)
    )
  )
}

// The suite's i18n mock returns raw keys, so assertions match keys.
describe('AdminReview', () => {
  // This project runs without vitest globals, so RTL cannot auto-register
  // its afterEach cleanup — un-cleaned renders would leak into later
  // getByText calls in this file.
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useMe).mockReturnValue({ data: { user: { isAdmin: true } } })
    vi.mocked(usePriceSources).mockReturnValue({
      data: [
        { slug: 'lotte-mart', name: 'Lotte Mart' },
        { slug: 'superindo', name: 'Superindo' },
      ],
    })
    vi.mocked(useReviewItems).mockImplementation(() => {
      const value = mockReviewData()
      console.log('IMPL-RET', JSON.stringify(value).slice(0, 90))
      return value
    })
    vi.mocked(useDecideReview).mockReturnValue({ mutate: decideMutate, isPending: false })
    vi.mocked(useUndoReview).mockReturnValue({ mutate: undoMutate, isPending: false })
  })

  it('shows the forbidden state for non-admins', () => {
    vi.mocked(useMe).mockReturnValue({ data: { user: { isAdmin: false } } })
    const { container } = renderAdmin()
    expect(container.textContent).toContain('monitor.forbidden')
    expect(container.textContent).not.toContain('review.matchedItem')
  })

  it('renders the lead, the decisions note, and the exact count badges', () => {
    const { container } = renderAdmin()
    expect(container.textContent).toContain('review.lead')
    expect(container.textContent).toContain('review.decisionsNote')
    expect(container.textContent).toContain('review.pending')
    expect(container.textContent).toContain('3')
    expect(container.textContent).toContain('review.approved')
    expect(container.textContent).toContain('review.rejected')
  })

  it('defaults the filter to pending and switches on click', () => {
    const { container } = renderAdmin()
    const pressed = container.querySelector('[aria-pressed="true"]')
    expect(pressed.textContent).toBe('review.pending')

    // Four filter chips: pending, approved, rejected, all.
    const chips = [...container.querySelectorAll('[aria-pressed]')]
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'review.pending',
      'review.approved',
      'review.rejected',
      'review.all',
    ])

    fireEvent.click(chips[3])
    expect(chips[3].getAttribute('aria-pressed')).toBe('true')
  })

  it('renders the side-by-side pair with honest labels and store display names', () => {
    const { container } = renderAdmin()
    expect(container.textContent).toContain('review.matchedItem')
    expect(container.textContent).toContain('review.catalogEntry')
    expect(container.textContent).toContain('Beras Ramos 5 kg')
    expect(container.textContent).toContain('Beras Ramos 5kg')
    // Null brand/unit render as an em dash, never an empty string.
    expect(container.textContent).toContain('— · 5 kg')
    // Slugs resolve via the source-name convention.
    expect(container.textContent).toContain('Lotte Mart')
    expect(container.textContent).toContain('Superindo')
    expect(container.textContent).toContain('review.reasonPriceRatio')
    expect(container.textContent).toContain('review.methodExact')
    expect(container.textContent).toContain('review.flagCount')
  })

  it('links a decided row back to the monitor run detail', () => {
    const { container } = renderAdmin()
    const link = [...container.querySelectorAll('a')].find((a) =>
      a.getAttribute('href')?.includes('run=')
    )
    expect(link.getAttribute('href')).toBe('/admin/prices?run=run-uuid-1')
    expect(link.textContent).toContain('review.runDetail')
  })

  it('offers Approve/Reject on a pending row and fires the decide mutation', () => {
    const { container, getByText } = renderAdmin()
    expect(container.textContent).not.toContain('review.undo')
    fireEvent.click(getByText('review.approve'))
    expect(decideMutate).toHaveBeenCalledWith({ id: 'rev-1', decision: 'approved' })
    fireEvent.click(getByText('review.reject'))
    expect(decideMutate).toHaveBeenCalledWith({ id: 'rev-1', decision: 'rejected' })
  })

  it('shows the verdict line with Undo on a decided row', () => {
    vi.mocked(useReviewItems).mockReturnValue(
      mockReviewData({ items: [{ ...reviewItem, status: 'approved' }] })
    )
    const { container, getByText } = renderAdmin()
    expect(container.textContent).toContain('review.approved')
    fireEvent.click(getByText('review.undo'))
    expect(undoMutate).toHaveBeenCalledWith({ id: 'rev-1' })
  })

  it('shows the showing line and appends the next page with Load more', () => {
    vi.mocked(useReviewItems).mockReturnValue(
      mockReviewData({ filteredTotal: 53 }, { hasNextPage: true })
    )
    const { container, getByText } = renderAdmin()
    expect(container.textContent).toContain('review.showing')
    fireEvent.click(getByText('review.loadMore'))
    expect(fetchNextPage).toHaveBeenCalled()
  })

  it('renders the empty state when the queue has zero items overall', () => {
    vi.mocked(useReviewItems).mockReturnValue(
      mockReviewData({
        items: [],
        counts: { pending: 0, approved: 0, rejected: 0 },
        filteredTotal: 0,
      })
    )
    const { container } = renderAdmin()
    expect(container.textContent).toContain('review.empty')
    expect(container.textContent).toContain('review.emptyDesc')
    expect(container.textContent).not.toContain('review.noneFiltered')
  })

  it('renders the lighter filtered-empty line when only the filter has no matches', () => {
    vi.mocked(useReviewItems).mockReturnValue(mockReviewData({ items: [], filteredTotal: 0 }))
    const { container } = renderAdmin()
    expect(container.textContent).toContain('review.noneFiltered')
    expect(container.textContent).not.toContain('review.empty')
  })

  it('downloads the decisions export through the same-origin blob fetch', async () => {
    const revokeObjectURL = vi.fn()
    URL.createObjectURL = vi.fn(() => 'blob:mock')
    URL.revokeObjectURL = revokeObjectURL
    vi.mocked(fetchReviewExport).mockResolvedValue(new Blob(['{}']))
    const { getByText } = renderAdmin()
    fireEvent.click(getByText('review.export'))
    await waitFor(() => expect(fetchReviewExport).toHaveBeenCalled())
    expect(URL.createObjectURL).toHaveBeenCalled()
  })
})
