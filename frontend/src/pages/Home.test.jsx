import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { Home } from './Home.jsx'
import { useHome, usePlans } from '../lib/queries/index.js'
import { useMe } from '../lib/queries/me.js'
import { useApp } from '../context/AppContext.jsx'

const baseHomeData = {
  total_items: 24,
  expiring_7d: 1,
  running_out_7d: 2,
  attention_count: 3,
  current_month_spend: 1245000,
  current_month_receipts: 8,
  low_stock: [
    {
      id: 's1',
      name: 'Fresh milk',
      qty: 200,
      unit: 'ml',
      expiry_date: null,
      run_out_days: 1,
      basis: 'default',
      location: 'Fridge',
    },
    {
      id: 's2',
      name: 'Eggs',
      qty: 4,
      unit: 'pcs',
      expiry_date: null,
      run_out_days: 2,
      basis: 'default',
      location: 'Fridge',
    },
  ],
  next_trip: null,
}

vi.mock('../lib/queries/index.js', () => ({
  useHome: vi.fn(),
  usePlans: vi.fn(),
}))

vi.mock('../lib/queries/me.js', () => ({
  useMe: vi.fn(),
}))

vi.mock('../context/AppContext.jsx', () => ({
  useApp: vi.fn(),
}))

// The global test-setup t() mock returns raw keys; these tests assert real
// copy, so resolve en.json and interpolate like i18next (including the
// _one/_other plural suffixes).
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

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  })
}

function renderHome(props = {}) {
  return render(
    React.createElement(
      QueryClientProvider,
      { client: createQueryClient() },
      React.createElement(Home, { setView: vi.fn(), askAssistant: vi.fn(), ...props })
    )
  )
}

describe('Home', () => {
  beforeEach(() => {
    vi.mocked(useHome).mockReturnValue({ data: baseHomeData, isLoading: false })
    vi.mocked(usePlans).mockReturnValue({ data: { plans: [] } })
    vi.mocked(useMe).mockReturnValue({ data: { user: { name: 'Putri Wibowo' } } })
    vi.mocked(useApp).mockReturnValue({
      assistantSeed: null,
      setAssistantSeed: vi.fn(),
    })
  })

  it('renders the greeting with the user name and persona lead', () => {
    const { getByTestId, getByText } = renderHome()
    expect(getByTestId('home-greeting')).toBeTruthy()
    expect(getByText(/, Putri/).textContent).toMatch(/Good (morning|afternoon|evening)/)
    expect(getByTestId('home-greeting').textContent).toContain(
      'A calmer kitchen starts with what you already have'
    )
  })

  it('renders the three desktop stat cards with real values', () => {
    const { getByTestId } = renderHome()
    expect(getByTestId('stat-kitchen').textContent).toContain('24 essentials')
    expect(getByTestId('stat-attention').textContent).toContain('3 running low')
    expect(getByTestId('stat-spending').textContent).toContain('1.245.000')
    expect(getByTestId('stat-spending').textContent).toContain('8 confirmed receipts')
  })

  it('renders the mobile hero card', () => {
    const { getByTestId } = renderHome()
    expect(getByTestId('home-hero').textContent).toContain('Your kitchen, at a glance')
    expect(getByTestId('home-hero').textContent).toContain('24 essentials')
    expect(getByTestId('home-hero').textContent).toContain('3 may run low this week')
  })

  it('renders attention rows with badges', () => {
    const { getByTestId, getAllByText } = renderHome()
    expect(getByTestId('home-attention').textContent).toContain('Fresh milk')
    expect(getByTestId('home-attention').textContent).toContain('Eggs')
    // run_out_days 1 → critical, 2 → low soon
    expect(getAllByText('Critical').length).toBe(1)
    expect(getAllByText('Low soon').length).toBe(1)
  })

  it('navigates to inventory from an attention row and the view-all button', () => {
    const setView = vi.fn()
    const { getByText } = renderHome({ setView })
    fireEvent.click(getByText('Fresh milk'))
    expect(setView).toHaveBeenCalledWith('inventory')
    fireEvent.click(getByText('View inventory'))
    expect(setView).toHaveBeenCalledWith('inventory')
  })

  it('shows the empty state when nothing needs attention', () => {
    vi.mocked(useHome).mockReturnValue({
      data: { ...baseHomeData, low_stock: [], attention_count: 0 },
      isLoading: false,
    })
    const { getByText, queryByTestId } = renderHome()
    expect(getByText('All safe')).toBeTruthy()
    expect(queryByTestId('home-recipe-card')).toBeNull()
  })

  it('hides the plan teaser when there is no active plan', () => {
    const { queryByTestId } = renderHome()
    expect(queryByTestId('home-plan-teaser')).toBeNull()
  })

  it('renders the plan teaser from the active plan', () => {
    vi.mocked(usePlans).mockReturnValue({
      data: {
        plans: [
          {
            id: 'p1',
            total_estimate: 185000,
            items: [
              { id: 'i1', item_name: 'Milk', store_label: 'Indomaret', status: 'pending' },
              { id: 'i2', item_name: 'Eggs', store_label: 'Indomaret', status: 'pending' },
            ],
          },
        ],
      },
    })
    const setView = vi.fn()
    const { getByTestId, getByText } = renderHome({ setView })
    expect(getByTestId('home-plan-teaser').textContent).toContain('Shop at Indomaret')
    expect(getByTestId('home-plan-teaser').textContent).toContain('2 items')
    fireEvent.click(getByText('View plan'))
    expect(setView).toHaveBeenCalledWith('plan')
  })

  it('opens the assistant with a recipe seed from the recipe card', () => {
    const askAssistant = vi.fn()
    const setAssistantSeed = vi.fn()
    vi.mocked(useApp).mockReturnValue({ assistantSeed: null, setAssistantSeed })
    const { getByTestId, getByText } = renderHome({ askAssistant })
    expect(getByTestId('home-recipe-card')).toBeTruthy()
    fireEvent.click(getByText('Review meal suggestion'))
    expect(setAssistantSeed).toHaveBeenCalledWith(expect.stringContaining('recipe'))
    expect(askAssistant).toHaveBeenCalled()
  })

  it('renders the loading skeleton instead of content', () => {
    vi.mocked(useHome).mockReturnValue({ data: undefined, isLoading: true })
    const { queryByTestId } = renderHome()
    expect(queryByTestId('home-greeting')).toBeNull()
  })
})
