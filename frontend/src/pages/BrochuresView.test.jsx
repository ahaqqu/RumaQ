import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { ApiError } from '../lib/api'
import { BrochuresView } from './BrochuresView.jsx'
import { brochureViewerUrl } from '../lib/pricesHelpers.js'

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

// #716: the QA tab no longer fetches products itself — the card links into
// the chrome-less viewer (?admin=true), which owns the items panel.
vi.mock('../lib/queries/index.js', () => ({
  usePriceBrochures: vi.fn(),
}))

import { usePriceBrochures } from '../lib/queries/index.js'

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

describe('BrochuresView — cards open the viewer in a new tab (#716)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: { groups },
      isLoading: false,
      isError: false,
    })
  })

  it('makes the whole card a target=_blank link into the admin viewer', () => {
    const { container } = renderView()
    for (const card of cards(container)) {
      expect(card.tagName).toBe('A')
      expect(card.getAttribute('target')).toBe('_blank')
      expect(card.getAttribute('rel')).toBe('noreferrer')
    }
    // The link composes ?admin=true so the viewer renders the QA items panel
    // with expandable rows — prices' viewer link stays without it.
    expect(cardFor(container, BROCHURE_A).getAttribute('href')).toBe(
      `${brochureViewerUrl(BROCHURE_A)}&admin=true`
    )
    expect(cardFor(container, BROCHURE_C).getAttribute('href')).toBe(
      `${brochureViewerUrl(BROCHURE_C)}&admin=true`
    )
  })

  it('keeps the review in the new tab only — no in-place panel or select hint', () => {
    const { container } = renderView()
    expect(container.querySelector('#brochure-review')).toBeNull()
    expect(container.querySelector('[data-testid="brochures-select-hint"]')).toBeNull()
    expect(text(container)).not.toContain('Select a brochure')
    expect(container.querySelectorAll('table')).toHaveLength(0)
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
    const { container } = renderView()
    expect(container.querySelector('.bg-surface-inset')).toBeTruthy()
    expect(cards(container)).toHaveLength(0)
  })

  it('renders the error pattern when the catalog fails', () => {
    // L5 (audit): a failed catalog used to read as "offline" — a 500 now says
    // the server had a problem, fed by the M1 classifier's kind.
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError('Request failed: 500', 500),
    })
    const { container } = renderView()
    expect(text(container)).toContain('No matching prices')
    expect(text(container)).toContain('The server had a problem')
    expect(text(container)).not.toContain("You're offline")
  })

  it('keeps the empty catalog state', () => {
    vi.mocked(usePriceBrochures).mockReturnValue({
      data: { groups: [] },
      isLoading: false,
      isError: false,
    })
    const { container } = renderView()
    expect(text(container)).toContain('No brochures yet')
    expect(container.querySelectorAll('img')).toHaveLength(0)
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

  it('gives every card an accessible name through the store and count copy', () => {
    const { container } = renderView()
    expect(text(cardFor(container, BROCHURE_A))).toContain('Lotte Mart')
    expect(text(cardFor(container, BROCHURE_A))).toContain('7 products')
    expect(text(cardFor(container, BROCHURE_C))).toContain('Superindo')
  })
})
