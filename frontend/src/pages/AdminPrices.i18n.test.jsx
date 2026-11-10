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
  aiPromptIdentity: {
    version: 2,
    id: 'ocr.verifier.ai_prompt_template',
    sha256: '01274416be4f0f03241df30a4cec72290297750f34c1001d5c691e908fb5baae',
  },
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

  // Pipeline #83: the run detail names the verifier prompt that answered. The
  // rendered line carries the version + a 12-char hash prefix (the full
  // sha256 rides the tooltip), so a v1→v2 prompt edit is attributable from
  // the run history alone.
  it('renders the verifier prompt version and hash prefix in real copy', () => {
    const { container } = renderAdmin()
    fireEvent.click(container.querySelector('button'))
    expect(container.textContent).toContain('Verifier prompt v2')
    expect(container.textContent).toContain('01274416be4')
    // The full digest is the tooltip's payload — the only place it is exposed.
    const tooltip = container.querySelector('[title^="sha256:"]')
    expect(tooltip?.getAttribute('title')).toBe(`sha256:${v2Run.aiPromptIdentity.sha256}`)
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

  // Pipeline #83: the prompt-identity line is an operator surface too — pin
  // its Indonesian copy (the #463 thermos C2 rule, applied to the new line).
  it('carries the Indonesian verifier prompt copy, not an English copy', () => {
    expect(id.monitor.verifierPrompt).toBe('Prompt verifier v{{version}} · {{sha}}…')
    expect(id.monitor.verifierPrompt).not.toBe(en.monitor.verifierPrompt)
  })

  // Issue #536: the consecutive-failed-run banner is the one surface that says
  // "the pipeline is dead, not quiet" — it must render real copy (count, first
  // dry night, typed class) and real Indonesian, not fall back to a raw key.
  it('renders the failed-run streak banner in real copy', () => {
    const since = new Date(Date.now() - 73 * 3_600_000).toISOString()
    const failedNight = (startedAt) => ({
      ...v2Run,
      status: 'failed',
      exitCode: 2,
      stage: 'match',
      match: null,
      publish: null,
      failures: [
        {
          store: null,
          code: 'embedding_unavailable',
          message: 'embedding_quota: daily quota exhausted',
        },
      ],
      error: 'embedding_quota: daily quota exhausted',
      runStartedAt: startedAt,
      finishedAt: startedAt,
    })
    vi.mocked(usePriceRuns).mockReturnValue({
      data: {
        runs: [failedNight(since), failedNight(since), failedNight(since)],
        lastSuccessAt: recentSuccess,
        failedStreak: { count: 3, threshold: 3, since, code: 'embedding_unavailable' },
      },
      isLoading: false,
      isError: false,
    })
    const { container } = renderAdmin()
    const banner = container.querySelector('[role="status"]')
    expect(banner).toBeTruthy()
    expect(banner.textContent).toContain('3 consecutive failed runs — nothing published since')
    expect(banner.textContent).toContain('Last failure: embedding_unavailable')
    expect(banner.textContent).toContain('Advisory only')
    // Advisory means advisory: the banner has no control.
    expect(banner.querySelector('button')).toBeNull()
  })

  it('carries the Indonesian failed-run streak copy, not an English copy', () => {
    expect(id.monitor.failedStreak).toBe(
      '{{count}} run gagal beruntun — tidak ada harga terbit sejak {{since}}'
    )
    expect(id.monitor.failedStreakCode).toBe('Kegagalan terakhir: {{code}}')
    for (const key of ['failedStreak', 'failedStreakCode', 'failedStreakHint']) {
      expect(id.monitor[key], `monitor.${key} is untranslated`).not.toBe(en.monitor[key])
    }
  })
})
