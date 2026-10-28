import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { PromosView } from './PromosView.jsx'

vi.mock('../lib/queries/index.js', () => ({
  usePricePromos: vi.fn(),
  usePriceSources: vi.fn(),
}))

import { usePricePromos, usePriceSources } from '../lib/queries/index.js'

const OIL_KEY = 'minyak-goreng--bimoli--1-l'
const SUGAR_KEY = 'gula-pasir--gulaku--1-kg'

const catalog = {
  types: [
    {
      promo_type: 'discount_pct',
      product_count: 2,
      stores: { 'lotte-mart': 1, superindo: 1 },
      example_products: [
        {
          product_key: SUGAR_KEY,
          name: 'Gula Pasir Gulaku 1 kg',
          brand: 'Gulaku',
          unit: '1 kg',
          source_slug: 'superindo',
          source_name: 'Superindo',
          price: 41000,
          effective_unit_price: 36000,
        },
      ],
    },
    {
      promo_type: 'get_free',
      product_count: 1,
      stores: { superindo: 1 },
      example_products: [],
    },
    {
      promo_type: 'other',
      product_count: 1,
      stores: { astro: 1 },
      example_products: [
        {
          product_key: OIL_KEY,
          name: 'Minyak Goreng Bimoli',
          brand: 'Bimoli',
          unit: '1 L',
          source_slug: 'astro',
          source_name: 'Astro',
          price: 32000,
          effective_unit_price: null,
        },
      ],
    },
  ],
  total: 4,
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
}

function renderPromos(props = {}) {
  return render(
    React.createElement(
      QueryClientProvider,
      { client: createQueryClient() },
      React.createElement(PromosView, { onJump: vi.fn(), ...props })
    )
  )
}

// The suite's i18n mock returns raw keys, so assertions match keys and
// untranslated data (store names, slug fallbacks).
function findClickable(container, text) {
  return [...container.querySelectorAll('button, span')].find((el) => el.textContent.includes(text))
}

describe('PromosView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(usePriceSources).mockReturnValue({
      data: [
        { slug: 'lotte-mart', name: 'Lotte Mart' },
        { slug: 'superindo', name: 'Superindo' },
      ],
    })
    vi.mocked(usePricePromos).mockReturnValue({
      data: catalog,
      isLoading: false,
      isError: false,
    })
  })

  it('renders one card per group in the fixed API order with i18n labels', () => {
    const { container } = renderPromos()
    const labels = [...container.querySelectorAll('.font-medium')].map((el) => el.textContent)
    expect(labels).toEqual([
      'prices.promoTypeDiscountPct',
      'prices.promoTypeGetFree',
      'prices.promoTypeOther',
    ])
    expect(container.textContent).toContain('prices.promosTotal')
  })

  it('shows a product-count badge and per-source badges with resolved names', () => {
    const { container } = renderPromos()
    expect(container.textContent).toContain('prices.productsCount')
    expect(container.textContent).toContain('Lotte Mart 1')
    expect(container.textContent).toContain('Superindo 1')
  })

  it('falls back to the raw slug for sources missing from the chip bar', () => {
    const { container } = renderPromos()
    // astro has no usePriceSources entry — the slug text shows, no hardcode.
    expect(container.textContent).toContain('astro 1')
  })

  it('expands cards independently (multi-expand)', () => {
    const { container } = renderPromos()
    fireEvent.click(findClickable(container, 'prices.promoTypeDiscountPct'))
    fireEvent.click(findClickable(container, 'prices.promoTypeOther'))
    // Both cards stay expanded; each shows its example row.
    expect(container.textContent).toContain('Gula Pasir Gulaku 1 kg')
    expect(container.textContent).toContain('Minyak Goreng Bimoli')

    // Collapsing one leaves the other open.
    fireEvent.click(findClickable(container, 'prices.promoTypeDiscountPct'))
    expect(container.textContent).not.toContain('Gula Pasir Gulaku 1 kg')
    expect(container.textContent).toContain('Minyak Goreng Bimoli')
  })

  it('shows the per-unit line only when the effective price differs', () => {
    const { container } = renderPromos()
    fireEvent.click(findClickable(container, 'prices.promoTypeDiscountPct'))
    // effective 36000 ≠ price 41000 with unit → per-unit line.
    expect(container.textContent).toContain('prices.perUnit')
  })

  it('calls onJump with the product key when an example is clicked', () => {
    const onJump = vi.fn()
    const { container } = renderPromos({ onJump })
    fireEvent.click(findClickable(container, 'prices.promoTypeDiscountPct'))
    fireEvent.click(findClickable(container, 'Gula Pasir Gulaku 1 kg'))
    expect(onJump).toHaveBeenCalledWith(SUGAR_KEY)
  })

  it('renders the empty state when no promo observations exist', () => {
    vi.mocked(usePricePromos).mockReturnValue({
      data: { types: [], total: 0 },
      isLoading: false,
      isError: false,
    })
    const { container } = renderPromos()
    expect(container.textContent).toContain('prices.promosEmpty')
    expect(container.textContent).toContain('prices.promosEmptyDesc')
    expect(container.textContent).not.toContain('prices.promosTotal')
  })

  it('renders the offline banner on error and skeletons while loading', () => {
    vi.mocked(usePricePromos).mockReturnValue({ isLoading: true })
    const loading = renderPromos()
    expect(loading.container.textContent).not.toContain('prices.promosEmpty')

    vi.mocked(usePricePromos).mockReturnValue({ isError: true, isLoading: false })
    const errored = renderPromos()
    expect(errored.container.textContent).toContain('prices.noMatch')
    expect(errored.container.textContent).toContain('offline.banner')
  })
})
