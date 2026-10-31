import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { AdminAiUsage } from './AdminAiUsage.jsx'

vi.mock('../lib/queries/me.js', () => ({
  useMe: vi.fn(),
}))

vi.mock('../lib/queries/index.js', () => ({
  useAdminAiUsage: vi.fn(),
}))

import { useMe } from '../lib/queries/me.js'
import { useAdminAiUsage } from '../lib/queries/index.js'

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
      React.createElement(AdminAiUsage, null)
    )
  )
}

function findButton(container, label) {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent.includes(label)
  )
}

function mockUsage(overrides = {}) {
  return {
    range: '24h',
    since: '2026-11-01T02:00:00.000Z',
    totals: {
      calls: 12,
      input_tokens: 3400,
      output_tokens: 900,
      cached_tokens: 2100,
      cache_hit_rate: 2100 / 3400,
    },
    users: [
      {
        user_id: 'u2',
        email: 'b@c.com',
        calls: 7,
        input_tokens: 2000,
        output_tokens: 500,
        cached_tokens: 1500,
        cache_hit_rate: 1500 / 2000,
        last_used: '2026-11-01T02:00:00.000Z',
      },
    ],
    ...overrides,
  }
}

// The suite's i18n mock returns raw keys, so assertions match keys and
// un-translated data (emails, percentages).
describe('AdminAiUsage', () => {
  beforeEach(() => {
    vi.mocked(useMe).mockReturnValue({ data: { user: { isAdmin: true } } })
    vi.mocked(useAdminAiUsage).mockReturnValue({
      data: mockUsage(),
      isLoading: false,
      isError: false,
    })
  })

  it('shows the forbidden state for non-admins', () => {
    vi.mocked(useMe).mockReturnValue({ data: { user: { isAdmin: false } } })
    const { container } = renderAdmin()
    expect(container.textContent).toContain('aiUsage.forbidden')
    expect(container.textContent).not.toContain('aiUsage.totalCalls')
  })

  it('defaults to the 24h range and renders totals + per-user rows', () => {
    const { container } = renderAdmin()
    expect(useAdminAiUsage).toHaveBeenCalledWith('24h')
    expect(container.textContent).toContain('aiUsage.totalCalls')
    expect(container.textContent).toContain('aiUsage.totalInput')
    expect(container.textContent).toContain('aiUsage.totalOutput')
    expect(container.textContent).toContain('b@c.com')
    expect(container.textContent).toContain('62%')
    expect(container.textContent).toContain('aiUsage.lastUsedColumn')
  })

  it('switching the range queries that range', () => {
    const { container } = renderAdmin()
    fireEvent.click(findButton(container, 'aiUsage.range7d'))
    expect(useAdminAiUsage).toHaveBeenCalledWith('7d')
    fireEvent.click(findButton(container, 'aiUsage.range30d'))
    expect(useAdminAiUsage).toHaveBeenCalledWith('30d')
  })

  it('renders "—" for users whose cache data is unreported, never 0%', () => {
    vi.mocked(useAdminAiUsage).mockReturnValue({
      data: mockUsage({
        totals: {
          calls: 5,
          input_tokens: 1400,
          output_tokens: 400,
          cached_tokens: null,
          cache_hit_rate: null,
        },
        users: [
          {
            user_id: 'u3',
            email: 'c@d.com',
            calls: 5,
            input_tokens: 1400,
            output_tokens: 400,
            cached_tokens: null,
            cache_hit_rate: null,
            last_used: '2026-10-30T01:00:00.000Z',
          },
        ],
      }),
      isLoading: false,
      isError: false,
    })
    const { container } = renderAdmin()
    expect(container.textContent).not.toContain('0%')
    expect(container.textContent).toContain('—')
    expect(container.textContent).toContain('c@d.com')
  })

  it('shows the empty state when the range has no usage', () => {
    vi.mocked(useAdminAiUsage).mockReturnValue({
      data: mockUsage({
        totals: {
          calls: 0,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: null,
          cache_hit_rate: null,
        },
        users: [],
      }),
      isLoading: false,
      isError: false,
    })
    const { container } = renderAdmin()
    expect(container.textContent).toContain('aiUsage.empty')
    expect(container.textContent).toContain('aiUsage.emptyDesc')
  })

  it('shows the error state when the query fails', () => {
    vi.mocked(useAdminAiUsage).mockReturnValue({ data: undefined, isLoading: false, isError: true })
    const { container } = renderAdmin()
    expect(container.textContent).toContain('aiUsage.loadError')
  })
})
