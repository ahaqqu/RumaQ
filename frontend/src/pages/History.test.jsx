import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
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

  it('shows the line contribution in the price cell so qty>1 rows reconcile with the month header (#583)', () => {
    // Mixed cart: 5 × Rp 13.000 + 1 × Rp 500 = Rp 65.500 month total. The
    // Gula row must show the Rp 65.000 it contributed (not the Rp 13.000
    // unit price), with the unit figure labeled beneath it (#597: the shared
    // household money formatter renders id-ID on every page — a no-break
    // space after Rp; the i18n mock returns raw keys).
    vi.mocked(useHistory).mockReturnValue({
      data: {
        purchases: [
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
                name: 'Gula',
                qty: 5,
                unit: 'kg',
                price: 13000,
                line_total: 65000,
              },
              {
                id: 'pi2',
                item_id: 'i2',
                name: 'Kantong',
                qty: 1,
                unit: null,
                price: 500,
                line_total: 500,
              },
            ],
          },
        ],
        next_cursor: null,
        month_totals: [{ month: '2026-07', count: 1, total: 65500 }],
        avg_per_month: 65500,
      },
      isLoading: false,
      isError: false,
      isFetching: false,
    })
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    expect(container.textContent).toContain('Rp\u00A065.000')
    // The per-unit figure rides the labeled secondary line; the i18n mock
    // returns the raw key, so the key is the pin.
    expect(container.textContent).toContain('history.perUnit')
    // qty=1 line: the contribution equals the unit price — no per-unit label.
    expect(container.textContent).toContain('Rp\u00A0500')
  })

  it('falls back to price × qty for rows without line_total, matching the server total formula (#583)', () => {
    // basePurchases carry no line_total: Milk is qty 2 @ Rp 18.500, so the
    // cell shows the Rp 37.000 the month header counted for that line.
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    expect(container.textContent).toContain('Rp\u00A037.000')
    expect(container.textContent).toContain('history.perUnit')
  })

  it('keeps qty=1 rows on the bare price with no per-unit label (#583)', () => {
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    // Bread is qty 1 @ Rp 20.000 with no line_total — contribution == price.
    expect(container.textContent).toContain('Rp\u00A020.000')
  })

  it('counts a legacy qty=0 line as the server does: 0 contribution (#597)', () => {
    // A legacy row with qty 0 @ Rp 20.000 and no line_total: the server's
    // COALESCE(line_total, price × qty) counts 0 for that line — the cell
    // must show the 0 contribution with the per-unit basis labeled beneath
    // (the figures differ), NOT the unit price. Pre-fix `it.qty || 1` showed
    // Rp 20.000 (the unit price) and hid the label as "equal" figures.
    vi.mocked(useHistory).mockReturnValue({
      data: {
        purchases: [
          {
            id: 'p1',
            store_id: null,
            store_label: null,
            date: '2026-07-15',
            total: 0,
            receipt_image_key: null,
            has_receipt: false,
            created_at: '2026-07-15T00:00:00Z',
            items: [{ id: 'pi1', item_id: null, name: 'Legacy', qty: 0, unit: null, price: 20000 }],
          },
        ],
        next_cursor: null,
        month_totals: [{ month: '2026-07', count: 1, total: 0 }],
        avg_per_month: 0,
      },
      isLoading: false,
      isError: false,
      isFetching: false,
    })
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    expect(container.textContent).toContain('history.perUnit')
    expect(container.textContent).not.toContain('Rp\u00A020.000')
  })

  it('keeps the legacy last-line total rendering on no-estimate lines (#518/#583)', () => {
    vi.mocked(useHistory).mockReturnValue({
      data: {
        purchases: [
          {
            id: 'p1',
            store_id: null,
            store_label: null,
            date: '2026-07-15',
            total: 25000,
            receipt_image_key: null,
            has_receipt: false,
            created_at: '2026-07-15T00:00:00Z',
            items: [{ id: 'pi1', item_id: null, name: null, qty: 1, unit: null, price: null }],
          },
        ],
        next_cursor: null,
        month_totals: [{ month: '2026-07', count: 1, total: 25000 }],
        avg_per_month: 25000,
      },
      isLoading: false,
      isError: false,
      isFetching: false,
    })
    const { container } = renderWithProviders(
      React.createElement(History, { askAssistant: vi.fn() })
    )
    // No price, no line_total: the single (last) line renders the purchase
    // total, never a fake "Rp 0".
    expect(container.textContent).toContain('Rp\u00A025.000')
    expect(container.textContent).not.toContain('history.perUnit')
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
