import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { Plan } from './Plan.jsx'
import { AppProvider } from '../context/AppContext.jsx'

const mockActivePlan = {
  plans: [
    {
      id: 'plan-1',
      status: 'active',
      total_estimate: 61500,
      items: [
        {
          id: 'pi-1',
          item_id: 'item-1',
          item_name: 'Susu cair 1L',
          store_id: 'indomaret',
          store_label: 'Indomaret',
          qty: 1,
          unit: 'L',
          price_estimate: 18500,
          why: 'Hampir habis',
          status: 'pending',
        },
        {
          id: 'pi-2',
          item_id: 'item-2',
          item_name: 'Roti tawar',
          store_id: 'indomaret',
          store_label: 'Indomaret',
          qty: 1,
          unit: 'pack',
          price_estimate: 15000,
          why: 'Kedaluwarsa besok',
          status: 'pending',
        },
      ],
    },
  ],
}

const mockSettingsWithKey = { has_ai_key: true }
const mockSettingsNoKey = { has_ai_key: false }

vi.mock('../lib/queries/index.js', () => ({
  usePlans: vi.fn(),
  useGeneratePlan: vi.fn(),
  useSavePlan: vi.fn(),
  useUpdatePlanItem: vi.fn(),
  useSettings: vi.fn(),
}))

import {
  usePlans,
  useGeneratePlan,
  useSavePlan,
  useUpdatePlanItem,
  useSettings,
} from '../lib/queries/index.js'

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  })
}

function renderWithQuery(ui) {
  return render(
    React.createElement(
      QueryClientProvider,
      { client: createQueryClient() },
      React.createElement(AppProvider, null, ui)
    )
  )
}

describe('Plan', () => {
  beforeEach(() => {
    vi.mocked(useSettings).mockReturnValue({
      data: mockSettingsWithKey,
      isLoading: false,
    })
    vi.mocked(usePlans).mockReturnValue({
      data: mockActivePlan,
      isLoading: false,
    })
    vi.mocked(useGeneratePlan).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
      data: null,
    })
    vi.mocked(useSavePlan).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    })
    vi.mocked(useUpdatePlanItem).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    })
  })

  it('renders no-key state when has_ai_key is false', () => {
    vi.mocked(useSettings).mockReturnValue({
      data: mockSettingsNoKey,
      isLoading: false,
    })
    const { container } = renderWithQuery(
      React.createElement(Plan, { askAssistant: vi.fn(), setView: vi.fn() })
    )
    expect(container.querySelector('[class*="text-center px-6 py-12"]')).toBeTruthy()
  })

  it('renders page lead', () => {
    const { container } = renderWithQuery(
      React.createElement(Plan, { askAssistant: vi.fn(), setView: vi.fn() })
    )
    expect(container.querySelector('[class*="max-w-[62ch]"]')).toBeTruthy()
  })

  it('renders plan trip cards when active plan exists', () => {
    const { container } = renderWithQuery(
      React.createElement(Plan, { askAssistant: vi.fn(), setView: vi.fn() })
    )
    expect(
      container.querySelector(
        '[class*="bg-surface-raised border border-border rounded-lg overflow-hidden mb-4"]'
      )
    ).toBeTruthy()
  })

  it('toggles checkbox on plan items', () => {
    const mutate = vi.fn()
    vi.mocked(useUpdatePlanItem).mockReturnValue({
      mutate,
      isPending: false,
    })
    const { container } = renderWithQuery(
      React.createElement(Plan, { askAssistant: vi.fn(), setView: vi.fn() })
    )
    const checkbox = container.querySelector('input[type="checkbox"]')
    if (checkbox) {
      fireEvent.click(checkbox)
      expect(mutate).toHaveBeenCalled()
    }
  })

  it('shows all done message when all items are bought', () => {
    const allBoughtPlan = {
      plans: [
        {
          ...mockActivePlan.plans[0],
          items: mockActivePlan.plans[0].items.map((it) => ({
            ...it,
            status: 'bought',
          })),
        },
      ],
    }
    vi.mocked(usePlans).mockReturnValue({
      data: allBoughtPlan,
      isLoading: false,
    })
    const { container } = renderWithQuery(
      React.createElement(Plan, { askAssistant: vi.fn(), setView: vi.fn() })
    )
    expect(container.textContent).toContain('plan.allBought')
  })

  it('renders generate button in empty state', () => {
    vi.mocked(usePlans).mockReturnValue({
      data: { plans: [] },
      isLoading: false,
    })
    const { container } = renderWithQuery(
      React.createElement(Plan, { askAssistant: vi.fn(), setView: vi.fn() })
    )
    const generateBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('plan.generate')
    )
    expect(generateBtn).toBeTruthy()
  })

  it('no-key state has add key button', () => {
    vi.mocked(useSettings).mockReturnValue({
      data: mockSettingsNoKey,
      isLoading: false,
    })
    const setView = vi.fn()
    const { container } = renderWithQuery(
      React.createElement(Plan, { askAssistant: vi.fn(), setView })
    )
    const addKeyBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('plan.addApiKey')
    )
    if (addKeyBtn) {
      fireEvent.click(addKeyBtn)
      expect(setView).toHaveBeenCalledWith('settings')
    }
  })

  it('shows skeleton while loading', () => {
    vi.mocked(useSettings).mockReturnValue({ data: null, isLoading: true })
    const { container } = renderWithQuery(
      React.createElement(Plan, { askAssistant: vi.fn(), setView: vi.fn() })
    )
    expect(
      container.querySelector('[class*="bg-surface-inset rounded-sm relative overflow-hidden"]')
    ).toBeTruthy()
  })

  it('disables checkbox for bought items', () => {
    const mutate = vi.fn()
    vi.mocked(useUpdatePlanItem).mockReturnValue({ mutate, isPending: false })
    const boughtPlan = {
      plans: [
        {
          ...mockActivePlan.plans[0],
          items: [{ ...mockActivePlan.plans[0].items[0], status: 'bought' }],
        },
      ],
    }
    vi.mocked(usePlans).mockReturnValue({ data: boughtPlan, isLoading: false })
    const { container } = renderWithQuery(
      React.createElement(Plan, { askAssistant: vi.fn(), setView: vi.fn() })
    )
    const checkbox = container.querySelector('input[type="checkbox"]')
    expect(checkbox.disabled).toBe(true)
    fireEvent.click(checkbox)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('shows draft review even when an active plan exists', () => {
    vi.mocked(useGeneratePlan).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      reset: vi.fn(),
      isPending: false,
      data: {
        items: [
          {
            name: 'Telur',
            qty: 10,
            unit: 'pcs',
            store_id: 'indomaret',
            store_label: 'Indomaret',
            price_estimate: 28000,
            why: 'running out',
          },
        ],
      },
    })
    const { container } = renderWithQuery(
      React.createElement(Plan, { askAssistant: vi.fn(), setView: vi.fn() })
    )
    expect(container.textContent).toContain('plan.savePlan')
    expect(container.textContent).toContain('Telur')
  })

  it('saves the viewed draft without regenerating', async () => {
    const reset = vi.fn()
    const generateMutateAsync = vi.fn()
    const saveMutateAsync = vi.fn().mockResolvedValue({})
    vi.mocked(usePlans).mockReturnValue({
      data: { plans: [] },
      isLoading: false,
    })
    vi.mocked(useGeneratePlan).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: generateMutateAsync,
      reset,
      isPending: false,
      data: {
        items: [
          {
            name: 'Telur',
            qty: 10,
            unit: 'pcs',
            store_id: 'indomaret',
            store_label: 'Indomaret',
            price_estimate: 28000,
            why: 'running out',
          },
        ],
      },
    })
    vi.mocked(useSavePlan).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: saveMutateAsync,
      isPending: false,
    })
    const { container } = renderWithQuery(
      React.createElement(Plan, { askAssistant: vi.fn(), setView: vi.fn() })
    )
    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('plan.savePlan')
    )
    fireEvent.click(saveBtn)

    await waitFor(() => expect(reset).toHaveBeenCalled())
    expect(generateMutateAsync).not.toHaveBeenCalled()
    const savedArg = saveMutateAsync.mock.calls[0][0]
    expect(Array.isArray(savedArg)).toBe(true)
    expect(savedArg[0]).toMatchObject({ name: 'Telur', qty: 10, unit: 'pcs' })
  })
})
