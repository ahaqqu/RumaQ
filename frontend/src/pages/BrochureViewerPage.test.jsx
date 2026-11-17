import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test'
import { render, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { BrochureViewerPage } from './BrochureViewerPage.jsx'
import { formatPrice, resolveBrochureViewerSearch } from '../lib/pricesHelpers.js'

// Render the REAL English copy (the BrochuresGallery.test.jsx idiom) so the
// title and share feedback are asserted as users see them.
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
  useBrochureProducts: vi.fn(),
}))

import { usePriceBrochures, useBrochureProducts } from '../lib/queries/index.js'

// The viewer reads the route's validated search params; the test pins them
// here instead of booting a router (the same idiom as AppShell.test.jsx's
// file-local router mock).
const searchState = vi.hoisted(() => ({ search: {} }))
vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual('@tanstack/react-router')
  return {
    ...actual,
    useSearch: () => searchState.search,
  }
})

const VIEWER_SEARCH = { store: 'lotte-mart', date: '20261028', file: 'page_1_2ad1c95b.jpg' }
const BROCHURE_URL = '/api/brochures/lotte-mart/20261028/page_1_2ad1c95b.jpg'

const groups = [
  {
    source_slug: 'lotte-mart',
    source_name: 'Lotte Mart',
    brochure_url: BROCHURE_URL,
    observed_date: '2026-10-28',
    product_count: 7,
  },
]

const fullProduct = {
  product_key: 'beras--pandan-wangi--5-kg',
  name: 'Beras Pandan Wangi 5 kg',
  brand: 'Pandan Wangi',
  unit: '5 kg',
  category: 'beras',
  category_version: '2026-01',
  price: 72000,
  member_price: 10000,
  effective_unit_price: 14400,
  promo_type: 'discount_pct',
  promo_label: 'DISKON 20%',
  valid_from: '2026-10-28',
  valid_until: '2026-11-04',
  match_method: 'embedding',
  match_confidence: 0.92,
  source_slug: 'lotte-mart',
  source_name: 'Lotte Mart',
  source_website: 'https://www.lottemart.co.id',
  observed_date: '2026-10-28',
  brochure_url: BROCHURE_URL,
  scraped_at: '2026-10-28T23:00:05Z',
}

const products = [fullProduct]

const fetchNextPage = vi.fn()

function productPage({ items = products, total = 7, ...overrides } = {}) {
  return {
    data: { items, total },
    isLoading: false,
    isError: false,
    hasNextPage: items.length < total,
    fetchNextPage,
    isFetchingNextPage: false,
    ...overrides,
  }
}

function renderViewer() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(BrochureViewerPage, null)
    )
  )
}

// Intl id-ID puts an NBSP between "Rp" and the amount — normalize like the
// BrochuresView.test.jsx idiom before substring assertions.
function text(container) {
  return container.textContent.replace(/\u00a0/g, ' ')
}

describe('resolveBrochureViewerSearch — the /brochures/view validateSearch (#674)', () => {
  it('keeps well-shaped segments byte-exact', () => {
    expect(resolveBrochureViewerSearch(VIEWER_SEARCH)).toEqual(VIEWER_SEARCH)
    // Parentheses are part of the server's filename charset (real fixtures).
    expect(
      resolveBrochureViewerSearch({
        store: 'tip-top',
        date: '20261201',
        file: 'HEMAT_E_20_(1)_DKI.jpg',
      })
    ).toEqual({ store: 'tip-top', date: '20261201', file: 'HEMAT_E_20_(1)_DKI.jpg' })
  })

  it('coerces the router JSON-parsed numeric date back to a string', () => {
    // router-core's default search parser JSON-parses digit-leading values,
    // so a deep link ?date=20261115 reaches validateSearch as a NUMBER — it
    // must still validate (pinned by the E2E deep-link scenarios).
    expect(
      resolveBrochureViewerSearch({ store: 'lotte-mart', date: 20261115, file: 'page.jpg' })
    ).toEqual({ store: 'lotte-mart', date: '20261115', file: 'page.jpg' })
    // A non-integer number is not a digit round-trip — dropped.
    expect(resolveBrochureViewerSearch({ ...VIEWER_SEARCH, date: 2026.1115 }).date).toBeUndefined()
  })

  it('keeps the admin items flag only as the exact string "true" (#716)', () => {
    // ?admin=true switches the items panel into the QA variant. Anything else
    // — the router's JSON-parsed digit round-trip ('1' → 1), a bare boolean,
    // hand-typed variants — degrades to the plain items-only viewer.
    expect(resolveBrochureViewerSearch({ ...VIEWER_SEARCH, admin: 'true' })).toEqual({
      ...VIEWER_SEARCH,
      admin: 'true',
    })
    expect(resolveBrochureViewerSearch({ ...VIEWER_SEARCH, admin: 1 }).admin).toBeUndefined()
    expect(resolveBrochureViewerSearch({ ...VIEWER_SEARCH, admin: '1' }).admin).toBeUndefined()
    expect(resolveBrochureViewerSearch({ ...VIEWER_SEARCH, admin: true }).admin).toBeUndefined()
    expect(resolveBrochureViewerSearch({ ...VIEWER_SEARCH, admin: 'yes' }).admin).toBeUndefined()
    expect(resolveBrochureViewerSearch(VIEWER_SEARCH).admin).toBeUndefined()
    // The output round-trips: 'true' serializes to ?admin=true and re-validates
    // to the same value, so the URL never churns.
    expect(resolveBrochureViewerSearch({ ...VIEWER_SEARCH, admin: 'true' }).admin).toBe('true')
  })

  it('drops malformed or missing segments so the page never requests a 404 URL', () => {
    // Dashed date (the catalog's shape, not the URL's), store with spaces or
    // uppercase, filename with a slash or traversal, over-long filename,
    // non-string values, and an empty search all degrade to undefined.
    expect(
      resolveBrochureViewerSearch({ store: 'lotte-mart', date: '2026-10-28', file: 'page.jpg' })
    ).toEqual({ store: 'lotte-mart', date: undefined, file: 'page.jpg' })
    expect(
      resolveBrochureViewerSearch({ ...VIEWER_SEARCH, store: 'Lotte Mart' }).store
    ).toBeUndefined()
    expect(
      resolveBrochureViewerSearch({ ...VIEWER_SEARCH, store: 'Lotte-Mart' }).store
    ).toBeUndefined()
    expect(
      resolveBrochureViewerSearch({ ...VIEWER_SEARCH, file: 'deep/page.jpg' }).file
    ).toBeUndefined()
    expect(resolveBrochureViewerSearch({ ...VIEWER_SEARCH, file: '..' }).file).toBeUndefined()
    expect(resolveBrochureViewerSearch({ ...VIEWER_SEARCH, file: '.' }).file).toBeUndefined()
    expect(
      resolveBrochureViewerSearch({ ...VIEWER_SEARCH, file: `${'a'.repeat(201)}.jpg` }).file
    ).toBeUndefined()
    expect(resolveBrochureViewerSearch({ store: true, date: null, file: {} })).toEqual({
      store: undefined,
      date: undefined,
      file: undefined,
    })
    expect(resolveBrochureViewerSearch(undefined)).toEqual({
      store: undefined,
      date: undefined,
      file: undefined,
    })
  })
})

describe('BrochureViewerPage — chrome-less render (#674)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchState.search = VIEWER_SEARCH
    vi.mocked(usePriceBrochures).mockReturnValue({ data: { groups } })
    vi.mocked(useBrochureProducts).mockReturnValue(productPage())
  })

  afterEach(() => {
    delete navigator.share
    delete navigator.clipboard
  })

  it('renders logo, wordmark, and the catalog-resolved title in the top bar', () => {
    const { container } = renderViewer()
    const bar = container.querySelector('[data-testid="viewer-topbar"]')
    expect(bar).toBeTruthy()
    // The RumaQ logo: the BrandMark tile plus the wordmark text.
    expect(bar.textContent).toContain('RumaQ')
    // Title resolves from the SAME query the gallery uses (cache hit) — the
    // source name and the formatted observed date, not the raw slug.
    expect(bar.querySelector('h1').textContent).toBe('Lotte Mart · October 28, 2026')
  })

  it('falls back to the URL-derived title while the catalog cannot resolve', () => {
    vi.mocked(usePriceBrochures).mockReturnValue({ data: { groups: [] } })
    const { container } = renderViewer()
    expect(container.querySelector('h1').textContent).toBe('Lotte Mart · October 28, 2026')
  })

  it('renders no AppShell chrome — no sidebar, header, tab bar, or cards', () => {
    const { container } = renderViewer()
    expect(container.querySelector('aside')).toBeNull()
    expect(container.querySelector('header')).toBeNull()
    expect(container.querySelector('nav')).toBeNull()
    expect(container.querySelector('[data-testid="brochure-card"]')).toBeNull()
    expect(container.querySelector('[data-testid="household-card"]')).toBeNull()
  })

  it('eager-loads the image in a reserved 3:4 frame', () => {
    const { container } = renderViewer()
    const frame = container.querySelector('div[style*="3 / 4"]')
    expect(frame).toBeTruthy()
    const img = frame.querySelector('img')
    expect(img.getAttribute('src')).toBe(BROCHURE_URL)
    expect(img.getAttribute('loading')).toBe('eager')
    expect(img.getAttribute('alt')).toBe('Lotte Mart brochure page')
    expect(img.className).toContain('object-contain')
  })

  it('degrades a broken image to the in-frame text fallback', () => {
    const { container } = renderViewer()
    const img = container.querySelector('img')
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
    const frame = container.querySelector('div[style*="3 / 4"]')
    expect(frame.textContent).toContain('Lotte Mart')
    expect(frame.textContent).toContain('October 28, 2026')
  })

  it('renders the calm unavailable state when segments are missing or malformed', () => {
    searchState.search = {}
    const { container } = renderViewer()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('This brochure is no longer available.')
  })

  it('the top bar agrees with the unavailable body when only some segments survive', () => {
    // A hand-mangled URL (?store=… with date/file dropped by validateSearch)
    // shows the unavailable EmptyState in the body — the title must say the
    // same thing, not render a dangling "Lotte Mart · " separator above it.
    searchState.search = { store: 'lotte-mart' }
    const { container } = renderViewer()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('h1').textContent).toBe('This brochure is no longer available.')
  })
})

describe('BrochureViewerPage — share (#674)', () => {
  const shareUrl = `${window.location.origin}/brochures/view?store=lotte-mart&date=20261028&file=page_1_2ad1c95b.jpg`

  beforeEach(() => {
    vi.clearAllMocks()
    searchState.search = VIEWER_SEARCH
    vi.mocked(usePriceBrochures).mockReturnValue({ data: { groups } })
    vi.mocked(useBrochureProducts).mockReturnValue(productPage())
  })

  afterEach(() => {
    delete navigator.share
    delete navigator.clipboard
  })

  it('uses the native share sheet when the platform provides one', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { container, getByText } = renderViewer()
    fireEvent.click(getByText('Share'))
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith({
        title: 'Lotte Mart · October 28, 2026',
        url: shareUrl,
      })
    )
    // The fallback must not also fire on success.
    expect(writeText).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Link copied')
  })

  it('falls back to copy-link with a visible confirmation when there is no share sheet', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { container, getByText } = renderViewer()
    fireEvent.click(getByText('Share'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(shareUrl))
    // The inline role="status" confirmation (repo idiom — no toast library),
    // scoped to the top bar — the items panel announces its own shown-count
    // status (#716).
    expect(
      within(container.querySelector('[data-testid="viewer-topbar"]')).getByRole('status')
        .textContent
    ).toBe('Link copied')
  })

  it('does not claim a copy and never throws when no clipboard exists (jsdom)', () => {
    // jsdom ships neither navigator.share nor navigator.clipboard here — the
    // click must not throw, and the UI must not lie about a copy.
    const { container, getByText } = renderViewer()
    expect(() => fireEvent.click(getByText('Share'))).not.toThrow()
    expect(container.textContent).not.toContain('Link copied')
  })

  it('stays silent when the user dismisses the native share sheet', async () => {
    const share = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { getByText } = renderViewer()
    fireEvent.click(getByText('Share'))
    await waitFor(() => expect(share).toHaveBeenCalled())
    // A dismiss is not a failure: no clipboard write, no copied claim.
    expect(writeText).not.toHaveBeenCalled()
  })
})

// ——— #716: the brochure's items under the image ———
// The panel is BrochureReview, shared with the admin QA tab. The variant
// follows the SURFACE that opened the tab: the default viewer (from
// /prices?view=brochures) is items-only; ?admin=true (the link composed by
// the /admin/catalog brochures-qa card) adds the QA columns and the expand.

describe('BrochureViewerPage — items panel, prices mode (#716)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchState.search = VIEWER_SEARCH
    vi.mocked(usePriceBrochures).mockReturnValue({ data: { groups } })
    vi.mocked(useBrochureProducts).mockReturnValue(productPage())
  })

  it('renders the items-only table under the image, fetched from the brochure url', () => {
    const { container } = renderViewer()
    expect(useBrochureProducts).toHaveBeenCalledWith(BROCHURE_URL)

    const review = container.querySelector('#brochure-review')
    expect(review.getAttribute('role')).toBe('region')
    expect(review.getAttribute('aria-label')).toBe(
      'Products in the Lotte Mart brochure of October 28, 2026'
    )
    // Shopper columns only — none of the ingestion-QA fields (#673 rule).
    const headers = [...container.querySelectorAll('thead th')].map((th) => th.textContent)
    expect(headers).toEqual(['Product', 'Unit', 'Price', 'Promo'])
    expect(container.querySelectorAll('[data-testid="brochure-product-row"]')).toHaveLength(1)
    expect(text(container)).toContain('Beras Pandan Wangi 5 kg')
    expect(text(container)).toContain('Rp 72.000')
    // Member headline + label, shelf price as the struck reference.
    expect(text(container)).toContain('Member price')
    expect(text(container)).toContain('Rp 10.000')
    const shelfReference = container.querySelector('[data-testid="shelf-reference-price"]')
    expect(shelfReference.textContent).toBe(formatPrice(72000))
    expect(shelfReference.className).toContain('line-through')
    expect(text(container)).toContain('Diskon 20%')
    expect(text(container)).not.toContain('embedding')
    expect(text(container)).not.toContain('Match confidence')
  })

  it('offers no expand affordance and renders no ingestion metadata', () => {
    const { container } = renderViewer()
    fireEvent.click(container.querySelector('[data-testid="brochure-product-row"]'))
    expect(container.querySelector('[data-testid="brochure-product-metadata"]')).toBeNull()
    expect(
      container.querySelector('[data-testid="brochure-product-row"] button[aria-expanded]')
    ).toBeNull()
  })

  it('paginates with the shared Load more footer', () => {
    vi.mocked(useBrochureProducts).mockReturnValue(productPage({ total: 120 }))
    const { container, getByText } = renderViewer()
    expect(container.querySelector('#brochure-review [role="status"]').textContent).toBe(
      'Showing 1 of 120'
    )
    fireEvent.click(getByText('Load more'))
    expect(fetchNextPage).toHaveBeenCalledTimes(1)
  })

  it('falls back to the items-query total for the head count before the catalog resolves', () => {
    vi.mocked(usePriceBrochures).mockReturnValue({ data: { groups: [] } })
    const { container } = renderViewer()
    // The title degrades to the URL-derived store + date; the head count comes
    // from the loaded items query (7), not the missing catalog group.
    expect(container.querySelector('h1').textContent).toBe('Lotte Mart · October 28, 2026')
    expect(container.querySelector('#brochure-review').textContent).toContain('7 products')
  })

  it('renders loading, error, and empty states inside the items panel', () => {
    vi.mocked(useBrochureProducts).mockReturnValue(
      productPage({ data: undefined, isLoading: true })
    )
    const loading = renderViewer()
    expect(loading.container.querySelector('#brochure-review .bg-surface-inset')).toBeTruthy()
    loading.unmount()

    vi.mocked(useBrochureProducts).mockReturnValue(
      productPage({ data: undefined, isLoading: false, isError: true, error: { kind: 'http' } })
    )
    const failed = renderViewer()
    expect(failed.container.textContent).toContain('Could not load this brochure')
    expect(failed.container.textContent).toContain('The server had a problem')
    failed.unmount()

    vi.mocked(useBrochureProducts).mockReturnValue(productPage({ items: [], total: 0 }))
    const empty = renderViewer()
    expect(empty.container.textContent).toContain('No products on this brochure')
    expect(empty.container.textContent).toContain(
      'Prices appear here while the brochure page is current.'
    )
  })
})

describe('BrochureViewerPage — items panel, admin mode ?admin=true (#716)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchState.search = { ...VIEWER_SEARCH, admin: 'true' }
    vi.mocked(usePriceBrochures).mockReturnValue({ data: { groups } })
    vi.mocked(useBrochureProducts).mockReturnValue(productPage())
  })

  it('renders the full QA table with the expand affordance', () => {
    const { container } = renderViewer()
    // Same column set as the admin QA tab's former in-place review (#630).
    const headers = [...container.querySelectorAll('thead th')].map((th) => th.textContent)
    expect(headers).toEqual([
      'Product',
      'Unit',
      'Price',
      'Effective unit price',
      'Promo',
      'Category',
      'Match',
    ])
    expect(text(container)).toContain('embedding · 92%')
    expect(text(container)).toContain('beras')
    // The review region keeps the QA copy; the head count rides the catalog.
    expect(container.querySelector('#brochure-review').getAttribute('aria-label')).toBe(
      'Products ingested from the Lotte Mart brochure of October 28, 2026'
    )
    expect(text(container.querySelector('#brochure-review'))).toContain('7 products')
  })

  it('expands a row into the full ingestion metadata and closes it again', () => {
    const { container } = renderViewer()
    expect(container.querySelector('[data-testid="brochure-product-metadata"]')).toBeNull()

    const firstRow = container.querySelector('[data-testid="brochure-product-row"]')
    const toggle = firstRow.querySelector('button[aria-expanded]')
    fireEvent.click(firstRow)

    const panel = container.querySelector('[data-testid="brochure-product-metadata"]')
    expect(panel).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-controls')).toBe(panel.closest('tr').id)
    const copy = text(panel)
    for (const expected of [
      'Product key',
      'beras--pandan-wangi--5-kg',
      'Match method',
      'embedding',
      'Match confidence',
      '92%',
      'Store website',
      'https://www.lottemart.co.id',
      'Brochure URL',
      BROCHURE_URL,
      'Scraped at',
      '2026-10-28T23:00:05Z',
    ]) {
      expect(copy, `metadata panel is missing ${expected}`).toContain(expected)
    }
    expect(panel.tagName).toBe('DL')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-testid="brochure-product-metadata"]')).toBeNull()
  })

  it('gives the QA table the wider column while the lean table keeps the image column', () => {
    const { container } = renderViewer()
    expect(container.querySelector('[data-testid="viewer-items"]').className).toContain(
      'max-w-[720px]'
    )

    searchState.search = VIEWER_SEARCH
    const lean = renderViewer()
    expect(lean.container.querySelector('[data-testid="viewer-items"]').className).toContain(
      'max-w-[560px]'
    )
  })

  it('shares the plain viewer link — the admin flag never rides the share URL', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { getByText } = renderViewer()
    fireEvent.click(getByText('Share'))
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/brochures/view?store=lotte-mart&date=20261028&file=page_1_2ad1c95b.jpg`
    )
  })
})
