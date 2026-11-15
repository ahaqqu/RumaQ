import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { BrochureViewerPage } from './BrochureViewerPage.jsx'
import { resolveBrochureViewerSearch } from '../lib/pricesHelpers.js'

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
}))

import { usePriceBrochures } from '../lib/queries/index.js'

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
    expect(resolveBrochureViewerSearch({ store: 42, date: null, file: {} })).toEqual({
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
})

describe('BrochureViewerPage — share (#674)', () => {
  const shareUrl = `${window.location.origin}/brochures/view?store=lotte-mart&date=20261028&file=page_1_2ad1c95b.jpg`

  beforeEach(() => {
    vi.clearAllMocks()
    searchState.search = VIEWER_SEARCH
    vi.mocked(usePriceBrochures).mockReturnValue({ data: { groups } })
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
    const { getByText, getByRole } = renderViewer()
    fireEvent.click(getByText('Share'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(shareUrl))
    // The inline role="status" confirmation (repo idiom — no toast library).
    expect(getByRole('status').textContent).toBe('Link copied')
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
