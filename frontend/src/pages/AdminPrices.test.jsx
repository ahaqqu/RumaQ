import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { AdminPrices } from './AdminPrices.jsx'

// The page reads ?run= via useSearch (issue #294 deep link); the global
// setup's router mock does not provide it, so this file extends the mock.
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

vi.mock('../lib/queries/me.js', () => ({
  useMe: vi.fn(),
}))

vi.mock('../lib/queries/index.js', () => ({
  usePriceRuns: vi.fn(),
}))

import { useMe } from '../lib/queries/me.js'
import { usePriceRuns } from '../lib/queries/index.js'

const recentSuccess = new Date(Date.now() - 8 * 3_600_000).toISOString()
const staleSuccess = new Date(Date.now() - 30 * 3_600_000).toISOString()

const mockFeed = {
  runs: [
    {
      id: 'run-1',
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
        },
      },
      match: { exact: 5, embedding: 1, ai: 0, solo: 1, reviewItems: 0, embeddingsDegraded: false },
      publish: { mode: 'published', accepted: 7, skipped: 0 },
      error: null,
    },
    {
      id: 'run-2',
      runStartedAt: staleSuccess,
      finishedAt: staleSuccess,
      exitCode: 1,
      status: 'failed',
      stage: 'publish',
      perStore: {},
      match: null,
      publish: null,
      error: 'Ingest endpoint returned HTTP 500',
    },
  ],
  lastSuccessAt: recentSuccess,
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
}

function renderAdmin() {
  return render(
    React.createElement(
      QueryClientProvider,
      { client: createQueryClient() },
      React.createElement(AdminPrices, null)
    )
  )
}

// The suite's i18n mock returns raw keys, so assertions match keys and
// un-translated data (error strings).
describe('AdminPrices', () => {
  beforeEach(() => {
    vi.mocked(useMe).mockReturnValue({ data: { user: { isAdmin: true } } })
    vi.mocked(usePriceRuns).mockReturnValue({
      data: mockFeed,
      isLoading: false,
      isError: false,
    })
  })

  it('shows the forbidden state for non-admins', () => {
    vi.mocked(useMe).mockReturnValue({ data: { user: { isAdmin: false } } })
    const { container } = renderAdmin()
    expect(container.textContent).toContain('monitor.forbidden')
    expect(container.textContent).not.toContain('monitor.runHistory')
  })

  it('lists run history with success and failure rows', () => {
    const { container } = renderAdmin()
    expect(container.textContent).toContain('monitor.runHistory')
    expect(container.textContent).toContain('monitor.success')
    expect(container.textContent).toContain('monitor.failed')
    expect(container.textContent).toContain('Ingest endpoint returned HTTP 500')
  })

  it('marks a green run carrying the by-design needs-proxy skip', () => {
    vi.mocked(usePriceRuns).mockReturnValue({
      data: {
        runs: [
          {
            ...mockFeed.runs[0],
            perStore: {
              superindo: mockFeed.runs[0].perStore.superindo,
              'lotte-mart': {
                pagesFound: 0,
                newImages: 0,
                existingImages: 0,
                skipped: 0,
                itemsExtracted: 0,
                itemsRejected: 0,
                error: 'Tier-3 proxy required but LOTTE_PROXY_URL is not configured',
                needsProxy: true,
              },
            },
          },
        ],
        lastSuccessAt: recentSuccess,
      },
      isLoading: false,
      isError: false,
    })
    const { container } = renderAdmin()
    // The run stays green, the store row shows the amber gap — never the red
    // store-failed rendering.
    expect(container.textContent).toContain('monitor.success')
    expect(container.textContent).toContain('monitor.needsProxyChip')
    expect(container.textContent).toContain('monitor.needsProxy')
    expect(container.textContent).not.toContain('monitor.storeError')
  })

  it('warns when the last success is older than a day', () => {
    vi.mocked(usePriceRuns).mockReturnValue({
      data: { ...mockFeed, lastSuccessAt: staleSuccess },
      isLoading: false,
      isError: false,
    })
    const { container } = renderAdmin()
    expect(container.textContent).toContain('monitor.stale')
  })

  it('renders a run with a missing stage without crashing', () => {
    vi.mocked(usePriceRuns).mockReturnValue({
      data: {
        runs: [{ ...mockFeed.runs[0], stage: undefined }],
        lastSuccessAt: recentSuccess,
      },
      isLoading: false,
      isError: false,
    })
    const { container } = renderAdmin()
    expect(container.textContent).toContain('monitor.success')
    expect(container.textContent).not.toContain('monitor.stage')
  })

  it('renders the empty state when no runs were reported', () => {
    vi.mocked(usePriceRuns).mockReturnValue({
      data: { runs: [], lastSuccessAt: null },
      isLoading: false,
      isError: false,
    })
    const { container } = renderAdmin()
    expect(container.textContent).toContain('monitor.noRuns')
  })

  it('renders a dedicated error state when run history fails to load', () => {
    vi.mocked(usePriceRuns).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    })
    const { container } = renderAdmin()
    // A 5xx must not read as "no data" — its own title, not monitor.noRuns.
    expect(container.textContent).toContain('monitor.error')
    expect(container.textContent).toContain('offline.banner')
    expect(container.textContent).not.toContain('monitor.noRuns')
  })

  it('links the flagged count to the review queue when a run reports flags', () => {
    vi.mocked(usePriceRuns).mockReturnValue({
      data: {
        ...mockFeed,
        runs: [
          {
            ...mockFeed.runs[0],
            match: { ...mockFeed.runs[0].match, reviewItems: 3 },
          },
          ...mockFeed.runs.slice(1),
        ],
      },
      isLoading: false,
      isError: false,
    })
    const { container } = renderAdmin()
    // The flagged line lives inside the run detail — expand the first row.
    fireEvent.click(container.querySelector('button'))
    const link = [...container.querySelectorAll('a')].find((a) =>
      a.getAttribute('href')?.includes('/admin/review')
    )
    expect(link).toBeTruthy()
    expect(link.textContent).toContain('monitor.matchReview')
  })

  it('keeps the flagged count plain text at zero', () => {
    vi.mocked(usePriceRuns).mockReturnValue({
      data: {
        runs: [
          {
            ...mockFeed.runs[0],
            match: {
              ...mockFeed.runs[0].match,
              reviewItems: 0,
            },
          },
        ],
        lastSuccessAt: recentSuccess,
      },
      isLoading: false,
      isError: false,
    })
    const { container } = renderAdmin()
    fireEvent.click(container.querySelector('button'))
    expect(container.textContent).toContain('monitor.matchReview')
    const links = [...container.querySelectorAll('a')].filter((a) =>
      a.getAttribute('href')?.includes('/admin/review')
    )
    expect(links).toHaveLength(0)
  })

  it('renders the OCR degradation chain and store warnings in run detail (issue #357)', () => {
    vi.mocked(usePriceRuns).mockReturnValue({
      data: {
        runs: [
          {
            ...mockFeed.runs[0],
            perStore: {
              superindo: {
                ...mockFeed.runs[0].perStore.superindo,
                itemsRejected: 19,
                modelsUsed: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash'],
                warnings: [
                  'OCR chain degraded: gemini-3.8-flash (503 saturation after ladder) → gemini-3.7-flash (daily-quota 429); final rung gemini-3.6-flash',
                ],
              },
            },
          },
        ],
        lastSuccessAt: recentSuccess,
      },
      isLoading: false,
      isError: false,
    })
    const { container } = renderAdmin()
    fireEvent.click(container.querySelector('button'))
    // The chain reads compactly next to the counts — gemini- prefix stripped,
    // final rung last — so "N rejected · OCR degraded: …" is one story. (The
    // suite's i18n mock returns raw keys, so the counts line asserts keys.)
    expect(container.textContent).toContain('monitor.rejected')
    expect(container.textContent).toContain('monitor.ocrDegraded')
    expect(container.textContent).toContain('3.8-flash → 3.7-flash → 3.6-flash')
    // The scraper's warning rides its own line, verbatim.
    expect(container.textContent).toContain(
      'OCR chain degraded: gemini-3.8-flash (503 saturation after ladder)'
    )
    // Both the chain line and the warning render warn-toned.
    const warnLines = [...container.querySelectorAll('.text-warn')]
    expect(warnLines.some((el) => el.textContent.includes('3.8-flash → 3.7-flash'))).toBe(true)
    expect(warnLines.some((el) => el.textContent.includes('OCR chain degraded:'))).toBe(true)
  })

  it('renders nothing new for a store with a single OCR rung and no warnings (issue #357)', () => {
    vi.mocked(usePriceRuns).mockReturnValue({
      data: {
        runs: [
          {
            ...mockFeed.runs[0],
            perStore: {
              superindo: {
                ...mockFeed.runs[0].perStore.superindo,
                modelsUsed: ['gemini-3.8-flash'],
              },
            },
          },
        ],
        lastSuccessAt: recentSuccess,
      },
      isLoading: false,
      isError: false,
    })
    const { container } = renderAdmin()
    fireEvent.click(container.querySelector('button'))
    // One rung is not a degraded ride (no false attribution) and absent
    // warnings render no extra lines.
    expect(container.textContent).not.toContain('monitor.ocrDegraded')
    expect(container.textContent).not.toContain('3.8-flash')
  })

  it('pre-expands the run the ?run= deep link points at', () => {
    mockSearch = { run: 'run-2' }
    const { container } = renderAdmin()
    // run-2's detail (publish section) is visible without clicking the row.
    expect(container.textContent).toContain('monitor.publishDetail')
    // run-1 stays collapsed.
    expect(container.textContent).toContain('monitor.storesDetail')
  })

  it('renders normally when the ?run= id is not in the feed', () => {
    mockSearch = { run: 'run-unknown' }
    const { container } = renderAdmin()
    expect(container.textContent).toContain('monitor.runHistory')
    expect(container.textContent).not.toContain('monitor.publishDetail')
  })
})
