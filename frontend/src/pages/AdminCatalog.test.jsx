import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { AdminCatalog } from './AdminCatalog.jsx'

// The admin catalog (#631) is the home of the tools moved off /prices: the
// Brochures ingestion-QA view and the Products lookup with rename,
// duplicate-names, and alias-candidates. The route guard is the AdminPrices
// pattern (useMe + unauthorized state; the APIs are already requireAdmin).
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
}))

vi.mock('../lib/queries/me.js', () => ({ useMe: vi.fn() }))

// The admin tools (rename form, duplicate report, alias bulk action) import
// these; the panels stay lazy, so the tests below pin when they fetch.
vi.mock('../lib/queries/products.js', () => ({
  useProductIdentity: vi.fn(),
  useRenameProduct: vi.fn(),
  useRevertRename: vi.fn(),
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
} from '../lib/queries/index.js'
import { useMe } from '../lib/queries/me.js'
import {
  useProductIdentity,
  useRenameProduct,
  useRevertRename,
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

// The tab param is mocked, so switching sections in a test means rerendering
// the same tree (component state — the page-owned filters — must survive).
function rerenderCatalog(utils) {
  utils.rerender(
    React.createElement(
      QueryClientProvider,
      { client: utils._queryClient },
      React.createElement(AdminCatalog, null)
    )
  )
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
  })

  it('renders the Products tab with the moved admin tools by default', () => {
    const { container } = renderCatalog()
    expect(container.textContent).toContain('catalog.lead')
    const [productsTab, brochuresTab] = tabs(container)
    expect(productsTab.textContent).toBe('catalog.tabProducts')
    expect(productsTab.getAttribute('aria-pressed')).toBe('true')
    expect(brochuresTab.textContent).toBe('catalog.tabBrochures')
    expect(brochuresTab.getAttribute('aria-pressed')).toBe('false')

    // Product lookup + the identity/QA panels moved from the user page.
    expect(container.querySelector('input[type="search"]')).toBeTruthy()
    expect(container.textContent).toContain('Minyak Goreng Bimoli')
    expect(container.querySelector('[data-testid="duplicate-names-panel"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="alias-candidates-panel"]')).not.toBeNull()
    // The Brochures read stays unmounted on this tab.
    expect(usePriceBrochures).not.toHaveBeenCalled()
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

  it('renders the Brochures tab from ?tab=brochures', () => {
    mockTab = 'brochures'
    const { container } = renderCatalog()
    expect(container.textContent).toContain('Lotte Mart')
    expect(container.querySelector('input[type="search"]')).toBeNull()
    expect(container.querySelector('[data-testid="duplicate-names-panel"]')).toBeNull()
    // Tab state follows the search param.
    expect(tabByText(container, 'catalog.tabBrochures').getAttribute('aria-pressed')).toBe('true')
    expect(usePriceBrochures).toHaveBeenCalled()
  })

  it('brochure example click stays inside the admin area with the product hash', () => {
    mockTab = 'brochures'
    const { container } = renderCatalog()
    fireEvent.click(container.querySelector('button[aria-expanded]'))
    fireEvent.click(clickable(container, 'Minyak Goreng Bimoli'))
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/admin/catalog',
      search: {},
      hash: OIL_KEY,
      replace: false,
    })
    expect(mockHash).toBe(`#${OIL_KEY}`)
  })

  it('switches tabs through the route search param', () => {
    const { container } = renderCatalog()
    fireEvent.click(tabByText(container, 'catalog.tabBrochures'))
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/admin/catalog',
      search: { tab: 'brochures' },
      hash: '',
    })

    mockTab = 'brochures'
    const brochuresView = renderCatalog()
    fireEvent.click(tabByText(brochuresView.container, 'catalog.tabProducts'))
    expect(navigateMock).toHaveBeenLastCalledWith({ to: '/admin/catalog', search: {}, hash: '' })
  })

  it('clears the lookup filters when a brochure example jumps (#631 review)', () => {
    vi.mocked(usePriceMeta).mockReturnValue({
      data: {
        latestScrapedAt: new Date().toISOString(),
        categories: ['beras', 'minyak-goreng'],
      },
    })
    const utils = renderCatalog()
    const { container } = utils
    // Prime the page-owned filters through the Products tab — the jump must
    // clear exactly these, not just the view.
    fireEvent.change(container.querySelector('input[type="search"]'), {
      target: { value: 'minyak' },
    })
    fireEvent.click(clickable(container, 'Lotte Mart'))
    fireEvent.click(clickable(container, 'minyak-goreng'))
    expect(vi.mocked(usePrices).mock.calls.at(-1)[0]).toEqual({
      q: undefined,
      source: 'lotte-mart',
      category: 'minyak-goreng',
      sort: 'cheapest',
    })

    mockTab = 'brochures'
    rerenderCatalog(utils)
    fireEvent.click(container.querySelector('button[aria-expanded]'))
    fireEvent.click(clickable(container, 'Minyak Goreng Bimoli'))
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/admin/catalog',
      search: {},
      hash: OIL_KEY,
      replace: false,
    })

    // The hash forces the Products tab; the landing context is the
    // unfiltered list, so the target is guaranteed to be inside the 200.
    rerenderCatalog(utils)
    expect(container.querySelector('input[type="search"]').value).toBe('')
    expect(vi.mocked(usePrices).mock.calls.at(-1)[0]).toEqual({
      q: undefined,
      source: null,
      category: undefined,
      sort: 'cheapest',
    })
  })

  it('opens and expands a #productKey deep link on the Products tab', () => {
    mockTab = 'brochures'
    mockHash = `#${OIL_KEY}`
    const { container } = renderCatalog()
    // The hash wins over ?tab=brochures: the product detail is expanded.
    expect(container.textContent).toContain('prices.currentPrices')
    expect(container.querySelector('input[type="search"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="brochure-card"]')).toBeNull()
    expect(tabByText(container, 'catalog.tabProducts').getAttribute('aria-pressed')).toBe('true')
    // Applying the deep link never writes the hash back.
    expect(navigateMock).not.toHaveBeenCalled()
  })
})
