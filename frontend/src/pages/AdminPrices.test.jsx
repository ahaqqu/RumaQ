import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { AdminPrices } from './AdminPrices.jsx'

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

  it('warns when the last success is older than a day', () => {
    vi.mocked(usePriceRuns).mockReturnValue({
      data: { ...mockFeed, lastSuccessAt: staleSuccess },
      isLoading: false,
      isError: false,
    })
    const { container } = renderAdmin()
    expect(container.textContent).toContain('monitor.stale')
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
})
