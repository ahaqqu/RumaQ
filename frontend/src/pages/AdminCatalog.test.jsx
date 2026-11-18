import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { AdminCatalog } from './AdminCatalog.jsx'

// The admin catalog (#631, three sections since #673) is the home of the
// tools moved off /prices: the Products lookup with rename, duplicate-names,
// and alias-candidates; the Brochures QA ingestion view (#630); and the Promos
// tab — since #717 the chip-review surface (default) plus the promo catalog
// (whose example click jumps into the user explorer). The route guard
// is the AdminPrices pattern (useMe + unauthorized state; the APIs are already
// requireAdmin).
const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }))

let mockHash = ''
let mockTab = ''

vi.mock('@tanstack/react-router', () => ({
  // Simulates the router: navigate writes the hash back into the location the
  // page reads, so the deep-link/jump behaviour can be exercised.
  useNavigate: () => (options) => {
    mockHash = options.hash ? `#${options.hash}` : ''
    navigateMock(options)
  },
  useLocation: () => ({ hash: mockHash }),
  useSearch: () => (mockTab ? { tab: mockTab } : {}),
}))

vi.mock('../lib/queries/index.js', () => ({
  usePrices: vi.fn(),
  usePriceSources: vi.fn(),
  usePriceMeta: vi.fn(),
  usePriceDetail: vi.fn(),
  usePriceBrochures: vi.fn(),
  useBrochureProducts: vi.fn(),
  usePricePromos: vi.fn(),
  usePromoReview: vi.fn(),
}))

vi.mock('../lib/queries/me.js', () => ({ useMe: vi.fn() }))

// The admin tools (rename form, duplicate report, alias bulk action) import
// these; the panels stay lazy, so the tests below pin when they fetch.
vi.mock('../lib/queries/products.js', () => ({
  useProductIdentity: vi.fn(),
  useRenameProduct: vi.fn(),
  useRevertRename: vi.fn(),
  useRevertProductCategory: vi.fn(),
  useDecideAlias: vi.fn(),
  useDuplicateProductNames: vi.fn(),
  useAliasCandidateCounts: vi.fn(),
  useBulkApproveExactAliases: vi.fn(),
}))

import {
  usePrices,
  usePriceSources,
  usePriceMeta,
  usePriceDetail,
  usePriceBrochures,
  useBrochureProducts,
  usePricePromos,
  usePromoReview,
} from '../lib/queries/index.js'
import { useMe } from '../lib/queries/me.js'
import {
  useProductIdentity,
  useRenameProduct,
  useRevertRename,
  useRevertProductCategory,
  useDecideAlias,
  useDuplicateProductNames,
  useAliasCandidateCounts,
  useBulkApproveExactAliases,
} from '../lib/queries/products.js'

const OIL_KEY = 'minyak-goreng--bimoli--1-l'
const RICE_KEY = 'beras--pandan-wangi--5-kg'

const mockItems = [
  {
    product_key: OIL_KEY,
    name: 'Minyak Goreng Bimoli',
    brand: 'Bimoli',
    unit: '1 L',
    source_slug: 'lotte-mart',
    source_name: 'Lotte Mart',
    price: 23000,
    effective_unit_price: 23000,
    promo_label: null,
    low_confidence: false,
  },
  {
    product_key: RICE_KEY,
    name: 'Beras Pandan Wangi',
    brand: 'Pandan Wangi',
    unit: '5 kg',
    source_slug: 'superindo',
    source_name: 'Superindo',
    price: 72000,
    effective_unit_price: 72000,
    promo_label: null,
    low_confidence: false,
  },
]

const brochureUrl = '/api/brochures/lotte-mart/20261029/page_1_2ad1c95b.jpg'

const brochureCatalog = {
  groups: [
    {
      source_slug: 'lotte-mart',
      source_name: 'Lotte Mart',
      brochure_url: brochureUrl,
      observed_date: '2026-10-29',
      product_count: 2,
      example_products: [
        {
          product_key: OIL_KEY,
          name: 'Minyak Goreng Bimoli',
          brand: 'Bimoli',
          unit: '1 L',
          price: 21500,
          effective_unit_price: 21500,
        },
      ],
    },
  ],
}

const promoCatalog = {
  types: [
    {
      promo_type: 'discount_pct',
      product_count: 2,
      stores: { 'lotte-mart': 1, superindo: 1 },
      example_products: [
        {
          product_key: OIL_KEY,
          name: 'Minyak Goreng Bimoli',
          brand: 'Bimoli',
          unit: '1 L',
          price: 21500,
          effective_unit_price: 21500,
        },
      ],
    },
    {
      promo_type: 'get_free',
      product_count: 1,
      stores: { superindo: 1 },
      example_products: [],
    },
  ],
  total: 3,
}

// The promo review rows (issue #717): one per (product, store) with the
// verbatim '; '-joined chips.
const promoReviewRows = [
  {
    product_key: OIL_KEY,
    name: 'Minyak Goreng Bimoli 1 L',
    brand: 'Bimoli',
    unit: '1 L',
    source_slug: 'lotte-mart',
    source_name: 'Lotte Mart',
    observed_date: '2026-10-29',
    price: 21500,
    member_price: null,
    effective_unit_price: null,
    promo_type: 'discount_pct',
    promo_label: 'DISKON 20%; Harga Spesial',
    valid_from: '2026-10-29',
    valid_until: '2026-11-04',
    match_method: 'exact',
    match_confidence: 1,
    brochure_url: brochureUrl,
    scraped_at: '2026-10-29T23:00:05Z',
  },
]

const detail = {
  product: { product_key: OIL_KEY, name: 'Minyak Goreng Bimoli' },
  current: [
    {
      source_slug: 'lotte-mart',
      source_name: 'Lotte Mart',
      price: 23000,
      effective_unit_price: 23000,
      unit: '1 L',
      low_confidence: false,
    },
  ],
  history: [],
}

function renderCatalog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  const utils = render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(AdminCatalog, null)
    )
  )
  utils._queryClient = queryClient
  return utils
}

function clickable(container, text) {
  return [...container.querySelectorAll('button, span')].find((el) => el.textContent.includes(text))
}

function tabs(container) {
  return [...container.querySelectorAll('[data-testid="catalog-tabs"] button')]
}

function tabByText(container, text) {
  return tabs(container).find((button) => button.textContent.includes(text))
}

describe('AdminCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHash = ''
    mockTab = ''
    Element.prototype.scrollIntoView = vi.fn()
    vi.mocked(useMe).mockReturnValue({ data: { user: { isAdmin: true } } })
    vi.mocked(usePrices).mockReturnValue({
      data: { items: mockItems, total: mockItems.length, truncated: false },
      isLoading: false,
      isError: false,
    })
    vi.mocked(usePriceSources).mockReturnValue({
      data: [{ slug: 'lotte-mart', name: 'Lotte Mart' }],
    })
    vi.mocked(usePriceMeta).mockReturnValue({
      data: { latestScrapedAt: new Date().toISOString(), categories: [] },
    })
    vi.mocked(usePriceDetail).mockReturnValue({ data: detail, isLoading: false })
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: brochureCatalog,
      isLoading: false,
      isError: false,
    })
    vi.mocked(usePricePromos).mockReturnValue({
      data: promoCatalog,
      isLoading: false,
      isError: false,
    })
    vi.mocked(usePromoReview).mockReturnValue({
      data: { items: promoReviewRows, total: promoReviewRows.length },
      isLoading: false,
      isError: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      isFetchingNextPage: false,
    })
    vi.mocked(useBrochureProducts).mockReturnValue({
      data: {
        items: [
          {
            ...brochureCatalog.groups[0].example_products[0],
            category: 'minyak-goreng',
            category_version: '2026-01',
            promo_type: 'discount_pct',
            promo_label: 'DISKON 10%',
            valid_from: '2026-10-29',
            valid_until: '2026-11-04',
            match_method: 'exact',
            match_confidence: 1,
            source_slug: 'lotte-mart',
            source_name: 'Lotte Mart',
            source_website: 'https://www.lottemart.co.id',
            observed_date: '2026-10-29',
            brochure_url: brochureUrl,
            scraped_at: '2026-10-29T23:00:05Z',
          },
        ],
        total: 1,
      },
      isLoading: false,
      isError: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      isFetchingNextPage: false,
    })
    vi.mocked(useProductIdentity).mockReturnValue({
      data: {
        product: {
          productKey: OIL_KEY,
          name: 'Minyak Goreng Bimoli',
          brand: 'Bimoli',
          unit: '1 L',
          status: 'canonical',
          metadataVersion: 2,
        },
        aliases: [],
        stats: { observations: 1, stores: 1 },
        audit: [],
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    vi.mocked(useRenameProduct).mockReturnValue({ mutate: vi.fn(), isPending: false })
    vi.mocked(useRevertRename).mockReturnValue({ mutate: vi.fn(), isPending: false })
    vi.mocked(useRevertProductCategory).mockReturnValue({ mutate: vi.fn(), isPending: false })
    vi.mocked(useDecideAlias).mockReturnValue({ mutate: vi.fn(), isPending: false })
    vi.mocked(useDuplicateProductNames).mockReturnValue({
      data: { limit: 200, truncated: false, groups: [] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    vi.mocked(useAliasCandidateCounts).mockReturnValue({
      data: { candidates: 4, exactCandidates: 2 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    vi.mocked(useBulkApproveExactAliases).mockReturnValue({ mutate: vi.fn(), isPending: false })
  })

  it('shows the unauthorized state to a non-admin and mounts no tool', () => {
    vi.mocked(useMe).mockReturnValue({ data: { user: { isAdmin: false } } })
    const { container } = renderCatalog()
    expect(container.textContent).toContain('catalog.forbidden')
    expect(container.textContent).toContain('catalog.forbiddenDesc')
    expect(container.querySelector('[data-testid="catalog-tabs"]')).toBeNull()
    expect(container.querySelector('input[type="search"]')).toBeNull()
    expect(container.querySelector('[data-testid="duplicate-names-panel"]')).toBeNull()
    // The guard returns before either catalog read is mounted.
    expect(usePrices).not.toHaveBeenCalled()
    expect(usePriceBrochures).not.toHaveBeenCalled()
    expect(usePricePromos).not.toHaveBeenCalled()
    expect(usePromoReview).not.toHaveBeenCalled()
  })

  it('renders the Products tab with the moved admin tools by default', () => {
    const { container } = renderCatalog()
    expect(container.textContent).toContain('catalog.lead')
    const [productsTab, qaTab, promosTab] = tabs(container)
    expect(productsTab.textContent).toBe('catalog.tabProducts')
    expect(productsTab.getAttribute('aria-pressed')).toBe('true')
    expect(qaTab.textContent).toBe('catalog.tabBrochuresQa')
    expect(qaTab.getAttribute('aria-pressed')).toBe('false')
    expect(promosTab.textContent).toBe('catalog.tabPromos')
    expect(promosTab.getAttribute('aria-pressed')).toBe('false')

    // Product lookup + the identity/QA panels moved from the user page.
    expect(container.querySelector('input[type="search"]')).toBeTruthy()
    expect(container.textContent).toContain('Minyak Goreng Bimoli')
    expect(container.querySelector('[data-testid="duplicate-names-panel"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="alias-candidates-panel"]')).not.toBeNull()
    // The Brochures and promos reads stay unmounted on this tab.
    expect(usePriceBrochures).not.toHaveBeenCalled()
    expect(usePricePromos).not.toHaveBeenCalled()
  })

  it('filters the catalog through the shared category picker (#632)', () => {
    vi.mocked(usePriceMeta).mockReturnValue({
      data: { latestScrapedAt: new Date().toISOString(), categories: ['beras', 'minyak-goreng'] },
    })
    const { container } = renderCatalog()
    // The admin catalog hosts the same ProductsView, so it renders the same
    // picker with no behavioural fork.
    const filter = container.querySelector('[data-testid="prices-category-filter"]')
    expect(filter).not.toBeNull()
    fireEvent.click(within(filter).getByRole('button', { name: /prices\.allCategories/ }))
    fireEvent.click(within(filter).getByRole('option', { name: 'minyak-goreng' }))

    expect(vi.mocked(usePrices).mock.calls.at(-1)[0]).toEqual({
      q: undefined,
      source: null,
      category: 'minyak-goreng',
      sort: 'cheapest',
    })
  })

  it('offers the rename action inside the expanded admin product detail', () => {
    const { container } = renderCatalog()
    fireEvent.click(clickable(container, 'Minyak Goreng Bimoli'))
    expect(container.textContent).toContain('prices.currentPrices')

    const rename = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'rename.action'
    )
    expect(rename).toBeTruthy()
    fireEvent.click(rename)
    expect(container.querySelector('[data-testid="product-rename-form"]')).not.toBeNull()
  })

  it('renders the Brochures QA tab from ?tab=brochures-qa (#673)', () => {
    mockTab = 'brochures-qa'
    const { container } = renderCatalog()
    expect(container.textContent).toContain('catalog.brochuresQaLead')
    expect(container.textContent).toContain('Lotte Mart')
    expect(container.querySelector('input[type="search"]')).toBeNull()
    expect(container.querySelector('[data-testid="duplicate-names-panel"]')).toBeNull()
    // Tab state follows the search param.
    expect(tabByText(container, 'catalog.tabBrochuresQa').getAttribute('aria-pressed')).toBe('true')
    expect(usePriceBrochures).toHaveBeenCalled()
  })

  it('links the brochure card into the admin viewer in a new tab (#716)', () => {
    mockTab = 'brochures-qa'
    const { container } = renderCatalog()
    const card = container.querySelector('[data-testid="brochure-card"]')
    // The card itself is the link: ?admin=true switches the viewer's items
    // panel into the QA variant with the expandable metadata rows.
    expect(card.tagName).toBe('A')
    expect(card.getAttribute('target')).toBe('_blank')
    expect(card.getAttribute('rel')).toBe('noreferrer')
    expect(card.getAttribute('href')).toBe(
      '/brochures/view?store=lotte-mart&date=20261029&file=page_1_2ad1c95b.jpg&admin=true'
    )
    // The QA affordances moved into the new tab — the tab itself renders no
    // items table and never navigates the admin area.
    expect(container.querySelector('[data-testid="brochure-product-row"]')).toBeNull()
    expect(useBrochureProducts).not.toHaveBeenCalled()
    expect(navigateMock).not.toHaveBeenCalled()
    expect(mockHash).toBe('')
  })

  it('renders the Promos tab from ?tab=promos with the Review surface by default (#717)', () => {
    mockTab = 'promos'
    const { container } = renderCatalog()
    expect(container.textContent).toContain('catalog.promosReviewLead')
    // The review table lists the verbatim chips per row; the class tags ride
    // beneath them (the #717 review is the tab's purpose, so it mounts first).
    expect(container.textContent).toContain('DISKON 20%')
    expect(container.textContent).toContain('Harga Spesial')
    expect(container.querySelector('[data-testid="promo-review-row"]')).not.toBeNull()
    expect(container.textContent).toContain('catalog.promosViewReview')
    expect(container.textContent).toContain('catalog.promosViewCatalog')
    // The catalog read stays unmounted while Review is active.
    expect(usePricePromos).not.toHaveBeenCalled()
    expect(usePromoReview).toHaveBeenCalled()
  })

  it('switches the promos tab to the moved promo cards (#673) through the sub-view', () => {
    mockTab = 'promos'
    const { container } = renderCatalog()
    fireEvent.click(clickable(container, 'catalog.promosViewCatalog'))
    expect(container.textContent).toContain('prices.promosLead')
    expect(container.textContent).toContain('prices.promoTypeDiscountPct')
    expect(container.textContent).toContain('prices.promoTypeGetFree')
    expect(container.textContent).toContain('prices.promosTotal')
    // The sub-view is local state: the review table and the catalog cards
    // never mount together.
    expect(container.querySelector('[data-testid="promo-review-row"]')).toBeNull()
    expect(usePricePromos).toHaveBeenCalled()
  })

  it('a promos example click jumps into the user explorer at #productKey', () => {
    mockTab = 'promos'
    const { container } = renderCatalog()
    // The example cards live in the Catalog sub-view.
    fireEvent.click(clickable(container, 'catalog.promosViewCatalog'))
    // Expand the Discount % card first — example rows live inside it.
    fireEvent.click(clickable(container, 'prices.promoTypeDiscountPct'))
    expect(container.textContent).toContain('prices.showExamples')
    fireEvent.click(clickable(container, 'Minyak Goreng Bimoli'))
    // The explorer is every household user's surface; the fresh /prices mount
    // guarantees the unfiltered landing context while the hash expands the row.
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/prices',
      search: {},
      hash: OIL_KEY,
    })
  })

  it('switches tabs through the route search param', () => {
    const { container } = renderCatalog()
    fireEvent.click(tabByText(container, 'catalog.tabBrochuresQa'))
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/admin/catalog',
      search: { tab: 'brochures-qa' },
      hash: '',
    })

    mockTab = 'brochures-qa'
    const qaView = renderCatalog()
    fireEvent.click(tabByText(qaView.container, 'catalog.tabPromos'))
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/admin/catalog',
      search: { tab: 'promos' },
      hash: '',
    })

    mockTab = 'promos'
    const promosView = renderCatalog()
    fireEvent.click(tabByText(promosView.container, 'catalog.tabProducts'))
    expect(navigateMock).toHaveBeenLastCalledWith({ to: '/admin/catalog', search: {}, hash: '' })
  })

  it('opens and expands a #productKey deep link on the Products tab', () => {
    mockTab = 'brochures-qa'
    mockHash = `#${OIL_KEY}`
    const { container } = renderCatalog()
    // The hash wins over ?tab=brochures-qa: the product detail is expanded.
    expect(container.textContent).toContain('prices.currentPrices')
    expect(container.querySelector('input[type="search"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="brochure-card"]')).toBeNull()
    expect(tabByText(container, 'catalog.tabProducts').getAttribute('aria-pressed')).toBe('true')
    // Applying the deep link never writes the hash back.
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('hard-removes the retired brochures tab value (#673)', () => {
    mockTab = 'brochures'
    const { container } = renderCatalog()
    // ?tab=brochures is no longer a tab: the resolver falls back to Products
    // and no QA surface mounts.
    expect(container.textContent).toContain('catalog.lead')
    expect(container.querySelector('input[type="search"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="brochure-card"]')).toBeNull()
    expect(tabByText(container, 'catalog.tabProducts').getAttribute('aria-pressed')).toBe('true')
    expect(usePriceBrochures).not.toHaveBeenCalled()
  })
})
