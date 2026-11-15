import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { BrochuresGallery } from './BrochuresGallery.jsx'

// Render the REAL English copy (the BrochuresView.test.jsx idiom) so the
// filter summary and count labels are asserted as users see them — the global
// setup's raw-key t() would hide interpolation mistakes.
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
}))

import { usePriceBrochures } from '../lib/queries/index.js'

const BROCHURE_A = '/api/brochures/lotte-mart/20261029/page_1_2ad1c95b.jpg'
const BROCHURE_B = '/api/brochures/lotte-mart/20261028/page_2_ff00aa11.jpg'
const BROCHURE_C = '/api/brochures/superindo/20261029/koran_a_1b2c3d4e.jpg'

// The same QA-laden payload the backend ships to the admin QA view — the
// gallery must render none of it (issue #673), so the fixture carries the
// fields on purpose.
const groups = [
  {
    source_slug: 'lotte-mart',
    source_name: 'Lotte Mart',
    brochure_url: BROCHURE_A,
    observed_date: '2026-10-29',
    product_count: 7,
    example_products: [
      {
        product_key: 'beras--pandan-wangi--5-kg',
        name: 'Beras Pandan Wangi 5 kg',
        price: 72000,
        match_method: 'embedding',
        match_confidence: 0.92,
      },
    ],
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

function renderGallery() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(BrochuresGallery, null)
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

describe('BrochuresGallery — filters and layout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: { groups },
      isLoading: false,
      isError: false,
    })
  })

  it('renders a responsive multi-column grid of brochure cards', () => {
    const { container } = renderGallery()
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
    const { container } = renderGallery()
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
    const { container } = renderGallery()
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
    const { container } = renderGallery()
    fireEvent.error(container.querySelector(`img[src="${BROCHURE_A}"]`))
    expect(container.querySelector(`img[src="${BROCHURE_A}"]`)).toBeNull()
    const card = cards(container)[0]
    expect(text(card)).toContain('Lotte Mart')
    expect(text(card)).toContain('7 products')
  })
})

describe('BrochuresGallery — a lean user surface (#673)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: { groups },
      isLoading: false,
      isError: false,
    })
  })

  it('renders no ingestion-QA fields anywhere', () => {
    const { container } = renderGallery()
    // The payload carries QA data (example_products with match_method /
    // match_confidence) — none of it may reach the user screen. The review
    // table, metadata panel, and QA labels all stay admin-side.
    expect(container.querySelector('#brochure-review')).toBeNull()
    expect(container.querySelector('[data-testid="brochure-product-row"]')).toBeNull()
    expect(container.querySelector('[data-testid="brochure-product-metadata"]')).toBeNull()
    const copy = text(container)
    expect(copy).not.toContain('Match confidence')
    expect(copy).not.toContain('Match method')
    expect(copy).not.toContain('Product key')
    expect(copy).not.toContain('Beras Pandan Wangi')
  })

  it('carries an explicit View link per card that opens the full-mode viewer in a new tab (#674)', () => {
    // The card itself stays inert; the View link recomposes the canonical
    // brochure_url into the structured /brochures/view deep link and opens
    // it as a top-level blank navigation (SameSite=Lax carries the session).
    const { container } = renderGallery()
    const expectedHrefs = {
      [BROCHURE_A]: '/brochures/view?store=lotte-mart&date=20261029&file=page_1_2ad1c95b.jpg',
      [BROCHURE_B]: '/brochures/view?store=lotte-mart&date=20261028&file=page_2_ff00aa11.jpg',
      [BROCHURE_C]: '/brochures/view?store=superindo&date=20261029&file=koran_a_1b2c3d4e.jpg',
    }
    for (const card of cards(container)) {
      expect(card.tagName).toBe('DIV')
      expect(card.getAttribute('aria-expanded')).toBeNull()
      expect(card.querySelector('button')).toBeNull()
      const link = card.querySelector('a')
      expect(link).not.toBeNull()
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toContain('noreferrer')
      expect(link.textContent).toContain('View')
    }
    for (const [url, href] of Object.entries(expectedHrefs)) {
      const card = cardFor(container, url)
      expect(card.querySelector('a').getAttribute('href')).toBe(href)
    }
  })
})

describe('BrochuresGallery — loading, empty, error', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders skeletons while the catalog loads', () => {
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    })
    const { container } = renderGallery()
    expect(container.querySelector('.bg-surface-inset')).toBeTruthy()
    expect(cards(container)).toHaveLength(0)
  })

  it('renders the offline pattern when the catalog fails', () => {
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    })
    const { container } = renderGallery()
    expect(text(container)).toContain('No matching prices')
    expect(text(container)).toContain("You're offline")
  })

  it('keeps the empty catalog state', () => {
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: { groups: [] },
      isLoading: false,
      isError: false,
    })
    const { container } = renderGallery()
    expect(text(container)).toContain('No brochures yet')
    expect(container.querySelectorAll('img')).toHaveLength(0)
  })
})
