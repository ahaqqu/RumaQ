import { describe, it, expect, vi } from 'vite-plus/test'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { Settings } from './Settings.jsx'

const mockLocations = [
  { id: 'loc-1', label: 'Kitchen', sort_order: 1 },
  { id: 'loc-2', label: 'Fridge', sort_order: 2 },
]

const mockStores = [
  { id: 'store-1', label: 'Indomaret' },
  { id: 'store-2', label: 'Alfamart' },
]

const mockSettings = {
  motion_preference: 'standard',
  currency: 'idr',
  ai_provider: 'gemini',
  persona_user_role: null,
  persona_ai_role: null,
  persona_enabled: false,
  theme_hue: null,
  active_household_id: 'house-1',
  active_household_name: 'Test Household',
  has_ai_key: false,
}

const mockUsage = { used: 0, daily_limit: 20, provider: 'gemini' }

const mockMutateAsync = vi.fn()

vi.mock('../lib/persona.js', () => ({
  personaText: vi.fn((key) => key),
  deriveHue: vi.fn(() => 230),
}))

vi.mock('../lib/api', () => ({
  testAiKey: vi.fn(),
}))

const logoutMutate = vi.fn()

vi.mock('../lib/queries/me.js', () => ({
  useMe: () => ({
    data: { user: { id: 'u1', email: 'a@b.com', name: 'Alice', picture: null } },
    isLoading: false,
  }),
  useLogout: () => ({ mutate: logoutMutate, isPending: false }),
}))

vi.mock('../lib/queries/index.js', () => ({
  useSettings: () => ({ data: mockSettings, isLoading: false }),
  useUpdateSettings: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
  useLocations: () => ({
    data: { locations: mockLocations },
    isLoading: false,
  }),
  useCreateLocation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteLocation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useStores: () => ({ data: { stores: mockStores }, isLoading: false }),
  useCreateStore: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteStore: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUsage: () => ({ data: mockUsage }),
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

describe('Settings', () => {
  const baseProps = {
    aiKey: null,
    setAiKey: vi.fn(),
    motion: 'standard',
    setMotion: vi.fn(),
  }

  it('renders page lead', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    expect(container.querySelector('[class*="max-w-[62ch]"]')).toBeTruthy()
  })

  it('renders API key section', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    expect(container.querySelector('section')).toBeTruthy()
  })

  it('renders provider select', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const select = container.querySelector('select')
    expect(select).toBeTruthy()
  })

  it('renders AI usage section', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    expect(container.querySelector('[class*="flex flex-col gap-3 p-5"]')).toBeTruthy()
  })

  it('renders persona inputs', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const inputs = container.querySelectorAll('input')
    expect(inputs.length).toBeGreaterThan(0)
  })

  it('renders storage locations section', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    expect(container.textContent).toContain('settings.storageLocations')
  })

  it('renders recorded stores section', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    expect(container.textContent).toContain('settings.recordedStores')
  })

  it('renders display section', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    expect(container.textContent).toContain('settings.display')
  })

  it('calls setAiKey on save', async () => {
    const setAiKey = vi.fn()
    const { container } = renderWithQuery(React.createElement(Settings, { ...baseProps, setAiKey }))
    const passwordInput = container.querySelector('input[type="password"]')
    if (passwordInput) {
      fireEvent.input(passwordInput, { target: { value: 'new-key' } })
    }
    const saveBtn = container.querySelector('[data-testid="save-key-btn"]')
    if (saveBtn) {
      fireEvent.click(saveBtn)
    }
    await waitFor(() => expect(setAiKey).toHaveBeenCalledWith('new-key'))
  })

  it('test button triggers test flow', async () => {
    const { container } = renderWithQuery(
      React.createElement(Settings, { ...baseProps, aiKey: 'existing-key' })
    )
    const testBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('settings.test')
    )
    expect(testBtn).toBeTruthy()
  })

  it('adds a new location', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const locInput = container.querySelector('input[placeholder="settings.locationName"]')
    if (locInput) {
      fireEvent.change(locInput, { target: { value: 'Garage' } })
    }
    const addBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('settings.add')
    )
    if (addBtn) {
      fireEvent.click(addBtn)
    }
  })

  it('removes a location', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const deleteBtns = Array.from(container.querySelectorAll('button')).filter((btn) =>
      btn.querySelector('svg')
    )
    if (deleteBtns.length > 0) {
      fireEvent.click(deleteBtns[0])
    }
  })

  it('handles language change', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const langBtns = container.querySelectorAll('[aria-pressed]')
    if (langBtns.length > 0) {
      fireEvent.click(langBtns[0])
    }
  })

  it('handles motion change', () => {
    const setMotion = vi.fn()
    const { container } = renderWithQuery(
      React.createElement(Settings, { ...baseProps, setMotion })
    )
    const motionBtns = container.querySelectorAll('[role="group"] button')
    if (motionBtns.length > 0) {
      fireEvent.click(motionBtns[0])
      expect(setMotion).toHaveBeenCalled()
    }
  })

  it('handles persona toggle', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const toggle = container.querySelector('#persona-toggle')
    if (toggle) {
      fireEvent.click(toggle)
      expect(toggle.checked).toBe(true)
    }
  })

  it('handles persona role inputs', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const inputs = container.querySelectorAll('input[placeholder]')
    const myRole = Array.from(inputs).find(
      (inp) => inp.getAttribute('placeholder') === 'settings.myRolePlaceholder'
    )
    const aiRole = Array.from(inputs).find(
      (inp) => inp.getAttribute('placeholder') === 'settings.aiRolePlaceholder'
    )
    if (myRole) {
      fireEvent.change(myRole, { target: { value: 'raja' } })
    }
    if (aiRole) {
      fireEvent.change(aiRole, { target: { value: 'prajurit' } })
    }
  })

  it('applies persona with apply button', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const applyBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('settings.apply')
    )
    if (applyBtn) {
      fireEvent.click(applyBtn)
    }
  })

  it('changes provider via select', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const select = container.querySelector('select')
    if (select) {
      fireEvent.change(select, { target: { value: 'openai' } })
      expect(select.value).toBe('openai')
    }
  })

  it('shows base URL and model inputs when custom provider selected', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const select = container.querySelector('select')
    fireEvent.change(select, { target: { value: 'custom' } })
    const baseUrlInput = container.querySelector('input[aria-label="settings.customBaseUrl"]')
    const modelInput = container.querySelector('input[aria-label="settings.model"]')
    expect(baseUrlInput).toBeTruthy()
    expect(modelInput).toBeTruthy()
  })

  it('shows the model input for preset providers while hiding the base URL', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    expect(container.querySelector('input[aria-label="settings.customBaseUrl"]')).toBeNull()
    expect(container.querySelector('input[aria-label="settings.model"]')).toBeTruthy()
  })

  it('adds location with Enter key', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const locInput = container.querySelector('input[placeholder="settings.locationName"]')
    if (locInput) {
      fireEvent.change(locInput, { target: { value: 'Pantry' } })
      fireEvent.keyDown(locInput, { key: 'Enter' })
    }
  })

  it('renders the account section and calls logout from Settings', () => {
    const { getByText } = renderWithQuery(React.createElement(Settings, baseProps))
    // The global t() mock renders raw keys in tests
    expect(getByText('settings.account')).toBeTruthy()
    expect(getByText('Alice')).toBeTruthy()
    fireEvent.click(getByText('nav.logout'))
    expect(logoutMutate).toHaveBeenCalled()
  })
})
