import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test'
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
  useReviewMode: vi.fn(),
  useSetReviewMode: vi.fn(),
  useEvaluateReview: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchReviewExport: vi.fn(),
}))

vi.mock('../lib/queries/products.js', () => ({
  useProductIdentity: vi.fn(),
  useRenameProduct: vi.fn(),
  useRevertRename: vi.fn(),
  useDecideAlias: vi.fn(),
}))

import { useMe } from '../lib/queries/me.js'
import { usePriceSources } from '../lib/queries/index.js'
import {
  useReviewItems,
  useDecideReview,
  useUndoReview,
  useReviewMode,
  useSetReviewMode,
  useEvaluateReview,
} from '../lib/queries/review.js'
import {
  useProductIdentity,
  useRenameProduct,
  useRevertRename,
  useDecideAlias,
} from '../lib/queries/products.js'
import { fetchReviewExport } from '../lib/api'

const decideMutate = vi.fn()
const undoMutate = vi.fn()
const fetchNextPage = vi.fn()
const setModeMutate = vi.fn()
const evaluateMutate = vi.fn()

const reviewItem = {
  id: '31b35444-4c2b-4b8e-9a4f-0d2c6e7f8a90',
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
      counts: {
        pending: 3,
        approved: 1,
        rejected: 2,
        // Issue #628: the exact pending split by flag reason.
        pendingByReason: { price_ratio: 2, verifier_unresolved: 1, taxonomy: 0 },
      },
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

// Each SideCard is a role="group" named by its header label (#480).
function sideGroups(container) {
  return [...container.querySelectorAll('[role="group"][aria-labelledby]')]
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
    vi.mocked(useReviewItems).mockReturnValue(mockReviewData())
    vi.mocked(useDecideReview).mockReturnValue({ mutate: decideMutate, isPending: false })
    vi.mocked(useUndoReview).mockReturnValue({ mutate: undoMutate, isPending: false })
    // Issue #484 defaults: AI is on, mode is the backend default (assist).
    vi.mocked(useReviewMode).mockReturnValue({
      data: { mode: 'assist', aiConfigured: true },
      isLoading: false,
      isError: false,
    })
    vi.mocked(useSetReviewMode).mockReturnValue({
      mutate: setModeMutate,
      isPending: false,
      isError: false,
    })
    vi.mocked(useEvaluateReview).mockReturnValue({
      mutate: evaluateMutate,
      isPending: false,
      isError: false,
    })
    vi.mocked(useProductIdentity).mockReturnValue({
      data: {
        product: {
          productKey: reviewItem.entryProductKey,
          name: reviewItem.entryName,
          brand: reviewItem.entryBrand,
          unit: reviewItem.entryUnit,
          status: 'provisional',
          metadataVersion: 3,
        },
        // A candidate alias makes the shared form's admin-only decision
        // actions observable here (#489): the page's isAdmin must reach them.
        aliases: [
          {
            id: 'alias-candidate',
            name: 'Beras Ramos 5 kg',
            storeSlug: 'lotte-mart',
            status: 'candidate',
            source: 'ocr',
            firstSeenAt: '2026-10-25T00:00:00Z',
            lastSeenAt: '2026-10-28T00:00:00Z',
          },
        ],
        stats: { observations: 7, stores: 2 },
        audit: [],
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    vi.mocked(useRenameProduct).mockReturnValue({ mutate: vi.fn(), isPending: false })
    vi.mocked(useRevertRename).mockReturnValue({ mutate: vi.fn(), isPending: false })
    vi.mocked(useDecideAlias).mockReturnValue({ mutate: vi.fn(), isPending: false })
  })

  it('shows the forbidden state for non-admins', () => {
    vi.mocked(useMe).mockReturnValue({ data: { user: { isAdmin: false } } })
    const { container } = renderAdmin()
    expect(container.textContent).toContain('monitor.forbidden')
    expect(container.textContent).not.toContain('review.matchedItem')
  })

  it('renders the lead, the why-review line, the decision rubric, and the exact count badges', () => {
    const { container } = renderAdmin()
    expect(container.textContent).toContain('review.lead')
    expect(container.textContent).toContain('review.whyReview')
    expect(container.textContent).toContain('review.decisionsNote')
    expect(container.textContent).toContain('review.decisionRubric')
    expect(container.textContent).toContain('review.pending')
    expect(container.textContent).toContain('3')
    expect(container.textContent).toContain('review.approved')
    expect(container.textContent).toContain('review.rejected')
  })

  it('defaults the status filter to pending and switches on click', () => {
    const { container } = renderAdmin()
    const statusGroup = container.querySelector('[role="group"][aria-label="review.lead"]')
    const chips = [...statusGroup.querySelectorAll('[aria-pressed]')]
    // Four status filter chips: pending, approved, rejected, all.
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'review.pending',
      'review.approved',
      'review.rejected',
      'review.all',
    ])
    expect(chips[0].getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(chips[3])
    expect(chips[3].getAttribute('aria-pressed')).toBe('true')
    expect(useReviewItems).toHaveBeenLastCalledWith('all', null)
  })

  // Issue #628: the pending total shows its per-reason split, and the reason
  // filter re-asks the server with the reason while the counts stay exact.
  it('renders the pending split and filters the list by reason', () => {
    const { container } = renderAdmin()
    // One split line: Pending 3 — price 2 · verifier 1 · taxonomy 0.
    expect(container.textContent).toContain('review.pendingByReason')
    expect(container.textContent).toContain('review.approved 1')
    expect(container.textContent).toContain('review.rejected 2')

    const reasonGroup = container.querySelector('[role="group"][aria-label="review.filterReason"]')
    const reasonChips = [...reasonGroup.querySelectorAll('[aria-pressed]')]
    expect(reasonChips.map((chip) => chip.textContent)).toEqual([
      'review.all',
      'review.reasonPriceRatio',
      'review.reasonVerifierUnresolved',
      'review.reasonTaxonomy',
    ])
    // "All" is the default: the unfiltered request.
    expect(reasonChips[0].getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(reasonChips[3])
    expect(reasonChips[3].getAttribute('aria-pressed')).toBe('true')
    expect(useReviewItems).toHaveBeenLastCalledWith('pending', 'taxonomy')

    // The counts are whole-queue server reads: the filter never distorts them.
    expect(container.textContent).toContain('review.pending 3')
    expect(container.textContent).toContain('review.approved 1')
    expect(container.textContent).toContain('review.rejected 2')
  })

  it('falls back to a zero split for a Worker without pendingByReason', () => {
    vi.mocked(useReviewItems).mockReturnValue(
      mockReviewData({ counts: { pending: 3, approved: 1, rejected: 2 } })
    )
    const { container } = renderAdmin()
    expect(container.textContent).toContain('review.pendingByReason')
    expect(container.textContent).toContain('review.pending 3')
  })

  it('renders the side-by-side pair with honest labels and store display names', () => {
    const { container } = renderAdmin()
    const sides = sideGroups(container)
    expect(container.textContent).toContain('review.matchedItem')
    expect(container.textContent).toContain('review.catalogEntry')
    expect(container.textContent).toContain('Beras Ramos 5 kg')
    expect(container.textContent).toContain('Beras Ramos 5kg')
    // #480: one brand/unit value renders alone (no dash placeholder); both
    // keep the brand · unit pair.
    expect(sides[0].children[1].textContent).toBe('5 kg')
    expect(sides[1].children[1].textContent).toBe('Ramos · 5 kg')
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
    expect(decideMutate).toHaveBeenCalledWith({ id: reviewItem.id, decision: 'approved' })
    fireEvent.click(getByText('review.reject'))
    expect(decideMutate).toHaveBeenCalledWith({ id: reviewItem.id, decision: 'rejected' })
  })

  it('shows the verdict line with Undo on a decided row', () => {
    vi.mocked(useReviewItems).mockReturnValue(
      mockReviewData({ items: [{ ...reviewItem, status: 'approved' }] })
    )
    const { container, getByText } = renderAdmin()
    expect(container.textContent).toContain('review.approved')
    fireEvent.click(getByText('review.undo'))
    expect(undoMutate).toHaveBeenCalledWith({ id: reviewItem.id })
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

  describe('issue #480 — reference id, one side-label header, brand/unit line', () => {
    afterEach(() => {
      // The copy test installs a fake clipboard; never leak it into the next test.
      delete navigator.clipboard
    })

    it('shows the short reference id with the full UUID in the title', () => {
      const { container } = renderAdmin()
      const idButton = container.querySelector(`button[title="${reviewItem.id}"]`)
      expect(idButton).not.toBeNull()
      expect(idButton.textContent).toBe('#31b35444')
      expect(idButton.className).toContain('font-mono')
      // Keyboard reachable: a real button, not a click-only span (thermos A2).
      expect(idButton.tagName).toBe('BUTTON')
      expect(idButton.getAttribute('type')).toBe('button')
      // The accessible name comes from i18n, not the bare fragment. Here the
      // suite's raw-key t() ignores interpolation; the real EN name (which
      // carries the visible short id, WCAG 2.5.3) is pinned in
      // AdminReview.i18n.test.jsx.
      expect(idButton.getAttribute('aria-label')).toBe('review.copyItemId')
    })

    it('copies the full UUID when the reference id is clicked', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
      const { container } = renderAdmin()
      fireEvent.click(container.querySelector(`button[title="${reviewItem.id}"]`))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(reviewItem.id))
    })

    it('stays silent when the clipboard API is unavailable', () => {
      // jsdom has no navigator.clipboard at all — the click must not throw.
      const { container } = renderAdmin()
      const idButton = container.querySelector(`button[title="${reviewItem.id}"]`)
      expect(() => fireEvent.click(idButton)).not.toThrow()
    })

    it('renders both side labels once, in the list header, even with several rows', () => {
      vi.mocked(useReviewItems).mockReturnValue(
        mockReviewData({
          items: [reviewItem, { ...reviewItem, id: 'aaaa1111-2222-4333-8444-555566667777' }],
        })
      )
      const { container } = renderAdmin()
      expect(container.textContent.match(/review\.matchedItem/g)).toHaveLength(1)
      expect(container.textContent.match(/review\.catalogEntry/g)).toHaveLength(1)
      // Every row's sides take their accessible name from the header labels.
      const sides = sideGroups(container)
      expect(sides).toHaveLength(4)
      const headerLabels = sides.map((side) => {
        const label = document.getElementById(side.getAttribute('aria-labelledby'))
        expect(label).not.toBeNull()
        return label.textContent
      })
      expect(headerLabels).toEqual([
        'review.matchedItem',
        'review.catalogEntry',
        'review.matchedItem',
        'review.catalogEntry',
      ])
    })

    it('renders one muted no-brand-unit line when both values are missing', () => {
      vi.mocked(useReviewItems).mockReturnValue(
        mockReviewData({
          items: [
            {
              ...reviewItem,
              itemBrand: null,
              itemUnit: null,
              entryBrand: null,
              entryUnit: null,
            },
          ],
        })
      )
      const { container } = renderAdmin()
      const [itemSide, entrySide] = sideGroups(container)
      // The brand/unit line is the side card's second child, right under the name.
      expect(itemSide.children[1].textContent).toBe('review.noBrandUnit')
      expect(entrySide.children[1].textContent).toBe('review.noBrandUnit')
      expect(container.textContent).not.toContain('— · —')
      expect(container.textContent).not.toContain('—')
    })

    it('names the confidence chip and labels the reason as the review flag', () => {
      const { container } = renderAdmin()
      const confidence = container.querySelector('[title="review.confidenceHint"]')
      expect(confidence).not.toBeNull()
      expect(confidence.textContent).toBe('review.confidence 100%')
      // The reason chip reads as the flag, not as a second verdict.
      expect(container.textContent).toContain('review.flagPrefix review.reasonPriceRatio')
    })

    it('renders a lone brand or unit without dash placeholders', () => {
      vi.mocked(useReviewItems).mockReturnValue(
        mockReviewData({
          items: [
            {
              ...reviewItem,
              itemBrand: null,
              itemUnit: '5 kg',
              entryBrand: 'Ramos',
              entryUnit: null,
            },
          ],
        })
      )
      const { container } = renderAdmin()
      const [itemSide, entrySide] = sideGroups(container)
      expect(itemSide.children[1].textContent).toBe('5 kg')
      expect(entrySide.children[1].textContent).toBe('Ramos')
      expect(container.textContent).not.toContain('—')
    })
  })

  describe('issue #423 — canonical rename action', () => {
    function renameToggle(container) {
      return [...container.querySelectorAll('button')].find((button) =>
        ['rename.action', 'rename.close'].includes(button.textContent)
      )
    }

    it('offers the rename action on the canonical entry side only', () => {
      const { container } = renderAdmin()
      const [itemSide, entrySide] = sideGroups(container)
      expect(renameToggle(itemSide)).toBeUndefined()
      const toggle = renameToggle(entrySide)
      expect(toggle).not.toBeUndefined()
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
    })

    it('opens the shared rename form for the entry product key with the frozen-label note', () => {
      const { container } = renderAdmin()
      fireEvent.click(renameToggle(container))
      expect(renameToggle(container).textContent).toBe('rename.close')
      expect(renameToggle(container).getAttribute('aria-expanded')).toBe('true')
      expect(useProductIdentity).toHaveBeenCalledWith(reviewItem.entryProductKey, {
        enabled: true,
      })
      expect(container.textContent).toContain('rename.frozenPairNote')
      expect(container.querySelector('[data-testid="product-rename-form"]')).not.toBeNull()
      // The form edits the canonical entry name; the pair's own label is frozen.
      expect(container.querySelector('[data-testid="rename-current-name"]').textContent).toBe(
        reviewItem.entryName
      )
      // #489: the page's admin flag reaches the shared form; without it the
      // candidate row would stay read-only for an admin.
      expect(
        [...container.querySelectorAll('button')].map((button) => button.textContent)
      ).toContain('rename.aliasApprove')
    })

    it('collapses the form again from the row action', () => {
      const { container } = renderAdmin()
      fireEvent.click(renameToggle(container))
      expect(container.querySelector('[data-testid="product-rename-form"]')).not.toBeNull()
      fireEvent.click(renameToggle(container))
      expect(container.querySelector('[data-testid="product-rename-form"]')).toBeNull()
      expect(container.textContent).not.toContain('rename.frozenPairNote')
    })

    it('shows no rename action to a non-admin', () => {
      // The page's admin gate returns the forbidden state before any row can
      // render, so this pins the surface's check (rows carry no gate of their
      // own — see the #423 review, B1).
      vi.mocked(useMe).mockReturnValue({ data: { user: { isAdmin: false } } })
      const { container } = renderAdmin()
      expect(container.textContent).not.toContain('rename.action')
      expect(container.textContent).not.toContain('rename.frozenPairNote')
      expect(useProductIdentity).not.toHaveBeenCalled()
    })
  })

  describe('issue #484 — AI review UI', () => {
    const VERDICT = {
      verdict: 'same',
      confidence: 0.87,
      reason: 'Both are the same brand and 5 kg pack.',
      model: 'gemini-2.5-flash',
      humanAgreement: null,
    }

    function modeData(data) {
      return { data, isLoading: false, isError: false }
    }

    function radios(container) {
      return [...container.querySelectorAll('input[name="review-ai-mode"]')]
    }

    it('renders the three modes, defaults to approve-with-AI, and persists a switch', () => {
      const { container } = renderAdmin()
      const inputs = radios(container)
      expect(inputs.map((input) => input.value)).toEqual(['manual', 'assist', 'auto'])
      // Every option carries its one-line explanation.
      expect(container.textContent).toContain('review.aiModeManual')
      expect(container.textContent).toContain('review.aiModeManualDesc')
      expect(container.textContent).toContain('review.aiModeAssist')
      expect(container.textContent).toContain('review.aiModeAssistDesc')
      expect(container.textContent).toContain('review.aiModeAuto')
      expect(container.textContent).toContain('review.aiModeAutoDesc')
      expect(inputs.filter((input) => input.checked).map((input) => input.value)).toEqual([
        'assist',
      ])

      fireEvent.click(inputs[2])
      expect(setModeMutate).toHaveBeenCalledWith('auto')
    })

    it('does not re-PUT the mode that is already selected', () => {
      const { container } = renderAdmin()
      fireEvent.click(radios(container)[1])
      expect(setModeMutate).not.toHaveBeenCalled()
    })

    it('disables the selector while the mode is saving', () => {
      vi.mocked(useSetReviewMode).mockReturnValue({
        mutate: setModeMutate,
        isPending: true,
        isError: false,
      })
      const { container } = renderAdmin()
      for (const input of radios(container)) expect(input.disabled).toBe(true)
      expect(container.textContent).toContain('review.aiModeSaving')
    })

    it('shows the unconfigured banner and makes no evaluate call', () => {
      vi.mocked(useReviewMode).mockReturnValue(modeData({ mode: 'assist', aiConfigured: false }))
      const { container } = renderAdmin()
      expect(container.textContent).toContain('review.aiNotConfigured')
      expect(evaluateMutate).not.toHaveBeenCalled()
      expect(container.textContent).not.toContain('review.aiEvaluateMore')
      // The selector stays usable — a missing key must not trap the admin.
      for (const input of radios(container)) expect(input.disabled).toBe(false)
    })

    it('surfaces a failed mode load with a retry instead of vanishing', () => {
      const refetch = vi.fn()
      vi.mocked(useReviewMode).mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
        refetch,
      })
      const { container, getByText } = renderAdmin()
      // Not silence: gating the whole block on `modeQuery.data` used to make a
      // failed GET /review/mode indistinguishable from a page with no AI
      // surface at all (thermos B1).
      expect(container.textContent).toContain('review.aiModeUnavailable')
      expect(container.textContent).not.toContain('review.aiModeLegend')
      // The retry the failure deserves, on the same inline surface the export
      // and rename failures use.
      fireEvent.click(getByText('review.aiModeRetry'))
      expect(refetch).toHaveBeenCalledTimes(1)
      // A mode failure never touches the queue itself.
      expect(container.textContent).toContain('review.approve')
      expect(container.textContent).toContain('review.reject')
    })

    it('renders the verdict chip, exposes the reason, and maps Agree to the verdict', () => {
      vi.mocked(useReviewItems).mockReturnValue(
        mockReviewData({ items: [{ ...reviewItem, aiVerdict: VERDICT }] })
      )
      const { container, getByText } = renderAdmin()
      expect(container.textContent).toContain('review.aiVerdict')
      expect(container.textContent).toContain('review.aiModel')
      // The reason is collapsed until asked for.
      expect(container.textContent).not.toContain(VERDICT.reason)
      fireEvent.click(getByText('review.aiReasonShow'))
      expect(container.textContent).toContain(VERDICT.reason)
      fireEvent.click(getByText('review.aiReasonHide'))
      expect(container.textContent).not.toContain(VERDICT.reason)

      fireEvent.click(getByText('review.aiAgree'))
      expect(decideMutate).toHaveBeenCalledWith({
        id: reviewItem.id,
        decision: 'approved',
        agreement: 'agreed',
      })
    })

    it('maps Disagree to the opposite decision with the disagreed agreement', () => {
      vi.mocked(useReviewItems).mockReturnValue(
        mockReviewData({ items: [{ ...reviewItem, aiVerdict: VERDICT }] })
      )
      const { getByText } = renderAdmin()
      fireEvent.click(getByText('review.aiDisagree'))
      expect(decideMutate).toHaveBeenCalledWith({
        id: reviewItem.id,
        decision: 'rejected',
        agreement: 'disagreed',
      })
    })

    it('maps a "different" verdict the other way round', () => {
      vi.mocked(useReviewItems).mockReturnValue(
        mockReviewData({
          items: [
            {
              ...reviewItem,
              aiVerdict: { ...VERDICT, verdict: 'different', confidence: 0.62 },
            },
          ],
        })
      )
      const { getByText } = renderAdmin()
      fireEvent.click(getByText('review.aiAgree'))
      expect(decideMutate).toHaveBeenCalledWith({
        id: reviewItem.id,
        decision: 'rejected',
        agreement: 'agreed',
      })
      fireEvent.click(getByText('review.aiDisagree'))
      expect(decideMutate).toHaveBeenCalledWith({
        id: reviewItem.id,
        decision: 'approved',
        agreement: 'disagreed',
      })
    })

    it('disables Agree/Disagree and shows progress while the decision saves', () => {
      vi.mocked(useReviewItems).mockReturnValue(
        mockReviewData({ items: [{ ...reviewItem, aiVerdict: VERDICT }] })
      )
      vi.mocked(useDecideReview).mockReturnValue({
        mutate: decideMutate,
        isPending: true,
        variables: { id: reviewItem.id, decision: 'approved', agreement: 'agreed' },
      })
      const { container, getByText } = renderAdmin()
      expect(getByText('review.aiAgree').disabled).toBe(true)
      expect(getByText('review.aiDisagree').disabled).toBe(true)
      expect(container.textContent).toContain('review.aiRecording')
    })

    it('auto mode hides Agree/Disagree and shows AI provenance for decided rows', () => {
      vi.mocked(useReviewMode).mockReturnValue(modeData({ mode: 'auto', aiConfigured: true }))
      vi.mocked(useReviewItems).mockReturnValue(
        mockReviewData({
          items: [
            { ...reviewItem, aiVerdict: VERDICT },
            {
              ...reviewItem,
              id: 'aaaa1111-2222-4333-8444-555566667777',
              status: 'approved',
              decidedSource: 'ai_auto',
            },
            {
              ...reviewItem,
              id: 'bbbb1111-2222-4333-8444-555566667777',
              status: 'rejected',
              decidedSource: 'ai_assist',
            },
            {
              ...reviewItem,
              id: 'cccc1111-2222-4333-8444-555566667777',
              status: 'approved',
              decidedSource: 'human',
            },
          ],
        })
      )
      const { container } = renderAdmin()
      expect(container.textContent).not.toContain('review.aiAgree')
      expect(container.textContent).not.toContain('review.aiDisagree')
      expect(container.textContent).toContain('review.aiVerdict')
      expect(container.textContent).toContain('review.aiProvenanceAuto')
      expect(container.textContent).toContain('review.aiProvenanceAssist')
      expect(container.textContent).toContain('review.aiProvenanceHuman')
      // Auto mode says when the cron evaluates.
      expect(container.textContent).toContain('review.aiAutoCronNote')
    })

    it('keeps the verdict block off a decided row that still carries its verdict', () => {
      // The list LEFT JOINs the cached verdict with no status filter
      // (backend/src/lib/match-review.ts), so the row that comes back after an
      // assisted decision is BOTH approved and carrying aiVerdict. The
      // provenance chip is the whole story then — re-rendering the verdict
      // block would offer Agree/Disagree on an already-decided row and a second
      // click would rewrite the decision and its human_agreement (thermos A2).
      vi.mocked(useReviewItems).mockReturnValue(
        mockReviewData({
          items: [
            {
              ...reviewItem,
              status: 'approved',
              decidedSource: 'ai_assist',
              aiVerdict: VERDICT,
            },
          ],
        })
      )
      const { container } = renderAdmin()
      expect(container.textContent).toContain('review.aiProvenanceAssist')
      expect(container.textContent).not.toContain('review.aiVerdict')
      expect(container.textContent).not.toContain('review.aiAgree')
      expect(container.textContent).not.toContain('review.aiDisagree')
      // The reason disclosure is part of the verdict block, not the chip row.
      expect(container.textContent).not.toContain('review.aiReasonShow')
    })

    it('runs one bounded evaluation on first load when pending rows lack verdicts', async () => {
      const view = renderAdmin()
      await waitFor(() => expect(evaluateMutate).toHaveBeenCalledWith(5))
      expect(evaluateMutate).toHaveBeenCalledTimes(1)
      // A plain re-render must not fire a second probe.
      view.rerender(
        React.createElement(
          QueryClientProvider,
          { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          React.createElement(AdminReview, null)
        )
      )
      expect(evaluateMutate).toHaveBeenCalledTimes(1)
      // Nor may the refetch the settle-invalidation triggers. That refetch
      // lands a NEW list payload whose rows are still waiting (the verdicts
      // have not arrived yet) — the exact shape that would re-fire the effect,
      // and re-bill, if the mount-scoped ref were ever dropped. A re-render
      // over the same mocked object proves nothing here (thermos A1).
      vi.mocked(useReviewItems).mockReturnValue(mockReviewData())
      view.rerender(
        React.createElement(
          QueryClientProvider,
          { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          React.createElement(AdminReview, null)
        )
      )
      expect(evaluateMutate).toHaveBeenCalledTimes(1)
    })

    it('does not evaluate when every pending row already has a verdict', () => {
      vi.mocked(useReviewItems).mockReturnValue(
        mockReviewData({ items: [{ ...reviewItem, aiVerdict: VERDICT }] })
      )
      renderAdmin()
      expect(evaluateMutate).not.toHaveBeenCalled()
      expect(document.body.textContent).not.toContain('review.aiWaiting')
    })

    it('does not count taxonomy self-pairs as waiting for AI', () => {
      vi.mocked(useReviewItems).mockReturnValue(
        mockReviewData({ items: [{ ...reviewItem, reason: 'taxonomy' }] })
      )
      const { container } = renderAdmin()
      expect(evaluateMutate).not.toHaveBeenCalled()
      expect(container.textContent).not.toContain('review.aiWaiting')
    })

    // Issue #493: the queue rendered every non-price_ratio reason under the
    // verifier label, so a classification flag read as an unresolved product
    // match. The chip now names the category question and the row states the
    // #484 exclusion (no AI verdict, no provider call) instead of leaving the
    // missing verdict unexplained.
    it('labels a taxonomy flag as a category question, never the verifier', () => {
      vi.mocked(useReviewItems).mockReturnValue(
        mockReviewData({ items: [{ ...reviewItem, reason: 'taxonomy' }] })
      )
      const { container } = renderAdmin()
      // Scoped to the ROW's flag chip: the reason filter (issue #628) renders
      // all three labels as controls, so a page-wide text assertion would now
      // match the filter rather than the row.
      const flagChip = [...container.querySelectorAll('span')].find((el) =>
        el.textContent.startsWith('review.flagPrefix')
      )
      expect(flagChip.textContent).toBe('review.flagPrefix review.reasonTaxonomy')
      expect(container.textContent).not.toContain('review.aiVerdict')
      expect(container.textContent).not.toContain('review.aiAgree')
      expect(container.textContent).toContain('review.aiTaxonomyExcluded')
      expect(container.textContent).not.toContain('review.aiWaiting')
      expect(evaluateMutate).not.toHaveBeenCalled()
    })

    it('drops the taxonomy no-verdict note when AI is off or the row is decided', () => {
      // Manual mode: no AI surface at all, so no exclusion to explain.
      vi.mocked(useReviewMode).mockReturnValue(modeData({ mode: 'manual', aiConfigured: true }))
      vi.mocked(useReviewItems).mockReturnValue(
        mockReviewData({ items: [{ ...reviewItem, reason: 'taxonomy' }] })
      )
      const manual = renderAdmin()
      expect(manual.container.textContent).toContain('review.reasonTaxonomy')
      expect(manual.container.textContent).not.toContain('review.aiTaxonomyExcluded')
      manual.unmount()

      // A decided row records what happened; the note is about a pending
      // row's missing verdict.
      vi.mocked(useReviewMode).mockReturnValue(modeData({ mode: 'assist', aiConfigured: true }))
      vi.mocked(useReviewItems).mockReturnValue(
        mockReviewData({ items: [{ ...reviewItem, reason: 'taxonomy', status: 'approved' }] })
      )
      const decided = renderAdmin()
      expect(decided.container.textContent).toContain('review.reasonTaxonomy')
      expect(decided.container.textContent).not.toContain('review.aiTaxonomyExcluded')
    })

    it('shows the waiting hint and evaluates 10 more on demand', async () => {
      const { container, getByText } = renderAdmin()
      expect(container.textContent).toContain('review.aiWaiting')
      await waitFor(() => expect(evaluateMutate).toHaveBeenCalledWith(5))
      evaluateMutate.mockClear()
      fireEvent.click(getByText('review.aiEvaluateMore'))
      expect(evaluateMutate).toHaveBeenCalledWith(10)
    })

    it('shows an evaluating status and disables the button while running', () => {
      vi.mocked(useEvaluateReview).mockReturnValue({
        mutate: evaluateMutate,
        isPending: true,
        isError: false,
      })
      const { container, getByText } = renderAdmin()
      expect(getByText('review.aiEvaluateMore').disabled).toBe(true)
      expect(container.textContent).toContain('review.aiEvaluating')
    })

    it('surfaces evaluation and mode-save failures inline', () => {
      vi.mocked(useEvaluateReview).mockReturnValue({
        mutate: evaluateMutate,
        isPending: false,
        isError: true,
      })
      vi.mocked(useSetReviewMode).mockReturnValue({
        mutate: setModeMutate,
        isPending: false,
        isError: true,
      })
      const { container } = renderAdmin()
      expect(container.textContent).toContain('review.aiEvaluateFailed')
      expect(container.textContent).toContain('review.aiModeFailed')
    })

    it('manual mode renders no AI verdict/evaluate UI and makes no AI call', () => {
      vi.mocked(useReviewMode).mockReturnValue(modeData({ mode: 'manual', aiConfigured: true }))
      vi.mocked(useReviewItems).mockReturnValue(
        mockReviewData({ items: [{ ...reviewItem, aiVerdict: VERDICT }] })
      )
      const { container } = renderAdmin()
      expect(container.textContent).not.toContain('review.aiVerdict')
      expect(container.textContent).not.toContain('review.aiAgree')
      expect(container.textContent).not.toContain('review.aiEvaluateMore')
      expect(container.textContent).not.toContain('review.aiWaiting')
      expect(evaluateMutate).not.toHaveBeenCalled()
      // The ordinary human decision path stays available.
      expect(container.textContent).toContain('review.approve')
      expect(container.textContent).toContain('review.reject')
    })

    it('shows nothing AI-related to a non-admin and gates the mode query', () => {
      vi.mocked(useMe).mockReturnValue({ data: { user: { isAdmin: false } } })
      const { container } = renderAdmin()
      expect(useReviewMode).toHaveBeenCalledWith({ enabled: false })
      for (const key of [
        'review.aiModeLegend',
        'review.aiVerdict',
        'review.aiEvaluateMore',
        'review.aiProvenanceAuto',
      ]) {
        expect(container.textContent).not.toContain(key)
      }
      expect(evaluateMutate).not.toHaveBeenCalled()
    })
  })
})
