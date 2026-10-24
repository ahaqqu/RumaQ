import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { History } from './History.jsx'
import { useHistory, usePurchasePatterns, useStores } from '../lib/queries/index.js'

const basePurchases = [
  {
    id: 'p1',
    store_id: 's1',
    store_label: 'Indomaret',
    date: '2026-07-15',
    total: 65500,
    receipt_image_key: null,
    has_receipt: false,
    created_at: '2026-07-15T00:00:00Z',
    items: [
      {
        id: 'pi1',
        item_id: 'i1',
        name: 'Milk',
        qty: 2,
        unit: 'L',
        price: 18500,
      },
    ],
  },
  {
    id: 'p2',
    store_id: null,
    store_label: null,
    date: '2026-06-20',
    total: 20000,
    receipt_image_key: 'r2',
    has_receipt: true,
    created_at: '2026-06-20T00:00:00Z',
    items: [
      {
        id: 'pi2',
        item_id: 'i2',
        name: 'Bread',
        qty: 1,
        unit: 'pack',
        price: 20000,
      },
    ],
  },
]

const baseHistoryData = {
  purchases: basePurchases,
  next_cursor: null,
  month_totals: [
    { month: '2026-07', count: 1, total: 65500 },
    { month: '2026-06', count: 1, total: 20000 },
  ],
  avg_per_month: 42750,
}

vi.mock('../lib/api', () => ({
  getReceiptUrl: (id) => `/api/purchases/${id}/receipt`,
}))

vi.mock('../lib/queries/index.js', () => ({
  useHistory: vi.fn(),
  usePurchasePatterns: vi.fn(),
  useStores: vi.fn(),
}))

function renderWithProviders(ui) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(React.createElement(QueryClientProvider, { client: queryClient }, ui))
}

describe('History', () => {
  beforeEach(() => {
    vi.mocked(useHistory).mockReturnValue({
      data: baseHistoryData,
      isLoading: false,
      isError: false,
      isFetching: false,
    })
    vi.mocked(usePurchasePatterns).mockReturnValue({
      data: {
        patterns: [
          {
            item_id: 'i1',
            name: 'Milk',
            avg_interval_days: 7,
            avg_qty: 2,
            last_purchase_date: '2026-07-15',
            pattern: 'every 7 days',
            purchase_count: 4,
          },
        ],
      },
      isLoading: false,
      isError: false,
    })
    vi.mocked(useStores).mockReturnValue({ data: { stores: [] }, isLoading: false })
  })

  it('renders page lead', () => {
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    expect(container.querySelector('[class*="max-w-[62ch]"]')).toBeTruthy()
  })

  it('renders table', () => {
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    expect(container.querySelector('table')).toBeTruthy()
  })

  it('renders month groups', () => {
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    const rows = container.querySelectorAll('tbody tr')
    expect(rows.length).toBeGreaterThan(0)
  })

  it('renders month separators', () => {
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    const monthSep = container.querySelector('.bg-surface-sunken')
    expect(monthSep).toBeTruthy()
  })

  it('renders patterns section', () => {
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    expect(container.textContent).toContain('Milk')
  })

  it('renders make plan button that calls askAssistant', () => {
    const askAssistant = vi.fn()
    const { container } = renderWithProviders(React.createElement(History, { askAssistant }))
    const sectionBtn = Array.from(container.querySelectorAll('section button')).find((b) =>
      b.textContent?.includes('history.makePlan')
    )
    expect(sectionBtn).toBeTruthy()
    fireEvent.click(sectionBtn)
    expect(askAssistant).toHaveBeenCalled()
  })

  it('renders empty state when no purchases', () => {
    vi.mocked(useHistory).mockReturnValue({
      data: { purchases: [], next_cursor: null, month_totals: [], avg_per_month: 0 },
      isLoading: false,
      isError: false,
      isFetching: false,
    })
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    expect(container.querySelector('.font-semibold.text-text.text-sm')).toBeTruthy()
  })

  it('renders error state', () => {
    vi.mocked(useHistory).mockReturnValue({
      data: null,
      isLoading: false,
      isError: true,
      isFetching: false,
    })
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    expect(container.textContent).toContain('history.error')
  })

  it('renders loading state', () => {
    vi.mocked(useHistory).mockReturnValue({
      data: null,
      isLoading: true,
      isError: false,
      isFetching: false,
    })
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    expect(container.textContent).toContain('history.loading')
  })

  it('filters by search input', () => {
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    const input = container.querySelector('input[type="search"]')
    if (input) {
      fireEvent.change(input, { target: { value: 'Milk' } })
    }
  })

  it('renders receipt button and opens lightbox', () => {
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    const receiptBtn = container.querySelector('button[aria-label="history.receipt"]')
    expect(receiptBtn).toBeTruthy()
    if (receiptBtn) {
      fireEvent.click(receiptBtn)
      expect(container.querySelector('img[alt="history.receipt"]')).toBeTruthy()
    }
  })

  it('closes lightbox on scrim click', () => {
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    const receiptBtn = container.querySelector('button[aria-label="history.receipt"]')
    if (receiptBtn) fireEvent.click(receiptBtn)
    const scrim = container.querySelector('[class*="fixed inset-0 z-50 bg-text/32"]')
    if (scrim) fireEvent.click(scrim)
    expect(container.querySelector('img[alt="history.receipt"]')).toBeFalsy()
  })

  it('loads more when cursor exists', () => {
    vi.mocked(useHistory).mockReturnValue({
      data: { ...baseHistoryData, next_cursor: '2026-06-20|x' },
      isLoading: false,
      isError: false,
      isFetching: false,
    })
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    const loadMoreBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('history.loadMore')
    )
    expect(loadMoreBtn).toBeTruthy()
  })

  it('renders store filter options', () => {
    vi.mocked(useStores).mockReturnValue({
      data: { stores: [{ id: 's1', label: 'Indomaret' }] },
      isLoading: false,
    })
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    const select = container.querySelector('select')
    expect(select).toBeTruthy()
  })

  it('handles avg_interval_days null in patterns', () => {
    vi.mocked(usePurchasePatterns).mockReturnValue({
      data: {
        patterns: [
          {
            item_id: 'i2',
            name: 'Bread',
            avg_interval_days: null,
            avg_qty: 1,
            last_purchase_date: '2026-06-20',
            pattern: 'recently purchased',
            purchase_count: 1,
          },
        ],
      },
      isLoading: false,
      isError: false,
    })
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    expect(container.textContent).toContain('Bread')
  })
})
