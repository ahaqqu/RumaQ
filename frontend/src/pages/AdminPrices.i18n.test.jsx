import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { fireEvent, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { AdminPrices } from './AdminPrices.jsx'
import en from '../i18n/locales/en.json'
import id from '../i18n/locales/id.json'

// Real-copy pass for the run monitor's v2 receipt line (issue #463):
// AdminPrices.test.jsx runs on test-setup's raw-key t() (assertions read
// keys), so the interpolated sentences could render wrong values with nothing
// failing. This file resolves en.json and interpolates like i18next does (the
// AdminReview.i18n.test.jsx idiom) and pins the REAL rendered copy.
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

// The page reads ?run= via useSearch; the global setup's router mock does not
// provide it, so this file extends the mock (the AdminPrices.test.jsx idiom).
let mockSearch = {}
vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual('@tanstack/react-router')
  return {
    ...actual,
    useSearch: () => mockSearch,
    useMatches: () => [{ routeId: '/', pathname: '/' }],
    useNavigate: () => vi.fn(),
    Link: ({ children, to, className, ...props }) =>
      React.createElement('a', { ...props, className, href: to, 'data-testid': 'link' }, children),
    Outlet: () => null,
  }
})

vi.mock('../lib/queries/me.js', () => ({ useMe: vi.fn() }))
vi.mock('../lib/queries/index.js', () => ({ usePriceRuns: vi.fn() }))

import { useMe } from '../lib/queries/me.js'
import { usePriceRuns } from '../lib/queries/index.js'

const recentSuccess = new Date(Date.now() - 8 * 3_600_000).toISOString()

const v2Run = {
  id: 'run-463',
  runStartedAt: recentSuccess,
  finishedAt: recentSuccess,
  exitCode: 0,
  status: 'success',
  stage: 'done',
  perStore: {
    superindo: {
      pagesFound: 2,
      newImages: 1,
      existingImages: 1,
      skipped: 0,
      itemsExtracted: 7,
      itemsRejected: 0,
      provisionalMatches: 3,
    },
  },
  match: { exact: 5, embedding: 1, ai: 0, solo: 1, reviewItems: 0, embeddingsDegraded: false },
  publish: { mode: 'published', accepted: 7, skipped: 0 },
  indexVersion: 42,
  products: { created: 5, existing: 2 },
  error: null,
}

function renderAdmin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    React.createElement(QueryClientProvider, { client }, React.createElement(AdminPrices, null))
  )
}

describe('AdminPrices i18n (issue #463)', () => {
  beforeEach(() => {
    mockSearch = {}
    vi.mocked(useMe).mockReturnValue({ data: { user: { isAdmin: true } } })
    vi.mocked(usePriceRuns).mockReturnValue({
      data: { runs: [v2Run], lastSuccessAt: recentSuccess },
      isLoading: false,
      isError: false,
    })
  })

  it('renders the index version and the created/existing summary in real copy', () => {
    const { container } = renderAdmin()
    fireEvent.click(container.querySelector('button'))
    expect(container.textContent).toContain('Index v42')
    expect(container.textContent).toContain('5 new products, 2 existing')
  })

  it('renders the provisional count on the store row in real copy', () => {
    const { container } = renderAdmin()
    fireEvent.click(container.querySelector('button'))
    expect(container.textContent).toContain('3 provisional')
  })

  it('keeps a pre-#463 report free of the receipt copy', () => {
    const legacyRun = { ...v2Run, perStore: { superindo: { ...v2Run.perStore.superindo } } }
    delete legacyRun.indexVersion
    delete legacyRun.products
    delete legacyRun.perStore.superindo.provisionalMatches
    vi.mocked(usePriceRuns).mockReturnValue({
      data: { runs: [legacyRun], lastSuccessAt: recentSuccess },
      isLoading: false,
      isError: false,
    })
    const { container } = renderAdmin()
    fireEvent.click(container.querySelector('button'))
    expect(container.textContent).not.toContain('Index v')
    expect(container.textContent).not.toContain('new products')
    expect(container.textContent).not.toContain('provisional')
  })

  // Issue #463 (thermos C2): the EN sentences above are only half the story.
  // The locale parity test (i18n.test.js) proves the ID keys EXIST, not that
  // they are translated — an English copy-paste in id.json stayed green. Pin
  // the Indonesian copy the operator actually sees.
  it('carries the Indonesian receipt copy, not an English copy', () => {
    expect(id.monitor.provisionalMatches).toBe('{{count}} sementara')
    expect(id.monitor.indexVersion).toBe('Indeks v{{version}}')
    expect(id.monitor.productsSummary).toBe('{{created}} produk baru, {{existing}} sudah ada')
    for (const key of ['provisionalMatches', 'indexVersion', 'productsSummary']) {
      expect(id.monitor[key], `monitor.${key} is untranslated`).not.toBe(en.monitor[key])
    }
  })
})
