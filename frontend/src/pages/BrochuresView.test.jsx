import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { BrochuresView } from './BrochuresView.jsx'

// Render the REAL English copy (the AdminPrices.i18n.test.jsx idiom) so the
// filter summary, count labels, and metadata labels are asserted as users see
// them — the global setup's raw-key t() would hide interpolation mistakes.
vi.mock('react-i18next', async () => {
  const { vi } = await import('vite-plus/test')
  const en = (await import('../i18n/locales/en.json')).default
  const lookup = (key) => key.split('.').reduce((node, k) => (node == null ? node : node[k]), en)
  const t = (key, opts) => {
    if (opts && opts.returnObjects) return {}
    let template
    if (opts && typeof opts.count === 'number') {
      template = lookup(`${key}_${opts.count === 1 ? 'one' : 'other'}`)
    }
    if (typeof template !== 'string') template = lookup(key)
    if (typeof template !== 'string') return opts?.defaultValue ?? key
    if (!opts) return template
    return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(opts[name] ?? `{{${name}}}`))
  }
  return {
    t,
    useTranslation: () => ({
      t,
      i18n: { language: 'en', changeLanguage: vi.fn(), on: vi.fn(), off: vi.fn() },
    }),
    I18nextProvider: ({ children }) => children,
    initReactI18next: { type: '3rdParty', init: vi.fn() },
  }
})

vi.mock('../lib/queries/index.js', () => ({
  usePriceBrochures: vi.fn(),
  useBrochureProducts: vi.fn(),
}))

import { usePriceBrochures, useBrochureProducts } from '../lib/queries/index.js'

const BROCHURE_A = '/api/brochures/lotte-mart/20261029/page_1_2ad1c95b.jpg'
const BROCHURE_B = '/api/brochures/lotte-mart/20261028/page_2_ff00aa11.jpg'
const BROCHURE_C = '/api/brochures/superindo/20261029/koran_a_1b2c3d4e.jpg'

const groups = [
  {
    source_slug: 'lotte-mart',
    source_name: 'Lotte Mart',
    brochure_url: BROCHURE_A,
    observed_date: '2026-10-29',
    product_count: 7,
  },
  {
    source_slug: 'lotte-mart',
    source_name: 'Lotte Mart',
    brochure_url: BROCHURE_B,
    observed_date: '2026-10-28',
    product_count: 2,
  },
  {
    source_slug: 'superindo',
    source_name: 'Superindo',
    brochure_url: BROCHURE_C,
    observed_date: '2026-10-29',
    product_count: 1,
  },
]

const fullProduct = {
  product_key: 'beras--pandan-wangi--5-kg',
  name: 'Beras Pandan Wangi 5 kg',
  brand: 'Pandan Wangi',
  unit: '5 kg',
  category: 'beras',
  category_version: '2026-01',
  price: 72000,
  effective_unit_price: 14400,
  promo_type: 'discount_pct',
  promo_label: 'DISKON 20%',
  valid_from: '2026-10-29',
  valid_until: '2026-11-04',
  match_method: 'embedding',
  match_confidence: 0.92,
  source_slug: 'lotte-mart',
  source_name: 'Lotte Mart',
  source_website: 'https://www.lottemart.co.id',
  observed_date: '2026-10-29',
  brochure_url: BROCHURE_A,
  scraped_at: '2026-10-29T23:00:05Z',
}

// Seven rows prove the old ≤5 example cap is gone in the UI too.
const products = [
  fullProduct,
  ...Array.from({ length: 6 }, (_, index) => ({
    product_key: `produk-${index}--merek--1-pcs`,
    name: `Produk ${index}`,
    brand: 'Merek',
    unit: '1 pcs',
    category: null,
    category_version: null,
    price: 1000 + index,
    effective_unit_price: null,
    promo_type: null,
    promo_label: null,
    valid_from: null,
    valid_until: null,
    match_method: 'exact',
    match_confidence: 1,
    source_slug: 'lotte-mart',
    source_name: 'Lotte Mart',
    source_website: null,
    observed_date: '2026-10-29',
    brochure_url: BROCHURE_A,
    scraped_at: '2026-10-29T23:00:05Z',
  })),
]

const fetchNextPage = vi.fn()

function productPage({ items = products, total = 120, ...overrides } = {}) {
  return {
    data: { items, total },
    isLoading: false,
    isError: false,
    hasNextPage: items.length < total,
    fetchNextPage,
    isFetchingNextPage: false,
    ...overrides,
  }
}

function renderView() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(BrochuresView, null)
    )
  )
}

function cards(container) {
  return [...container.querySelectorAll('[data-testid="brochure-card"]')]
}

function cardFor(container, url) {
  return cards(container).find((card) => card.querySelector(`img[src="${url}"]`))
}

function selectFilter(container, testId, value) {
  fireEvent.change(container.querySelector(`[data-testid="${testId}"]`), { target: { value } })
}

function text(container) {
  return container.textContent.replace(/\u00a0/g, ' ')
}

describe('BrochuresView — filters and layout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: { groups },
      isLoading: false,
      isError: false,
    })
    vi.mocked(useBrochureProducts).mockReturnValue(productPage())
  })

  it('renders a responsive multi-column grid of brochure cards', () => {
    const { container } = renderView()
    const grid = container.querySelector('[data-testid="brochures-grid"]')
    expect(grid.className).toContain('grid-cols-2')
    expect(grid.className).toContain('sm:grid-cols-3')
    expect(grid.className).toContain('lg:grid-cols-4')
    expect(cards(container)).toHaveLength(3)

    // Every card keeps the 3:4 image frame, store, date, and product count.
    const card = cardFor(container, BROCHURE_A)
    expect(card.querySelector('img').getAttribute('loading')).toBe('lazy')
    expect(card.querySelector('img').getAttribute('alt')).toBe('Lotte Mart brochure page')
    expect(card.querySelector('[style*="3 / 4"]')).toBeTruthy()
    expect(text(card)).toContain('Lotte Mart')
    expect(text(card)).toContain('October 29, 2026')
    expect(text(card)).toContain('7 products')
  })

  it('filters by store and date and keeps the counts in sync with the filtered set', () => {
    const { container } = renderView()
    expect(text(container.querySelector('[data-testid="brochures-summary"]'))).toBe(
      '3 brochures · 10 products'
    )

    selectFilter(container, 'brochure-store-filter', 'lotte-mart')
    expect(cards(container)).toHaveLength(2)
    expect(text(container.querySelector('[data-testid="brochures-summary"]'))).toBe(
      '2 brochures · 9 products'
    )

    // Composable: adding a date narrows the store-filtered set, not the whole
    // catalog.
    selectFilter(container, 'brochure-date-filter', '2026-10-29')
    expect(cards(container)).toHaveLength(1)
    expect(cardFor(container, BROCHURE_A)).toBeTruthy()
    expect(text(container.querySelector('[data-testid="brochures-summary"]'))).toBe(
      '1 brochure · 7 products'
    )

    // Clearing the store keeps the date filter; clearing the date restores all.
    selectFilter(container, 'brochure-store-filter', '')
    expect(cards(container)).toHaveLength(2)
    selectFilter(container, 'brochure-date-filter', '')
    expect(cards(container)).toHaveLength(3)
  })

  it('shows a reset action when the filters exclude every brochure', () => {
    const { container } = renderView()
    selectFilter(container, 'brochure-store-filter', 'superindo')
    selectFilter(container, 'brochure-date-filter', '2026-10-28')

    expect(cards(container)).toHaveLength(0)
    expect(text(container)).toContain('No brochures match these filters')
    fireEvent.click(
      [...container.querySelectorAll('button')].find((button) =>
        button.textContent.includes('Reset filters')
      )
    )
    expect(cards(container)).toHaveLength(3)
  })

  it('degrades a missing image to the same-frame fallback', () => {
    const { container } = renderView()
    fireEvent.error(container.querySelector(`img[src="${BROCHURE_A}"]`))
    expect(container.querySelector(`img[src="${BROCHURE_A}"]`)).toBeNull()
    const card = cards(container)[0]
    expect(text(card)).toContain('Lotte Mart')
    expect(text(card)).toContain('7 products')
  })
})

describe('BrochuresView — selection and the full product review', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: { groups },
      isLoading: false,
      isError: false,
    })
    vi.mocked(useBrochureProducts).mockReturnValue(productPage())
  })

  it('fetches the selected brochure lazily and renders every product in a table', () => {
    const { container } = renderView()
    expect(useBrochureProducts).not.toHaveBeenCalled()
    expect(text(container)).toContain('Select a brochure to review every product ingested from it.')

    fireEvent.click(cardFor(container, BROCHURE_A))
    expect(useBrochureProducts).toHaveBeenCalledWith(BROCHURE_A)

    const headers = [...container.querySelectorAll('thead th')].map((th) => th.textContent)
    expect(headers).toEqual([
      'Product',
      'Unit',
      'Price',
      'Effective unit price',
      'Promo',
      'Category',
      'Match',
    ])
    // No 5-row cap: all seven rows from the endpoint render.
    expect(container.querySelectorAll('[data-testid="brochure-product-row"]')).toHaveLength(7)
    expect(text(container)).toContain('Beras Pandan Wangi 5 kg')
    expect(text(container)).toContain('Rp 72.000')
    expect(text(container)).toContain('Rp 14.400')
    expect(text(container)).toContain('Diskon 20%')
    expect(text(container)).toContain('beras')
    expect(text(container)).toContain('embedding · 92%')

    // The review is full width below the grid, not an inline card list.
    const review = container.querySelector('#brochure-review')
    expect(review).toBeTruthy()
    expect(review.getAttribute('role')).toBe('region')
    expect(review.getAttribute('aria-label')).toBe(
      'Products ingested from the Lotte Mart brochure of October 29, 2026'
    )

    // A single click selects one brochure, not a multi-expand stack.
    expect(cardFor(container, BROCHURE_A).getAttribute('aria-expanded')).toBe('true')
    expect(cardFor(container, BROCHURE_B).getAttribute('aria-expanded')).toBe('false')
    expect(text(container)).toContain('Showing 7 of 120')
  })

  it('collapses the review when the selected card is clicked again', () => {
    const { container } = renderView()
    fireEvent.click(cardFor(container, BROCHURE_A))
    expect(container.querySelector('#brochure-review')).toBeTruthy()

    fireEvent.click(cardFor(container, BROCHURE_A))
    expect(container.querySelector('#brochure-review')).toBeNull()
    expect(container.querySelectorAll('[data-testid="brochure-product-row"]')).toHaveLength(0)
  })

  it('loads more pages without dropping already-rendered rows', () => {
    const { container } = renderView()
    fireEvent.click(cardFor(container, BROCHURE_A))
    fireEvent.click(
      [...container.querySelectorAll('button')].find((button) =>
        button.textContent.includes('Load more')
      )
    )
    expect(fetchNextPage).toHaveBeenCalledTimes(1)
  })

  it('hides Load more when the whole brochure is shown', () => {
    vi.mocked(useBrochureProducts).mockReturnValue(productPage({ total: 7 }))
    const { container } = renderView()
    fireEvent.click(cardFor(container, BROCHURE_A))
    expect(text(container)).toContain('Showing 7 of 7')
    expect(
      [...container.querySelectorAll('button')].some((button) =>
        button.textContent.includes('Load more')
      )
    ).toBe(false)
  })
})

describe('BrochuresView — row metadata panel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: { groups },
      isLoading: false,
      isError: false,
    })
    vi.mocked(useBrochureProducts).mockReturnValue(productPage())
  })

  it('expands the full ingestion metadata in place on a row click', () => {
    const { container } = renderView()
    fireEvent.click(cardFor(container, BROCHURE_A))
    expect(container.querySelector('[data-testid="brochure-product-metadata"]')).toBeNull()

    const firstRow = container.querySelector('[data-testid="brochure-product-row"]')
    const toggle = firstRow.querySelector('button[aria-expanded]')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(firstRow)

    const panel = container.querySelector('[data-testid="brochure-product-metadata"]')
    expect(panel).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-controls')).toBe(panel.closest('tr').id)

    const copy = text(panel)
    for (const expected of [
      'Product key',
      'beras--pandan-wangi--5-kg',
      'Name',
      'Beras Pandan Wangi 5 kg',
      'Brand',
      'Pandan Wangi',
      'Unit',
      '5 kg',
      'Category version',
      '2026-01',
      'Promo type',
      'discount_pct',
      'Promo label',
      'DISKON 20%',
      'Valid from',
      '2026-10-29',
      'Valid until',
      '2026-11-04',
      'Match method',
      'embedding',
      'Match confidence',
      '92%',
      'Store',
      'Lotte Mart',
      'Store slug',
      'lotte-mart',
      'Store website',
      'https://www.lottemart.co.id',
      'Observed date',
      'Brochure date',
      'October 29, 2026',
      'Brochure URL',
      BROCHURE_A,
      'Scraped at',
      '2026-10-29T23:00:05Z',
    ]) {
      expect(copy, `metadata panel is missing ${expected}`).toContain(expected)
    }
    // The panel is a definition list — screen readers get label/value pairs.
    expect(panel.tagName).toBe('DL')
  })

  it('toggles the metadata panel from the keyboard-reachable button and closes it again', () => {
    const { container } = renderView()
    fireEvent.click(cardFor(container, BROCHURE_A))
    const firstRow = container.querySelector('[data-testid="brochure-product-row"]')
    const toggle = firstRow.querySelector('button[aria-expanded]')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-testid="brochure-product-metadata"]')).toBeTruthy()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-testid="brochure-product-metadata"]')).toBeNull()
  })

  it('does not navigate away from the view', () => {
    const hrefBefore = window.location.href
    const { container } = renderView()
    fireEvent.click(cardFor(container, BROCHURE_A))
    fireEvent.click(container.querySelector('[data-testid="brochure-product-row"]'))
    expect(window.location.href).toBe(hrefBefore)
    // Still the QA table, not the products explorer.
    expect(container.querySelector('#brochure-review')).toBeTruthy()
    expect(container.textContent).not.toContain('prices.currentPrices')
  })
})

describe('BrochuresView — loading, empty, error', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders skeletons while the catalog loads', () => {
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    })
    vi.mocked(useBrochureProducts).mockReturnValue(productPage())
    const { container } = renderView()
    expect(container.querySelector('.bg-surface-inset')).toBeTruthy()
    expect(cards(container)).toHaveLength(0)
  })

  it('renders the offline pattern when the catalog fails', () => {
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    })
    vi.mocked(useBrochureProducts).mockReturnValue(productPage())
    const { container } = renderView()
    expect(text(container)).toContain('No matching prices')
    expect(text(container)).toContain("You're offline")
  })

  it('keeps the empty catalog state', () => {
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: { groups: [] },
      isLoading: false,
      isError: false,
    })
    vi.mocked(useBrochureProducts).mockReturnValue(productPage())
    const { container } = renderView()
    expect(text(container)).toContain('No brochures yet')
    expect(container.querySelectorAll('img')).toHaveLength(0)
  })

  it('shows loading, error, and empty states inside the review section', () => {
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: { groups },
      isLoading: false,
      isError: false,
    })

    vi.mocked(useBrochureProducts).mockReturnValue(
      productPage({ data: undefined, isLoading: true })
    )
    const loading = renderView()
    fireEvent.click(cardFor(loading.container, BROCHURE_A))
    expect(loading.container.querySelector('#brochure-review .bg-surface-inset')).toBeTruthy()
    loading.unmount()

    vi.mocked(useBrochureProducts).mockReturnValue(
      productPage({ data: undefined, isLoading: false, isError: true })
    )
    const failed = renderView()
    fireEvent.click(cardFor(failed.container, BROCHURE_A))
    expect(text(failed.container)).toContain('Could not load this brochure')
    failed.unmount()

    vi.mocked(useBrochureProducts).mockReturnValue(productPage({ items: [], total: 0 }))
    const empty = renderView()
    fireEvent.click(cardFor(empty.container, BROCHURE_A))
    expect(text(empty.container)).toContain('No current products')
    expect(text(empty.container)).toContain(
      'Every observation on this brochure is superseded or below the match-confidence floor.'
    )
  })
})

describe('BrochuresView — accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: { groups },
      isLoading: false,
      isError: false,
    })
    vi.mocked(useBrochureProducts).mockReturnValue(productPage())
  })

  it('labels both filters and groups them', () => {
    const { container } = renderView()
    const group = container.querySelector('[data-testid="brochure-filters"]')
    expect(group.getAttribute('role')).toBe('group')
    expect(group.getAttribute('aria-label')).toBe('Brochure filters')
    expect(
      container.querySelector('[data-testid="brochure-store-filter"]').labels[0].textContent
    ).toContain('Store')
    expect(
      container.querySelector('[data-testid="brochure-date-filter"]').labels[0].textContent
    ).toContain('Date')
    expect(
      [...container.querySelectorAll('[data-testid="brochure-store-filter"] option')].map(
        (option) => option.textContent
      )
    ).toEqual(['All stores', 'Lotte Mart', 'Superindo'])
    expect(
      [...container.querySelectorAll('[data-testid="brochure-date-filter"] option')].map(
        (option) => option.textContent
      )
    ).toEqual(['All dates', 'October 29, 2026', 'October 28, 2026'])
  })

  it('gives every card an accessible name and an expanded state', () => {
    const { container } = renderView()
    for (const card of cards(container)) {
      expect(card.getAttribute('aria-expanded')).toBe('false')
      expect(card.tagName).toBe('BUTTON')
    }
    expect(text(cardFor(container, BROCHURE_A))).toContain('Lotte Mart')
    expect(text(cardFor(container, BROCHURE_A))).toContain('7 products')
    expect(text(cardFor(container, BROCHURE_C))).toContain('Superindo')
  })

  it('uses a scoped-header table with a caption and an announced shown count', () => {
    const { container } = renderView()
    fireEvent.click(cardFor(container, BROCHURE_A))
    expect(container.querySelector('table caption').className).toContain('sr-only')
    expect(container.querySelectorAll('thead th[scope="col"]')).toHaveLength(7)
    expect(
      container.querySelector('[data-testid="brochure-product-row"] button[aria-expanded]')
    ).toBeTruthy()
    expect(container.querySelector('#brochure-review [role="status"]').textContent).toBe(
      'Showing 7 of 120'
    )
  })
})
