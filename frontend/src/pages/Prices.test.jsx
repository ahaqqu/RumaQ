import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { Prices } from './Prices.jsx'

vi.mock('@tanstack/react-router', () => ({
  // Simulates the router: navigate writes the hash back into the location
  // the page reads, so the deep-link guard loop can be exercised.
  useNavigate: () => (options) => {
    mockHash = options.hash ? `#${options.hash}` : ''
    navigate(options)
  },
  useLocation: () => ({ hash: mockHash }),
  useSearch: () => ({ view: mockView }),
}))

vi.mock('../lib/queries/index.js', () => ({
  usePrices: vi.fn(),
  usePriceSources: vi.fn(),
  usePriceMeta: vi.fn(),
  usePriceDetail: vi.fn(),
  usePricePromos: vi.fn(),
  usePriceBrochures: vi.fn(),
}))

import {
  usePrices,
  usePriceSources,
  usePriceMeta,
  usePriceDetail,
  usePricePromos,
  usePriceBrochures,
} from '../lib/queries/index.js'

const navigate = vi.fn()
let mockHash = ''
let mockView = ''

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
    promo_label: null,
    match_confidence: 1.0,
    low_confidence: false,
  },
  {
    product_key: OIL_KEY,
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
    product_key: RICE_KEY,
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

function isoDaysFromNow(ms) {
  return new Date(Date.now() + ms).toISOString()
}

// Local YYYY-MM-DD for countdown fixtures (countdown math is local-midnight).
function localDate(offsetDays) {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
}

function renderPrices() {
  const queryClient = createQueryClient()
  const utils = render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(Prices, null)
    )
  )
  utils._queryClient = queryClient
  return utils
}

// The router mock cannot re-render on navigate — flip the mocked search
// params through a rerender instead.
function rerenderPrices(utils) {
  utils.rerender(
    React.createElement(
      QueryClientProvider,
      { client: utils._queryClient },
      React.createElement(Prices, null)
    )
  )
  return utils
}

// The suite's i18n mock returns raw keys, so assertions match keys and
// un-translated data (product names, store names, prices). Filter chips are
// spans, product rows are buttons — search both.
function findClickable(container, text) {
  return [...container.querySelectorAll('button, span')].find((el) => el.textContent.includes(text))
}

describe('Prices', () => {
  beforeEach(() => {
    mockHash = ''
    mockView = ''
    navigate.mockClear()
    Element.prototype.scrollIntoView = vi.fn()
    vi.mocked(usePriceSources).mockReturnValue({
      data: [
        { slug: 'lotte-mart', name: 'Lotte Mart' },
        { slug: 'superindo', name: 'Superindo' },
      ],
    })
    vi.mocked(usePriceMeta).mockReturnValue({
      data: { latestScrapedAt: isoDaysFromNow(-5 * 60_000), observationCount: 3 },
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
        product: { product_key: OIL_KEY, name: 'Minyak Goreng Bimoli' },
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
      sort: 'cheapest',
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

  // --- Phase B (issue #291) ---

  it('sends the explicit sort with the list query', () => {
    renderPrices()
    expect(vi.mocked(usePrices).mock.calls.at(-1)[0].sort).toBe('cheapest')
  })

  it('re-queries with the selected sort option', () => {
    const { container } = renderPrices()
    fireEvent.change(container.querySelector('select'), {
      target: { value: 'savings' },
    })
    expect(vi.mocked(usePrices).mock.calls.at(-1)[0]).toEqual({
      q: undefined,
      source: null,
      sort: 'savings',
    })
  })

  it('renders the promo badge and the Save-% badge for a ≥5% gap', () => {
    vi.mocked(usePrices).mockReturnValue({
      data: {
        items: [
          {
            product_key: OIL_KEY,
            name: 'Minyak Goreng Bimoli',
            unit: '1 L',
            source_slug: 'superindo',
            source_name: 'Superindo',
            price: 23000,
            effective_unit_price: 21500,
            promo_label: 'Diskon 15%',
            cheapest_source_slug: 'superindo',
            savings_pct: 5.3,
            match_confidence: 1.0,
            low_confidence: false,
          },
        ],
        total: 1,
      },
      isLoading: false,
      isError: false,
    })
    const { container } = renderPrices()
    expect(container.textContent).toContain('Diskon 15%')
    expect(container.textContent).toContain('prices.savePct')
  })

  it('strikes the tag price through only with promo evidence and a real cut', () => {
    vi.mocked(usePrices).mockReturnValue({
      data: {
        items: [
          {
            product_key: OIL_KEY,
            name: 'Minyak Goreng Bimoli',
            unit: '1 L',
            source_slug: 'superindo',
            source_name: 'Superindo',
            price: 23000,
            effective_unit_price: 21500,
            promo_label: 'Diskon 15%',
            cheapest_source_slug: 'superindo',
            savings_pct: 0,
            match_confidence: 1.0,
            low_confidence: false,
          },
        ],
        total: 1,
      },
      isLoading: false,
      isError: false,
    })
    const { container } = renderPrices()
    expect(container.querySelector('.line-through').textContent).toContain('23.000')
    expect(container.textContent).toContain('21.500')
  })

  it('shows no strikethrough when a label rides along with no actual cut', () => {
    vi.mocked(usePrices).mockReturnValue({
      data: {
        items: [
          {
            product_key: OIL_KEY,
            name: 'Minyak Goreng Bimoli',
            unit: '1 L',
            source_slug: 'superindo',
            source_name: 'Superindo',
            price: 21500,
            effective_unit_price: 21500,
            promo_label: 'Diskon 5%',
            cheapest_source_slug: 'superindo',
            savings_pct: 0,
            match_confidence: 1.0,
            low_confidence: false,
          },
        ],
        total: 1,
      },
      isLoading: false,
      isError: false,
    })
    const { container } = renderPrices()
    expect(container.querySelector('.line-through')).toBeNull()
    expect(container.textContent).toContain('21.500')
  })

  it('renders the validity countdown buckets from the cheapest offer', () => {
    const itemsFor = (validUntil) => [
      {
        product_key: OIL_KEY,
        name: 'Minyak Goreng Bimoli',
        source_slug: 'superindo',
        source_name: 'Superindo',
        price: 21500,
        cheapest_source_slug: 'superindo',
        cheapest_valid_until: validUntil,
        match_confidence: 1.0,
        low_confidence: false,
      },
    ]

    // No validity on the cheapest offer → nothing rendered.
    const { container: none } = renderPrices()
    expect(none.textContent).not.toContain('prices.countdown')

    vi.mocked(usePrices).mockReturnValue({
      data: { items: itemsFor(localDate(0)), total: 1 },
      isLoading: false,
      isError: false,
    })
    const { container: today } = renderPrices()
    expect(today.textContent).toContain('prices.countdownToday')

    vi.mocked(usePrices).mockReturnValue({
      data: { items: itemsFor(localDate(2)), total: 1 },
      isLoading: false,
      isError: false,
    })
    const { container: soon } = renderPrices()
    expect(soon.textContent).toContain('prices.countdownDays')

    vi.mocked(usePrices).mockReturnValue({
      data: { items: itemsFor(localDate(-1)), total: 1 },
      isLoading: false,
      isError: false,
    })
    const { container: expired } = renderPrices()
    expect(expired.textContent).toContain('prices.countdownExpired')
  })

  it('renders footer stats with per-source product counts and matched', () => {
    const { container } = renderPrices()
    const footer = container.querySelector('[data-testid="prices-footer-stats"]')
    expect(footer.textContent).toContain('Lotte Mart: 1')
    expect(footer.textContent).toContain('Superindo: 2')
    expect(footer.textContent).toContain('prices.matched')
  })

  it('shows the truncation hint from the sorted-response truncated flag', () => {
    vi.mocked(usePrices).mockReturnValue({
      data: { items: mockItems, total: 3, truncated: true },
      isLoading: false,
      isError: false,
    })
    const { container } = renderPrices()
    expect(container.textContent).toContain('prices.listLimit')
  })

  it('does not show the truncation hint when the page is complete', () => {
    vi.mocked(usePrices).mockReturnValue({
      data: { items: mockItems, total: 250, truncated: false },
      isLoading: false,
      isError: false,
    })
    const { container } = renderPrices()
    expect(container.textContent).not.toContain('prices.listLimit')
  })

  it('renders the freshness line for fresh data', () => {
    const { container } = renderPrices()
    expect(container.textContent).toContain('prices.updated')
    expect(container.querySelector('.animate-pulse')).toBeTruthy()
    expect(container.querySelector('.bg-warn')).toBeNull()
  })

  it('turns the freshness dot warn past 26h without pulsing', () => {
    vi.mocked(usePriceMeta).mockReturnValue({
      data: { latestScrapedAt: isoDaysFromNow(-27 * 60 * 60_000), observationCount: 3 },
    })
    const { container } = renderPrices()
    expect(container.querySelector('.bg-warn')).toBeTruthy()
    expect(container.querySelector('.animate-pulse')).toBeNull()
  })

  it('renders no freshness line before meta loads', () => {
    vi.mocked(usePriceMeta).mockReturnValue({ data: null })
    const { container } = renderPrices()
    expect(container.textContent).not.toContain('prices.updated')
  })

  // --- Promos view (issue #292) ---

  describe('segmented Products|Promos view', () => {
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

    it('defaults to the products view with search and chips visible', () => {
      const { container } = renderPrices()
      expect(container.querySelector('input[type="search"]')).toBeTruthy()
      expect(container.textContent).not.toContain('prices.promosLead')
      expect(container.textContent).not.toContain('prices.viewPromos-pressed-anyway')
    })

    it('?view=promos renders the promos view and hides products-only controls', () => {
      mockView = 'promos'
      vi.mocked(usePricePromos).mockReturnValue({
        data: promoCatalog,
        isLoading: false,
        isError: false,
      })
      const { container } = renderPrices()
      expect(container.textContent).toContain('prices.promosLead')
      expect(container.textContent).toContain('prices.promoTypeDiscountPct')
      expect(container.textContent).toContain('prices.promoTypeGetFree')
      expect(container.textContent).toContain('prices.promosTotal')
      expect(container.querySelector('input[type="search"]')).toBeNull()
      expect(container.querySelector('select')).toBeNull()
      // Segment row stays visible in both views.
      expect(container.textContent).toContain('prices.viewProducts')
      expect(container.textContent).toContain('prices.viewPromos')
    })

    it('a hash present forces the products view even with view=promos', () => {
      mockView = 'promos'
      mockHash = `#${OIL_KEY}`
      const { container } = renderPrices()
      expect(container.textContent).toContain('prices.lead')
      expect(container.querySelector('input[type="search"]')).toBeTruthy()
      expect(container.textContent).not.toContain('prices.promosLead')
    })

    it('clicking an example jumps: clears filters and deep-links the product', () => {
      const utils = renderPrices()
      const { container } = utils
      // Prime the shell's local filters through the products view first —
      // the jump must clear exactly these. (Search is debounced into the
      // query, so its clearing is asserted via the input value below.)
      fireEvent.change(container.querySelector('input[type="search"]'), {
        target: { value: 'minyak' },
      })
      fireEvent.click(findClickable(container, 'Lotte Mart'))
      expect(vi.mocked(usePrices).mock.calls.at(-1)[0]).toEqual({
        q: undefined,
        source: 'lotte-mart',
        sort: 'cheapest',
      })

      mockView = 'promos'
      vi.mocked(usePricePromos).mockReturnValue({
        data: promoCatalog,
        isLoading: false,
        isError: false,
      })
      rerenderPrices(utils)
      // Expand the Discount % card first — example rows live inside it.
      fireEvent.click(findClickable(container, 'prices.promoTypeDiscountPct'))
      expect(container.textContent).toContain('prices.showExamples')
      fireEvent.click(findClickable(container, 'Minyak Goreng Bimoli'))
      expect(navigate).toHaveBeenCalledWith({
        to: '/prices',
        search: {},
        hash: OIL_KEY,
        replace: false,
      })
      // The jump dropped the view param (hash wins) and cleared the local
      // filters — the unfiltered products query is the landing context.
      expect(mockHash).toBe(`#${OIL_KEY}`)
      expect(container.querySelector('input[type="search"]').value).toBe('')
      expect(vi.mocked(usePrices).mock.calls.at(-1)[0]).toEqual({
        q: undefined,
        source: null,
        sort: 'cheapest',
      })
    })
  })

  describe('Brochures view (issue #293)', () => {
    const brochureCatalog = {
      groups: [
        {
          source_slug: 'lotte-mart',
          source_name: 'Lotte Mart',
          brochure_url: '/api/brochures/lotte-mart/20261029/page_1_2ad1c95b.jpg',
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

    it('?view=brochures renders the brochures view with the third segment', () => {
      mockView = 'brochures'
      vi.mocked(usePriceBrochures).mockReturnValue({
        data: brochureCatalog,
        isLoading: false,
        isError: false,
      })
      const { container } = renderPrices()
      expect(container.textContent).toContain('prices.brochuresLead')
      expect(container.textContent).toContain('Lotte Mart')
      expect(container.textContent).toContain('prices.viewBrochures')
      // Products-only controls hidden; segment row stays visible.
      expect(container.querySelector('input[type="search"]')).toBeNull()
      expect(container.textContent).toContain('prices.viewProducts')
      expect(container.textContent).toContain('prices.viewPromos')
    })

    it('absent view param still defaults to Products', () => {
      const { container } = renderPrices()
      expect(container.textContent).not.toContain('prices.brochuresLead')
      expect(container.querySelector('input[type="search"]')).toBeTruthy()
    })

    it('a hash present forces the products view even with view=brochures', () => {
      mockView = 'brochures'
      mockHash = `#${OIL_KEY}`
      const { container } = renderPrices()
      expect(container.textContent).toContain('prices.lead')
      expect(container.textContent).not.toContain('prices.brochuresLead')
    })

    it('empty catalog renders the empty state with the segment row visible', () => {
      mockView = 'brochures'
      vi.mocked(usePriceBrochures).mockReturnValue({
        data: { groups: [] },
        isLoading: false,
        isError: false,
      })
      const { container } = renderPrices()
      expect(container.textContent).toContain('prices.brochuresEmpty')
      expect(container.textContent).toContain('prices.viewBrochures')
      expect(container.textContent).toContain('prices.viewProducts')
    })

    it('clicking a brochure example jumps with the product key', () => {
      mockView = 'brochures'
      vi.mocked(usePriceBrochures).mockReturnValue({
        data: brochureCatalog,
        isLoading: false,
        isError: false,
      })
      const { container } = renderPrices()
      fireEvent.click(container.querySelector('button[aria-expanded]'))
      fireEvent.click(findClickable(container, 'Minyak Goreng Bimoli'))
      expect(navigate).toHaveBeenCalledWith({
        to: '/prices',
        search: {},
        hash: OIL_KEY,
        replace: false,
      })
    })
  })

  describe('deep link (#productKey)', () => {
    it('expands the hashed product once it is loaded', () => {
      mockHash = `#${OIL_KEY}`
      vi.mocked(usePriceDetail).mockReturnValue({
        data: {
          product: { product_key: OIL_KEY, name: 'Minyak Goreng Bimoli' },
          current: [
            {
              source_slug: 'superindo',
              source_name: 'Superindo',
              price: 21500,
              match_confidence: 1.0,
              low_confidence: false,
            },
          ],
          history: [],
        },
        isLoading: false,
      })
      const { container } = renderPrices()
      expect(container.textContent).toContain('prices.currentPrices')
      // Writing back the same hash is a no-op (no apply→write→apply loop).
      expect(navigate).not.toHaveBeenCalled()
    })

    it('keeps a hash for a product that is not in the loaded set', () => {
      mockHash = '#not-in-page'
      const { container } = renderPrices()
      expect(container.textContent).not.toContain('prices.currentPrices')
      expect(navigate).not.toHaveBeenCalled()
    })

    it('replaces the hash on expand and clears it on collapse', () => {
      const { container } = renderPrices()
      fireEvent.click(findClickable(container, 'Minyak Goreng Bimoli'))
      expect(navigate).toHaveBeenCalledWith({ to: '/prices', hash: OIL_KEY, replace: true })

      fireEvent.click(findClickable(container, 'Minyak Goreng Bimoli'))
      expect(navigate).toHaveBeenCalledWith({ to: '/prices', hash: '', replace: true })
    })
  })

  it('renders the detail cheapest chip, gap, strikethrough, and unit price', () => {
    vi.mocked(usePriceDetail).mockReturnValue({
      data: {
        product: { product_key: OIL_KEY, name: 'Minyak Goreng Bimoli' },
        current: [
          {
            source_slug: 'superindo',
            source_name: 'Superindo',
            price: 41000,
            effective_unit_price: 36000,
            promo_label: 'Diskon 12%',
            unit: '1 kg',
            match_confidence: 1.0,
            low_confidence: false,
          },
          {
            source_slug: 'lotte-mart',
            source_name: 'Lotte Mart',
            price: 40000,
            effective_unit_price: 38000,
            promo_label: 'Diskon 5%',
            unit: '1 kg',
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
    expect(container.textContent).toContain('prices.cheapestBadge')
    // Gap vs the first row: 38000 − 36000 = 2000 (Intl id-ID uses a NBSP
    // between "Rp" and the amount).
    expect(container.textContent).toMatch(/\+Rp\u00A02\.000/)
    // Struck tag + bold effective price, per-unit line for the 1 kg unit.
    expect(container.textContent).toContain('40.000')
    expect(container.textContent).toContain('38.000')
    expect(container.textContent).toContain('prices.perUnit')
  })
})
