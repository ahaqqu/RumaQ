import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { PromosReview } from './PromosReview.jsx'
import { ApiError } from '../lib/api'

vi.mock('react-i18next', async () => {
  const { mockReactI18next } = await import('../test-i18n.js')
  return mockReactI18next()
})

vi.mock('../lib/queries/index.js', () => ({
  usePromoReview: vi.fn(),
  usePriceSources: vi.fn(),
}))

import { usePromoReview, usePriceSources } from '../lib/queries/index.js'

const INDOMIE_KEY = 'indomie--mi-instant--69-gr'
const OIL_KEY = 'minyak-goreng--bimoli--1-l'

// The rows mirror the endpoint's field set (issue #717); the labels are the
// exact strings the pipeline scraped — casing and punctuation untouched.
const reviewRows = [
  {
    product_key: INDOMIE_KEY,
    name: 'INDOMIE MI INSTANT SOTO MIE 69GR',
    brand: 'Indomie',
    unit: '69 GR',
    source_slug: 'superindo',
    source_name: 'Superindo',
    observed_date: '2026-11-17',
    price: 111900,
    member_price: null,
    effective_unit_price: null,
    promo_type: 'multi_price',
    promo_label: 'Harga Promo 16, 18,19 NOV 44.900; Maks. 4 krt',
    valid_from: null,
    valid_until: null,
    match_method: 'ai',
    match_confidence: 0.9,
    brochure_url: 'https://www.superindo.co.id/promo',
    scraped_at: '2026-11-17T23:00:05Z',
  },
  {
    product_key: OIL_KEY,
    name: 'Minyak Goreng Bimoli 1 L',
    brand: 'Bimoli',
    unit: '1 L',
    source_slug: 'lotte-mart',
    source_name: 'Lotte Mart',
    observed_date: '2026-11-17',
    price: 41000,
    member_price: 36000,
    effective_unit_price: null,
    promo_type: 'discount_pct',
    promo_label: 'Diskon 20%; Harga Spesial',
    valid_from: '2026-11-16',
    valid_until: '2026-11-19',
    match_method: 'exact',
    match_confidence: 1,
    brochure_url: null,
    scraped_at: '2026-11-17T23:00:07Z',
  },
]

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
}

function renderReview() {
  return render(
    React.createElement(
      QueryClientProvider,
      { client: createQueryClient() },
      React.createElement(PromosReview, null)
    )
  )
}

// The suite's i18n mock returns raw keys, so assertions match keys and
// untranslated data (store names, verbatim chips).

describe('PromosReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(usePriceSources).mockReturnValue({
      data: [
        { slug: 'lotte-mart', name: 'Lotte Mart' },
        { slug: 'superindo', name: 'Superindo' },
      ],
    })
    vi.mocked(usePromoReview).mockReturnValue({
      data: { items: reviewRows, total: 2 },
      isLoading: false,
      isError: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      isFetchingNextPage: false,
    })
  })

  it('renders one row per observation with the store, price and period', () => {
    const { container } = renderReview()
    const rows = container.querySelectorAll('[data-testid="promo-review-row"]')
    expect(rows).toHaveLength(2)
    expect(container.textContent).toContain('Superindo')
    expect(container.textContent).toContain('Lotte Mart')
    // The count line reuses the QA list's "Showing N of M" copy.
    expect(container.textContent).toContain('catalog.brochuresShowing')
  })

  it('renders every chip VERBATIM — no casing or whitespace normalization', () => {
    const { container } = renderReview()
    const chips = [...container.querySelectorAll('[data-testid="promo-review-chip"]')]
    expect(chips.map((chip) => chip.textContent)).toEqual([
      // The dated chip keeps the OCR's exact spacing ('18,19') and casing.
      'Harga Promo 16, 18,19 NOV 44.900',
      'Maks. 4 krt',
      'Diskon 20%',
      'Harga Spesial',
    ])
  })

  it('tags each row with the chip-class families (F3/F4/F5 labels, #717)', () => {
    const { container } = renderReview()
    const classLines = [...container.querySelectorAll('[data-testid="promo-review-chip-classes"]')]
    expect(classLines).toHaveLength(2)
    expect(classLines[0].textContent).toContain('catalog.promoChipClassDated')
    expect(classLines[0].textContent).toContain('catalog.promoChipClassLimit')
    expect(classLines[1].textContent).toContain('catalog.promoChipClassDiscount')
    expect(classLines[1].textContent).toContain('catalog.promoChipClassPriceLabel')
  })

  it('falls back to the parsed promo_type when a row carries no label', () => {
    vi.mocked(usePromoReview).mockReturnValue({
      data: {
        items: [{ ...reviewRows[0], promo_label: null, promo_type: 'bundle_buy' }],
        total: 1,
      },
      isLoading: false,
      isError: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      isFetchingNextPage: false,
    })
    const { container } = renderReview()
    expect(container.textContent).toContain('bundle_buy')
    expect(container.querySelectorAll('[data-testid="promo-review-chip"]')).toHaveLength(0)
    // No chips → no class line (the tags describe the shown badges only).
    expect(container.querySelectorAll('[data-testid="promo-review-chip-classes"]')).toHaveLength(0)
  })

  it('expands a row into its full ingestion metadata and collapses it again', () => {
    const { container } = renderReview()
    expect(container.querySelector('[data-testid="promo-review-metadata"]')).toBeNull()
    // The toggle button is the keyboard path inside the first row's cell.
    fireEvent.click(container.querySelector('[data-testid="promo-review-row"] button'))
    const meta = container.querySelector('[data-testid="promo-review-metadata"]')
    expect(meta).not.toBeNull()
    expect(meta.textContent).toContain(INDOMIE_KEY)
    expect(meta.textContent).toContain('catalog.metaPromoLabel')
    expect(meta.textContent).toContain('catalog.metaMatchConfidence')
    // One expanded row at a time: expanding the second collapses the first.
    fireEvent.click(container.querySelectorAll('[data-testid="promo-review-row"] button')[1])
    const metas = container.querySelectorAll('[data-testid="promo-review-metadata"]')
    expect(metas).toHaveLength(1)
    expect(metas[0].textContent).toContain(OIL_KEY)
  })

  it('passes the debounced search text, store filter and sort to the query', () => {
    vi.useFakeTimers()
    const { container } = renderReview()
    const input = container.querySelector('input[type="search"]')
    fireEvent.change(input, { target: { value: 'Harga Promo' } })
    // The store select carries the QA filter's data-testid.
    const store = container.querySelector('[data-testid="promo-review-store-filter"]')
    fireEvent.change(store, { target: { value: 'superindo' } })
    const sortSelect = container.querySelector('[data-testid="promo-review-sort"]')
    fireEvent.change(sortSelect, { target: { value: 'store' } })

    // Before the debounce settles the query still sees the empty filter.
    expect(vi.mocked(usePromoReview).mock.calls.at(-1)[0]).toEqual({
      q: undefined,
      source: 'superindo',
      sort: 'store',
    })
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(vi.mocked(usePromoReview).mock.calls.at(-1)[0]).toEqual({
      q: 'Harga Promo',
      source: 'superindo',
      sort: 'store',
    })
    vi.useRealTimers()
  })

  it('offers Load more while pages remain', () => {
    vi.mocked(usePromoReview).mockReturnValue({
      data: { items: reviewRows, total: 52 },
      isLoading: false,
      isError: false,
      hasNextPage: true,
      fetchNextPage: vi.fn(),
      isFetchingNextPage: false,
    })
    const { container } = renderReview()
    const more = [...container.querySelectorAll('button')].find((button) =>
      button.textContent.includes('catalog.brochuresLoadMore')
    )
    expect(more).toBeTruthy()
  })

  it('renders the filtered and unfiltered empty states', () => {
    vi.mocked(usePromoReview).mockReturnValue({
      data: { items: [], total: 0 },
      isLoading: false,
      isError: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      isFetchingNextPage: false,
    })
    const { container } = renderReview()
    expect(container.textContent).toContain('catalog.promosReviewEmpty')
    expect(container.textContent).toContain('catalog.promosReviewEmptyDesc')

    // A filter set (source select changed) flips to the filtered copy.
    const filtered = renderReview()
    fireEvent.change(
      filtered.container.querySelector('[data-testid="promo-review-store-filter"]'),
      { target: { value: 'superindo' } }
    )
    expect(filtered.container.textContent).toContain('catalog.promosReviewFilteredEmptyDesc')
  })

  it('renders the M1-kind error copy on error and skeletons while loading', () => {
    vi.mocked(usePromoReview).mockReturnValue({ isLoading: true })
    const loading = renderReview()
    expect(loading.container.textContent).not.toContain('catalog.promosReviewEmpty')

    // L5 (audit): a 500 must not read as "offline" — the description is the
    // M1-kind copy (error.http), never the offline banner.
    vi.mocked(usePromoReview).mockReturnValue({
      isError: true,
      isLoading: false,
      error: new ApiError('Request failed: 500', 500),
    })
    const errored = renderReview()
    expect(errored.container.textContent).toContain('catalog.promosReviewError')
    expect(errored.container.textContent).toContain('error.http')
    expect(errored.container.textContent).not.toContain('offline.banner')
  })
})
