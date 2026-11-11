import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { ProductsView } from './ProductsView.jsx'
import { formatPrice } from '../lib/pricesHelpers.js'

// The product explorer is shared by /prices (read-only) and /admin/catalog
// (admin tools, issue #631): the admin rename surface (#423) and the
// identity/QA panels (#485, #515) render only when the page opts in with
// adminTools. Everything below the fold (search, sort, grouping) is covered
// by Prices.test.jsx, which renders this view through the page shell.
const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({ hash: '' }),
}))

vi.mock('../lib/queries/index.js', () => ({
  usePrices: vi.fn(),
  usePriceSources: vi.fn(),
  usePriceMeta: vi.fn(),
  usePriceDetail: vi.fn(),
}))

vi.mock('../lib/queries/products.js', () => ({
  useProductIdentity: vi.fn(),
  useRenameProduct: vi.fn(),
  useRevertRename: vi.fn(),
  useDecideAlias: vi.fn(),
  useDuplicateProductNames: vi.fn(),
  useAliasCandidateCounts: vi.fn(),
  useBulkApproveExactAliases: vi.fn(),
}))

import { usePrices, usePriceSources, usePriceMeta, usePriceDetail } from '../lib/queries/index.js'
import {
  useProductIdentity,
  useRenameProduct,
  useRevertRename,
  useDecideAlias,
  useDuplicateProductNames,
  useAliasCandidateCounts,
  useBulkApproveExactAliases,
} from '../lib/queries/products.js'

const PRODUCT_KEY = 'minyak-goreng--bimoli--1-l'

const mockItems = [
  {
    product_key: PRODUCT_KEY,
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
    product_key: PRODUCT_KEY,
    name: 'Minyak Goreng Bimoli',
    brand: 'Bimoli',
    unit: '1 L',
    source_slug: 'superindo',
    source_name: 'Superindo',
    price: 21500,
    effective_unit_price: 21500,
    promo_label: null,
    low_confidence: false,
  },
]

function renderProducts({
  adminTools = false,
  basePath = '/prices',
  category = null,
  setCategory = vi.fn(),
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(ProductsView, {
        search: '',
        setSearch: vi.fn(),
        source: null,
        setSource: vi.fn(),
        category,
        setCategory,
        adminTools,
        basePath,
      })
    )
  )
}

// The product card itself is the row <button> (its label carries the name).
function productRow(container) {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent.includes('Minyak Goreng Bimoli')
  )
}

function renameToggle(container) {
  return [...container.querySelectorAll('button')].find((button) =>
    ['rename.action', 'rename.close'].includes(button.textContent)
  )
}

describe('ProductsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Element.prototype.scrollIntoView = vi.fn()
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
    vi.mocked(usePriceDetail).mockReturnValue({
      data: {
        current: [
          {
            source_slug: 'lotte-mart',
            source_name: 'Lotte Mart',
            price: 23000,
            effective_unit_price: 23000,
            unit: '1 L',
          },
        ],
        history: [],
      },
      isLoading: false,
    })
    vi.mocked(useProductIdentity).mockReturnValue({
      data: {
        product: {
          productKey: PRODUCT_KEY,
          name: 'Minyak Goreng Bimoli',
          brand: 'Bimoli',
          unit: '1 L',
          status: 'provisional',
          metadataVersion: 2,
        },
        // A candidate alias makes the shared form's admin-only decision
        // actions observable here (#489): the page's adminTools must reach
        // them.
        aliases: [
          {
            id: 'alias-candidate',
            name: 'Minyak Goreng Bimoli 1 L',
            storeSlug: 'lotte-mart',
            status: 'candidate',
            source: 'ocr',
            firstSeenAt: '2026-10-25T00:00:00Z',
            lastSeenAt: '2026-10-28T00:00:00Z',
          },
        ],
        stats: { observations: 4, stores: 2 },
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
      data: { candidates: 12, exactCandidates: 3 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    vi.mocked(useBulkApproveExactAliases).mockReturnValue({ mutate: vi.fn(), isPending: false })
  })

  it('hides the category picker until meta carries categories (#373/#632)', () => {
    const { container } = renderProducts()
    expect(container.querySelector('[data-testid="prices-category-filter"]')).toBeNull()
  })

  it('renders the searchable category picker and reports the chosen slug', () => {
    vi.mocked(usePriceMeta).mockReturnValue({
      data: { latestScrapedAt: new Date().toISOString(), categories: ['beras', 'minyak-goreng'] },
    })
    const setCategory = vi.fn()
    const { container } = renderProducts({ setCategory })
    const filter = container.querySelector('[data-testid="prices-category-filter"]')
    expect(filter).not.toBeNull()

    fireEvent.click(within(filter).getByRole('button', { name: /prices\.allCategories/ }))
    fireEvent.change(
      within(filter).getByRole('combobox', { name: 'prices.categorySearchPlaceholder' }),
      { target: { value: 'goreng' } }
    )
    expect(
      within(filter)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['prices.allCategories', 'minyak-goreng'])
    fireEvent.click(within(filter).getByRole('option', { name: 'minyak-goreng' }))

    // Same contract the chip group had: the shell's setCategory gets the raw
    // sealed taxonomy slug (null clears), so /prices and /admin/catalog share
    // one filter behaviour.
    expect(setCategory).toHaveBeenCalledWith('minyak-goreng')
    // The picker is controlled: the trigger re-renders from the shell's
    // `category` prop (Prices/AdminCatalog own that state — see the page
    // suites), so the spy call is the contract here.
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('renders no admin surface by default (the /prices read-only mode)', () => {
    const { container } = renderProducts()
    expect(container.querySelector('[data-testid="duplicate-names-panel"]')).toBeNull()
    expect(container.querySelector('[data-testid="alias-candidates-panel"]')).toBeNull()

    fireEvent.click(productRow(container))
    expect(container.textContent).toContain('prices.currentPrices')
    // #631: rename lives on /admin/catalog only; the default view never
    // offers it and never triggers the identity read behind it.
    expect(renameToggle(container)).toBeUndefined()
    expect(useProductIdentity).not.toHaveBeenCalled()
    expect(useDuplicateProductNames).not.toHaveBeenCalled()
    expect(useAliasCandidateCounts).not.toHaveBeenCalled()
  })

  it('opens the shared rename form for the expanded product when the page opts in', () => {
    const { container } = renderProducts({ adminTools: true })
    fireEvent.click(productRow(container))

    const toggle = renameToggle(container)
    expect(toggle).not.toBeUndefined()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)

    expect(useProductIdentity).toHaveBeenCalledWith(PRODUCT_KEY, { enabled: true })
    const form = container.querySelector('[data-testid="product-rename-form"]')
    expect(form).not.toBeNull()
    expect(container.querySelector('[data-testid="rename-current-name"]').textContent).toBe(
      'Minyak Goreng Bimoli'
    )
    // #489: the page's admin flag reaches the shared form; without it the
    // candidate row would stay read-only for an admin.
    expect([...form.querySelectorAll('button')].map((button) => button.textContent)).toContain(
      'rename.aliasApprove'
    )
    // The price detail stays usable underneath the open form.
    expect(container.textContent).toContain('prices.currentPrices')

    fireEvent.click(renameToggle(container))
    expect(container.querySelector('[data-testid="product-rename-form"]')).toBeNull()
  })

  it('mounts the alias-candidates bulk action when the page opts in (#515)', () => {
    const admin = renderProducts({ adminTools: true })
    const panel = admin.container.querySelector('[data-testid="alias-candidates-panel"]')
    expect(panel).not.toBeNull()
    // The counts the confirm names are on screen before anything is clicked.
    expect(panel.querySelector('[data-testid="alias-candidate-exact"]').textContent).toBe('3')
    expect(useAliasCandidateCounts).toHaveBeenCalledTimes(1)
  })

  it('mounts the read-only duplicate-name report when the page opts in (#485)', () => {
    const { container } = renderProducts({ adminTools: true })
    expect(container.querySelector('[data-testid="duplicate-names-panel"]')).not.toBeNull()
    // Collapsed: the page never fetches the catalog-wide report on mount.
    expect(useDuplicateProductNames).toHaveBeenCalledWith({ enabled: false })
  })

  it('writes the #productKey deep link to the route that owns the view', () => {
    const defaults = renderProducts()
    fireEvent.click(productRow(defaults.container))
    expect(navigateMock).toHaveBeenLastCalledWith({
      to: '/prices',
      hash: PRODUCT_KEY,
      replace: true,
    })
    defaults.unmount()

    navigateMock.mockClear()
    const admin = renderProducts({ adminTools: true, basePath: '/admin/catalog' })
    fireEvent.click(productRow(admin.container))
    expect(navigateMock).toHaveBeenLastCalledWith({
      to: '/admin/catalog',
      hash: PRODUCT_KEY,
      replace: true,
    })
    fireEvent.click(productRow(admin.container))
    expect(navigateMock).toHaveBeenLastCalledWith({ to: '/admin/catalog', hash: '', replace: true })
  })

  it('leaves shelf-only rows unchanged — no member label or reference (#627)', () => {
    const { container } = renderProducts()
    expect(container.textContent).not.toContain('prices.memberPrice')
    expect(container.querySelector('[data-testid="shelf-reference-price"]')).toBeNull()
  })

  it('headlines the member price with a Member label and the shelf reference (#627)', () => {
    vi.mocked(usePrices).mockReturnValue({
      data: {
        items: [
          {
            product_key: PRODUCT_KEY,
            name: 'Minyak Goreng Bimoli',
            brand: 'Bimoli',
            unit: '1 L',
            source_slug: 'superindo',
            source_name: 'Superindo',
            price: 21500,
            member_price: 19900,
            effective_unit_price: 21500,
            unit_qty: 1000,
            unit_qty_unit: 'ml',
            // Shelf-derived per-unit hint — must not ride beside the member
            // headline (v1 limitation documented in the view).
            unit_price: 21500,
            promo_label: null,
            low_confidence: false,
          },
        ],
        total: 1,
        truncated: false,
      },
      isLoading: false,
      isError: false,
    })
    vi.mocked(usePriceDetail).mockReturnValue({
      data: {
        current: [
          {
            source_slug: 'superindo',
            source_name: 'Superindo',
            price: 21500,
            member_price: 19900,
            effective_unit_price: 21500,
            unit: '1 L',
          },
        ],
        history: [],
      },
      isLoading: false,
    })

    const { container } = renderProducts()
    fireEvent.click(productRow(container))

    expect(container.textContent).toContain(formatPrice(19900))
    expect(container.textContent).toContain('prices.memberPrice')
    // The shelf price is the reference, struck because the member price is
    // lower. The row and its expanded detail each render it.
    const references = [...container.querySelectorAll('[data-testid="shelf-reference-price"]')]
    expect(references.length).toBeGreaterThanOrEqual(2)
    for (const reference of references) {
      expect(reference.textContent).toBe(formatPrice(21500))
      expect(reference.className).toContain('line-through')
    }
    // The shelf-derived per-unit hint is suppressed on a member row.
    expect(container.textContent).not.toContain('prices.unitPrice')
  })

  it('never headlines or labels a member premium above the shelf price (#627)', () => {
    vi.mocked(usePrices).mockReturnValue({
      data: {
        items: [
          {
            product_key: PRODUCT_KEY,
            name: 'Minyak Goreng Bimoli',
            brand: 'Bimoli',
            unit: '1 L',
            source_slug: 'superindo',
            source_name: 'Superindo',
            price: 21500,
            // A member price above the shelf price must not raise the
            // displayed price or earn the Member badge.
            member_price: 24900,
            effective_unit_price: 21500,
            unit_qty: 1000,
            unit_qty_unit: 'ml',
            unit_price: 21500,
            promo_label: null,
            low_confidence: false,
          },
        ],
        total: 1,
        truncated: false,
      },
      isLoading: false,
      isError: false,
    })
    vi.mocked(usePriceDetail).mockReturnValue({
      data: {
        current: [
          {
            source_slug: 'superindo',
            source_name: 'Superindo',
            price: 21500,
            member_price: 24900,
            effective_unit_price: 21500,
            unit: '1 L',
          },
        ],
        history: [],
      },
      isLoading: false,
    })

    const { container } = renderProducts()
    fireEvent.click(productRow(container))

    expect(container.textContent).toContain(formatPrice(21500))
    expect(container.textContent).not.toContain('prices.memberPrice')
    expect(container.querySelector('[data-testid="shelf-reference-price"]')).toBeNull()
    // The shelf-derived per-unit hint is truthful on this (shelf) headline.
    expect(container.textContent).toContain('prices.unitPrice')
  })

  it('normalizes names, brands, units and promo badges in the row (#633)', () => {
    vi.mocked(usePrices).mockReturnValue({
      data: {
        items: [
          {
            product_key: 'mangga--bintang--300-ml',
            name: 'MANGGA HARUM MANIS BINTANG',
            brand: 'Bintang',
            unit: '300ml',
            source_slug: 'lotte-mart',
            source_name: 'Lotte Mart',
            price: 21500,
            effective_unit_price: 21500,
            promo_label: null,
            low_confidence: false,
          },
          {
            product_key: 'ron-88--spring--300-ml',
            name: 'RON 88 Spring 300ml',
            brand: 'RON 88',
            unit: '300ml',
            source_slug: 'superindo',
            source_name: 'Superindo',
            price: 23000,
            effective_unit_price: 23000,
            promo_label: null,
            low_confidence: false,
          },
          {
            product_key: 'gula-pasir--gulaku--1-kg',
            name: 'GULA PASIR',
            brand: 'Gulaku',
            unit: '1kg',
            source_slug: 'lotte-mart',
            source_name: 'Lotte Mart',
            price: 18000,
            effective_unit_price: 18000,
            promo_label: 'DISKON 50%;PROMO 1 HARI!',
            low_confidence: false,
          },
        ],
        total: 3,
        truncated: false,
      },
      isLoading: false,
      isError: false,
    })
    const { container } = renderProducts()

    const rowWith = (text) =>
      [...container.querySelectorAll('button')].find((button) => button.textContent.includes(text))

    const manggaRow = rowWith('Mangga Harum Manis Bintang')
    expect(manggaRow).toBeTruthy()
    expect(container.textContent).not.toContain('MANGGA HARUM MANIS BINTANG')
    expect(manggaRow.textContent).toContain('300 ml')

    // The name already carries RON 88 — the brand suffix must not repeat it.
    const ronRow = rowWith('RON 88 Spring')
    expect(ronRow.textContent).toContain('RON 88 Spring 300 ml')
    expect(ronRow.textContent.match(/RON 88/g)).toHaveLength(1)
    expect(ronRow.textContent).not.toContain('· RON 88')

    // No duplicate brand, canonical unit spacing, and one badge per segment.
    const gulaRow = rowWith('Gula Pasir')
    expect(gulaRow.textContent).toContain('Gula Pasir · Gulaku')
    expect(gulaRow.textContent).toContain('1 kg ·')
    expect(gulaRow.textContent).toContain('Diskon 50%')
    expect(gulaRow.textContent).toContain('Promo 1 Hari!')
  })
})
