import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { Prices } from './Prices.jsx'

vi.mock('../lib/queries/index.js', () => ({
  usePrices: vi.fn(),
  usePriceSources: vi.fn(),
  usePriceDetail: vi.fn(),
}))

import { usePrices, usePriceSources, usePriceDetail } from '../lib/queries/index.js'

const mockItems = [
  {
    product_key: 'minyak-goreng--bimoli--1-l',
    name: 'Minyak Goreng Bimoli',
    brand: 'Bimoli',
    unit: '1 L',
    source_slug: 'lotte-mart',
    source_name: 'Lotte Mart',
    price: 23000,
    promo_label: 'Diskon 15%',
    match_confidence: 1.0,
    low_confidence: false,
  },
  {
    product_key: 'minyak-goreng--bimoli--1-l',
    name: 'Minyak Goreng Bimoli',
    brand: 'Bimoli',
    unit: '1 L',
    source_slug: 'superindo',
    source_name: 'Superindo',
    price: 21500,
    promo_label: null,
    match_confidence: 1.0,
    low_confidence: false,
  },
  {
    product_key: 'beras--pandan-wangi--5-kg',
    name: 'Beras Pandan Wangi',
    brand: 'Pandan Wangi',
    unit: '5 kg',
    source_slug: 'superindo',
    source_name: 'Superindo',
    price: 72000,
    promo_label: null,
    match_confidence: 0.7,
    low_confidence: true,
  },
]

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
}

function renderPrices() {
  return render(
    React.createElement(
      QueryClientProvider,
      { client: createQueryClient() },
      React.createElement(Prices, null)
    )
  )
}

// The suite's i18n mock returns raw keys, so assertions match keys and
// un-translated data (product names, store names, prices). Filter chips are
// spans, product rows are buttons — search both.
function findClickable(container, text) {
  return [...container.querySelectorAll('button, span')].find((el) => el.textContent.includes(text))
}

describe('Prices', () => {
  beforeEach(() => {
    vi.mocked(usePriceSources).mockReturnValue({
      data: [
        { slug: 'lotte-mart', name: 'Lotte Mart' },
        { slug: 'superindo', name: 'Superindo' },
      ],
    })
    vi.mocked(usePriceDetail).mockReturnValue({ data: null, isLoading: false })
    vi.mocked(usePrices).mockReturnValue({
      data: { items: mockItems, total: 3 },
      isLoading: false,
      isError: false,
    })
  })

  it('groups offers per product and shows the cheapest price', () => {
    const { container } = renderPrices()
    expect(container.textContent).toContain('Minyak Goreng Bimoli')
    expect(container.textContent).toContain('Beras Pandan Wangi')
    // Regression (input order is name-ordered, not price-ordered): the
    // alphabetically-first store (Lotte Mart, Rp 23.000) is NOT the cheapest —
    // the headline must show Superindo's Rp 21.500.
    expect(container.textContent).toContain('21.500')
    expect(container.textContent).not.toContain('23.000')
  })

  it('flags low-confidence products from the backend flag', () => {
    const { container } = renderPrices()
    expect(container.textContent).toContain('prices.lowConfidence')
  })

  it('does not flag fully confident products', () => {
    vi.mocked(usePrices).mockReturnValue({
      data: { items: mockItems.filter((item) => !item.low_confidence), total: 2 },
      isLoading: false,
      isError: false,
    })
    const { container } = renderPrices()
    expect(container.textContent).not.toContain('prices.lowConfidence')
  })

  it('expands a product into per-store detail', () => {
    vi.mocked(usePriceDetail).mockReturnValue({
      data: {
        product: { product_key: 'minyak-goreng--bimoli--1-l', name: 'Minyak Goreng Bimoli' },
        current: [
          {
            source_slug: 'lotte-mart',
            source_name: 'Lotte Mart',
            price: 23000,
            match_confidence: 1.0,
            low_confidence: false,
          },
        ],
        history: [],
      },
      isLoading: false,
    })
    const { container } = renderPrices()
    fireEvent.click(findClickable(container, 'Minyak Goreng Bimoli'))
    expect(container.textContent).toContain('prices.currentPrices')
    expect(container.textContent).toContain('Lotte Mart')
  })

  it('renders source filter chips and reacts to a filter', () => {
    const { container } = renderPrices()
    expect(container.textContent).toContain('prices.allSources')
    fireEvent.click(findClickable(container, 'Lotte Mart'))
    expect(vi.mocked(usePrices).mock.calls.at(-1)[0]).toEqual({
      q: undefined,
      source: 'lotte-mart',
    })
  })

  it('renders the empty state when nothing matches', () => {
    vi.mocked(usePrices).mockReturnValue({
      data: { items: [], total: 0 },
      isLoading: false,
      isError: false,
    })
    const { container } = renderPrices()
    expect(container.textContent).toContain('prices.noMatch')
  })
})
