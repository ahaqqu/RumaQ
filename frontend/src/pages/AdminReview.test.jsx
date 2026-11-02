import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent, waitFor } from '@testing-library/react'
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

  describe('per-side evidence blocks (issue #380)', () => {
    const itemWithEvidence = {
      ...reviewItem,
      // LEFT: the R2 page image + the retailer campaign page.
      itemBrochureUrl: '/api/brochures/lotte-mart/20261028/page-1.jpg',
      itemSourceUrl: 'https://www.lottemart.co.id/koran-promo/',
      // RIGHT: what the catalog entry's last observation carried.
      entryBrochureUrl: '/api/brochures/superindo/20261028/page-3.jpg',
      entrySourceUrl: 'https://www.superindo.co.id/promosi/katalog-super-hemat/',
      entryObservedAt: '2026-10-28',
    }

    it('renders the page image thumbnails and the retailer page links on both sides', () => {
      vi.mocked(useReviewItems).mockReturnValue(mockReviewData({ items: [itemWithEvidence] }))
      const { container } = renderAdmin()
      const images = [...container.querySelectorAll('img')]
      expect(images.map((img) => img.getAttribute('src'))).toEqual([
        '/api/brochures/lotte-mart/20261028/page-1.jpg',
        '/api/brochures/superindo/20261028/page-3.jpg',
      ])
      // Lazy thumbnails, opening the full image (same-origin proxy) in a new tab.
      for (const img of images) expect(img.getAttribute('loading')).toBe('lazy')
      for (const img of images) {
        const thumb = img.closest('a')
        expect(thumb.getAttribute('target')).toBe('_blank')
        expect(thumb.getAttribute('href')).toBe(img.getAttribute('src'))
      }
      const links = container.querySelectorAll('a[href^="https://"]')
      expect([...links].map((a) => a.getAttribute('href'))).toEqual([
        'https://www.lottemart.co.id/koran-promo/',
        'https://www.superindo.co.id/promosi/katalog-super-hemat/',
      ])
      expect(container.textContent).toContain('review.evidenceOpenSource')
    })

    it('shows "last seen" with the observed date on the RIGHT side only', () => {
      vi.mocked(useReviewItems).mockReturnValue(mockReviewData({ items: [itemWithEvidence] }))
      const { container } = renderAdmin()
      expect(container.textContent).toContain('review.evidenceLastSeen')
      expect(container.textContent.match(/review\.evidenceLastSeen/g) ?? []).toHaveLength(1)
    })

    it('renders the muted catalog-source empty state and no links when evidence is null (old rows)', () => {
      // The base fixture predates the fields — every evidence slot is null.
      const { container } = renderAdmin()
      const empties = container.textContent.match(/review\.evidenceNoImage/g) ?? []
      expect(empties.length).toBe(2) // both sides
      expect(container.querySelector('img')).toBeNull()
      expect(container.textContent).not.toContain('review.evidenceOpenSource')
      expect(container.textContent).not.toContain('review.evidenceLastSeen')
    })

    it('treats a stored catalog page URL as no page image — the source link still shows', () => {
      vi.mocked(useReviewItems).mockReturnValue(
        mockReviewData({
          items: [
            {
              ...reviewItem,
              // Old catalog rows: brochure_url IS the listing page, never an
              // <img>; source_url did not exist yet.
              entryBrochureUrl: 'https://www.astro.co.id/katalog',
              entrySourceUrl: null,
            },
          ],
        })
      )
      const { container } = renderAdmin()
      expect(container.querySelector('img')).toBeNull()
      expect(container.textContent).toContain('review.evidenceNoImage')
    })

    it('never renders a non-http(s) sourceUrl as a link', () => {
      vi.mocked(useReviewItems).mockReturnValue(
        mockReviewData({
          items: [{ ...reviewItem, itemSourceUrl: 'javascript:alert(1)' }],
        })
      )
      const { container } = renderAdmin()
      expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
    })

    it('retries the image when the row gains a different URL after a failure (thermos A1)', () => {
      // The decide/undo refetch can swap a row's entryBrochureUrl under the
      // same mounted component — the old failure must not pin the fallback.
      const stale = {
        ...reviewItem,
        entryBrochureUrl: '/api/brochures/superindo/20261028/page-3.jpg',
      }
      vi.mocked(useReviewItems).mockReturnValue(mockReviewData({ items: [stale] }))
      const { container, rerender } = renderAdmin()
      fireEvent.error(container.querySelector('img'))
      expect(container.querySelector('img')).toBeNull()
      expect(container.textContent).toContain('review.evidenceNoImage')

      // A newer observation lands; the same mounted row now carries a fresh
      // URL — the thumbnail must be retried, not inherit the old failure.
      const refreshed = {
        ...stale,
        entryBrochureUrl: '/api/brochures/superindo/20261030/page-1.jpg',
      }
      vi.mocked(useReviewItems).mockReturnValue(mockReviewData({ items: [refreshed] }))
      rerender(
        React.createElement(
          QueryClientProvider,
          { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          React.createElement(AdminReview, null)
        )
      )
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        '/api/brochures/superindo/20261030/page-1.jpg'
      )
    })
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

  it('surfaces an inline error when the export fails, and clears it on retry (thermos A3)', async () => {
    vi.mocked(fetchReviewExport)
      .mockRejectedValueOnce(new Error('Export failed: 401'))
      .mockResolvedValueOnce(new Blob(['{}']))
    URL.createObjectURL = vi.fn(() => 'blob:mock')
    URL.revokeObjectURL = vi.fn()
    const { container, getByText } = renderAdmin()
    fireEvent.click(getByText('review.export'))
    // The failure must be visible — a silent no-op button is the A3 bug.
    await waitFor(() => expect(container.textContent).toContain('review.exportFailed'))
    fireEvent.click(getByText('review.export'))
    await waitFor(() => expect(container.textContent).not.toContain('review.exportFailed'))
  })
})
