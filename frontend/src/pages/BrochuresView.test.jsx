import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { BrochuresView } from './BrochuresView.jsx'

vi.mock('../lib/queries/index.js', () => ({
  usePriceBrochures: vi.fn(),
}))

import { usePriceBrochures } from '../lib/queries/index.js'

const OIL_KEY = 'minyak-goreng--bimoli--1-l'
const RICE_KEY = 'beras--pandan-wangi--5-kg'

const brochureUrlA = '/api/brochures/lotte-mart/20261029/page_1_2ad1c95b.jpg'
const brochureUrlB = '/api/brochures/superindo/20261029/koran_a_1b2c3d4e.jpg'

// API order: store name asc, date desc, url asc — the view slices adjacent
// same-source runs into sections with no client re-sort.
const mockGroups = [
  {
    source_slug: 'lotte-mart',
    source_name: 'Lotte Mart',
    brochure_url: brochureUrlA,
    observed_date: '2026-10-29',
    product_count: 2,
    example_products: [
      {
        product_key: OIL_KEY,
        name: 'Minyak Goreng Bimoli',
        brand: 'Bimoli',
        unit: '1 L',
        price: 21500,
        effective_unit_price: 19000,
      },
    ],
  },
  {
    source_slug: 'superindo',
    source_name: 'Superindo',
    brochure_url: brochureUrlB,
    observed_date: '2026-10-28',
    product_count: 1,
    example_products: [
      {
        product_key: RICE_KEY,
        name: 'Beras Pandan Wangi 5 kg',
        brand: 'Pandan Wangi',
        unit: '5 kg',
        price: 72000,
        effective_unit_price: null,
      },
    ],
  },
]

function renderView() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(BrochuresView, { onJump: onJumpMock })
    )
  )
}

const onJumpMock = vi.fn()

describe('BrochuresView', () => {
  beforeEach(() => {
    onJumpMock.mockClear()
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: { groups: mockGroups },
      isLoading: false,
      isError: false,
    })
  })

  it('renders store sections in API order with date headings', () => {
    const { container } = renderView()
    expect(container.textContent).toContain('Lotte Mart')
    expect(container.textContent).toContain('Superindo')
    // Section order follows the API (Lotte first) despite date order.
    const headings = [...container.querySelectorAll('h3')].map((h) => h.textContent)
    expect(headings).toEqual(['Lotte Mart', 'Superindo'])
  })

  it('loads images lazily inside a 3:4 frame with an alt label', () => {
    const { container } = renderView()
    const img = container.querySelector('img')
    expect(img).toBeTruthy()
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(img.getAttribute('src')).toBe(brochureUrlA)
    expect(img.getAttribute('alt')).toBe('prices.brochureAlt')
    expect(img.closest('[style]')?.getAttribute('style')).toContain('3 / 4')
  })

  it('renders the fallback block in the same frame when the image fails', () => {
    const { container } = renderView()
    const img = container.querySelector(`img[src="${brochureUrlA}"]`)
    fireEvent.error(img)
    // The failed img is gone; the other card's image is untouched; the frame
    // still shows store + count (a 404 degrades to fallback, never a
    // broken-image glyph).
    expect(container.querySelector(`img[src="${brochureUrlA}"]`)).toBeNull()
    expect(container.querySelector(`img[src="${brochureUrlB}"]`)).toBeTruthy()
    const fallback = container.querySelector('[style*="3 / 4"]')
    expect(fallback.textContent).toContain('Lotte Mart')
    expect(fallback.textContent).toContain('prices.productsCount')
  })

  it('toggles example rows independently (multi-expand)', () => {
    const { container } = renderView()
    const cards = [...container.querySelectorAll('button[aria-expanded]')]
    expect(cards).toHaveLength(2)

    fireEvent.click(cards[0])
    const afterFirst = [...container.querySelectorAll('button[aria-expanded]')]
    expect(afterFirst[0].getAttribute('aria-expanded')).toBe('true')
    expect(afterFirst[1].getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).toContain('Minyak Goreng Bimoli')
    expect(container.textContent).not.toContain('Beras Pandan Wangi')

    fireEvent.click(afterFirst[1])
    const afterSecond = [...container.querySelectorAll('button[aria-expanded]')]
    // Both open — a browse view never collapses one card by opening another.
    expect(afterSecond[0].getAttribute('aria-expanded')).toBe('true')
    expect(afterSecond[1].getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('Beras Pandan Wangi')
  })

  it('clicking an example jumps with the product key', () => {
    const { container } = renderView()
    fireEvent.click(container.querySelector('button[aria-expanded]'))
    fireEvent.click(
      [...container.querySelectorAll('button')].find((b) =>
        b.textContent.includes('Minyak Goreng Bimoli')
      )
    )
    expect(onJumpMock).toHaveBeenCalledWith(OIL_KEY)
  })

  it('renders every example row the API sends (the backend caps at five)', () => {
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: {
        groups: [
          {
            ...mockGroups[0],
            example_products: Array.from({ length: 5 }, (_, i) => ({
              product_key: `bulk-${i}--acme--1-pcs`,
              name: `Bulk ${i}`,
              brand: null,
              unit: null,
              price: 1000 + i,
              effective_unit_price: null,
            })),
          },
        ],
      },
      isLoading: false,
      isError: false,
    })
    const { container } = renderView()
    fireEvent.click(container.querySelector('button[aria-expanded]'))
    const rows = [...container.querySelectorAll('button')].filter((b) =>
      b.textContent.includes('Bulk ')
    )
    expect(rows).toHaveLength(5)
  })

  it('renders the empty state without sections', () => {
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: { groups: [] },
      isLoading: false,
      isError: false,
    })
    const { container } = renderView()
    expect(container.textContent).toContain('prices.brochuresEmpty')
    expect(container.textContent).toContain('prices.brochuresEmptyDesc')
    expect(container.querySelectorAll('img')).toHaveLength(0)
  })

  it('renders the offline banner pattern on error', () => {
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    })
    const { container } = renderView()
    expect(container.textContent).toContain('offline.banner')
  })

  it('renders skeletons while loading', () => {
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    })
    const { container } = renderView()
    expect(container.querySelector('.bg-surface-inset')).toBeTruthy()
    expect(container.querySelector('h3')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })
})
