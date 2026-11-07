import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { ProductsView } from './ProductsView.jsx'

// The product explorer's admin rename surface (#423): the action lives inside
// the expanded price detail and is gated on me.isAdmin. Everything below the
// fold (search, sort, grouping) is covered by Prices.test.jsx, which renders
// this view through the page shell.
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ hash: '' }),
}))

vi.mock('../lib/queries/index.js', () => ({
  usePrices: vi.fn(),
  usePriceSources: vi.fn(),
  usePriceMeta: vi.fn(),
  usePriceDetail: vi.fn(),
}))

vi.mock('../lib/queries/me.js', () => ({ useMe: vi.fn() }))

vi.mock('../lib/queries/products.js', () => ({
  useProductIdentity: vi.fn(),
  useRenameProduct: vi.fn(),
  useRevertRename: vi.fn(),
  useDecideAlias: vi.fn(),
}))

import { usePrices, usePriceSources, usePriceMeta, usePriceDetail } from '../lib/queries/index.js'
import { useMe } from '../lib/queries/me.js'
import {
  useProductIdentity,
  useRenameProduct,
  useRevertRename,
  useDecideAlias,
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

function renderProducts() {
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
        category: null,
        setCategory: vi.fn(),
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

describe('ProductsView admin rename action (#423)', () => {
  beforeEach(() => {
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
        aliases: [],
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
    vi.mocked(useMe).mockReturnValue({ data: { user: { isAdmin: true } } })
  })

  it('offers no rename action until the product detail is expanded', () => {
    const { container } = renderProducts()
    expect(renameToggle(container)).toBeUndefined()
    expect(useProductIdentity).not.toHaveBeenCalled()
  })

  it('opens the shared rename form for the expanded product as an admin', () => {
    const { container } = renderProducts()
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
    // The price detail stays usable underneath the open form.
    expect(container.textContent).toContain('prices.currentPrices')

    fireEvent.click(renameToggle(container))
    expect(container.querySelector('[data-testid="product-rename-form"]')).toBeNull()
  })

  it('hides the rename action from a non-admin shopper', () => {
    vi.mocked(useMe).mockReturnValue({ data: { user: { isAdmin: false } } })
    const { container } = renderProducts()
    fireEvent.click(productRow(container))
    expect(container.textContent).toContain('prices.currentPrices')
    expect(renameToggle(container)).toBeUndefined()
    expect(useProductIdentity).not.toHaveBeenCalled()
  })
})
