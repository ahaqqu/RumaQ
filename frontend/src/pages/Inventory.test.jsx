import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test'
import { render, fireEvent, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { Inventory } from './Inventory.jsx'

const mockStock = [
  {
    id: 's1',
    name: 'Cooking Oil',
    qty: 0.5,
    unit: 'L',
    expiry_date: null,
    run_out_days: 3,
    basis: 'default',
    location: 'Kitchen',
  },
  {
    id: 's2',
    name: 'Eggs',
    qty: 10,
    unit: 'pcs',
    expiry_date: null,
    run_out_days: 7,
    basis: 'default',
    location: 'Fridge',
  },
]

const mockLocations = [
  { id: 'loc-1', label: 'Kitchen', sort_order: 1 },
  { id: 'loc-2', label: 'Fridge', sort_order: 2 },
  { id: 'loc-3', label: 'Pantry', sort_order: 3 },
]

vi.mock('../lib/queries/index.js', () => ({
  useStock: ({ location, q }) => {
    let filtered = [...mockStock]
    if (location)
      filtered = filtered.filter((s) => s.location === location || s.location_id === location)
    if (q) filtered = filtered.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()))
    return { data: { stock: filtered }, isLoading: false }
  },
  useUpdateStock: () => ({ mutate: vi.fn(), isPending: false }),
  useLocations: () => ({ data: { locations: mockLocations } }),
}))

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  })
}

function renderWithQuery(ui) {
  return render(
    React.createElement(QueryClientProvider, {
      client: createQueryClient(),
      children: ui,
    })
  )
}

describe('Inventory', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders page lead', () => {
    const { container } = renderWithQuery(React.createElement(Inventory))
    expect(container.querySelector('[class*="max-w-[62ch]"]')).toBeTruthy()
  })

  it('renders search input', () => {
    const { container } = renderWithQuery(React.createElement(Inventory))
    expect(container.querySelector('input')).toBeTruthy()
  })

  it('renders location filter chips', () => {
    const { container } = renderWithQuery(React.createElement(Inventory))
    const chips = container.querySelectorAll('[class*="rounded-pill"]')
    expect(chips.length).toBeGreaterThan(0)
  })

  it('renders stock list', () => {
    const { container } = renderWithQuery(React.createElement(Inventory))
    expect(container.querySelector('[class*="flex flex-col"]')).toBeTruthy()
  })

  it('shows items in the list', () => {
    const { container } = renderWithQuery(React.createElement(Inventory))
    const rows = container.querySelectorAll('[class*="grid-cols-[1fr_auto]"]')
    expect(rows.length).toBeGreaterThan(0)
  })

  it('shows empty state when search yields no results', () => {
    const { container } = renderWithQuery(React.createElement(Inventory))
    const input = container.querySelector('input')
    if (input) {
      fireEvent.change(input, { target: { value: 'zzzzzznotfound' } })
      act(() => {
        vi.advanceTimersByTime(400)
      })
    }
    expect(container.querySelector('[class*="text-center px-6 py-12"]')).toBeTruthy()
  })

  it('filters by location chip click', () => {
    const { container } = renderWithQuery(React.createElement(Inventory))
    const chips = container.querySelectorAll('[class*="rounded-pill"]')
    if (chips.length > 1) {
      fireEvent.click(chips[1])
      expect(chips[1].getAttribute('aria-pressed')).toBe('true')
    }
  })

  it('resets to all locations', () => {
    const { container } = renderWithQuery(React.createElement(Inventory))
    const chips = container.querySelectorAll('[class*="rounded-pill"]')
    if (chips.length > 1) {
      fireEvent.click(chips[1])
      fireEvent.click(chips[0])
      expect(chips[0].getAttribute('aria-pressed')).toBe('true')
    }
  })
})
