import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppProvider } from '../context/AppContext.jsx'
import { AppShell } from './AppShell.jsx'
import {
  useSettings,
  useUpdateSettings,
  useUsage,
  useSendChatMessage,
} from '../lib/queries/index.js'
import { useMe, useLogout } from '../lib/queries/me.js'

// The global test-setup t() mock returns raw keys; these tests assert real
// copy, so resolve en.json and interpolate like i18next.
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

vi.mock('../lib/queries/me.js', () => ({
  useMe: vi.fn(),
  useLogout: vi.fn(),
}))

vi.mock('../lib/queries/index.js', () => ({
  useSettings: vi.fn(),
  useUpdateSettings: vi.fn(),
  useUsage: vi.fn(),
  useSendChatMessage: vi.fn(),
}))

function renderWithProviders(ui) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(AppProvider, null, ui)
    )
  )
}

describe('AppShell', () => {
  beforeEach(() => {
    vi.mocked(useMe).mockReturnValue({
      data: { user: { id: 'u1', email: 'a@b.com', name: 'Alice', picture: null } },
      isLoading: false,
    })
    vi.mocked(useLogout).mockReturnValue({ mutate: vi.fn(), data: null })
    vi.mocked(useSettings).mockReturnValue({
      data: { has_ai_key: false, active_household_name: 'Keluarga Putri' },
    })
    vi.mocked(useUpdateSettings).mockReturnValue({ mutate: vi.fn() })
    // Assistant is mounted by the shell; it consumes usage + chat hooks.
    vi.mocked(useUsage).mockReturnValue({ data: { used: 3, daily_limit: 20 } })
    vi.mocked(useSendChatMessage).mockReturnValue({ mutateAsync: vi.fn(), isPending: false })
  })

  it('renders the shell with sidebar, header, and children', () => {
    const { container } = renderWithProviders(
      React.createElement(AppShell, null, React.createElement('div', { id: 'test-child' }, 'x'))
    )
    expect(container.querySelector('aside')).toBeTruthy()
    expect(container.querySelector('header')).toBeTruthy()
    expect(container.querySelector('#test-child')).toBeTruthy()
  })

  it('renders the household card from settings', () => {
    const { getByTestId, getByText } = renderWithProviders(
      React.createElement(AppShell, null, null)
    )
    expect(getByTestId('household-card').textContent).toContain('Keluarga Putri')
    expect(getByText('Your shared kitchen')).toBeTruthy()
  })

  it('omits the household card when the household name is unknown', () => {
    vi.mocked(useSettings).mockReturnValue({ data: { has_ai_key: false } })
    const { queryByTestId } = renderWithProviders(React.createElement(AppShell, null, null))
    expect(queryByTestId('household-card')).toBeNull()
  })

  it('renders the desktop header breadcrumb and primary action', () => {
    const { container } = renderWithProviders(React.createElement(AppShell, null, null))
    expect(container.textContent).toContain('Your household / Home')
    expect(
      container.querySelector('a[aria-label="Add from Receipt"]') ||
        container.querySelector('a[href="/add"]')
    ).toBeTruthy()
  })

  it('switches language from the header and persists via settings', () => {
    const mutate = vi.fn()
    vi.mocked(useUpdateSettings).mockReturnValue({ mutate })
    const { getByText } = renderWithProviders(React.createElement(AppShell, null, null))
    fireEvent.click(getByText('ID'))
    expect(mutate).toHaveBeenCalledWith({ language: 'id' })
  })

  it('renders the mobile tab bar with the center Post photo action', () => {
    const { container } = renderWithProviders(React.createElement(AppShell, null, null))
    expect(container.querySelector('a[aria-label="Post photo"]')).toBeTruthy()
  })

  it('hides admin nav for regular users and shows it for admins', () => {
    const { container } = renderWithProviders(React.createElement(AppShell, null, null))
    expect(container.textContent).not.toContain('Household admin')

    vi.mocked(useMe).mockReturnValue({
      data: { user: { id: 'u1', email: 'a@b.com', name: 'Alice', isAdmin: true } },
      isLoading: false,
    })
    const adminView = renderWithProviders(React.createElement(AppShell, null, null))
    expect(adminView.container.textContent).toContain('Household admin')
    expect(adminView.container.textContent).toContain('Scraper Monitor')
  })

  it('renders the account block and calls logout', () => {
    const mutate = vi.fn()
    vi.mocked(useLogout).mockReturnValue({ mutate, data: null })
    const { getByText } = renderWithProviders(React.createElement(AppShell, null, null))
    expect(getByText('Alice').textContent).toBe('Alice')
    fireEvent.click(getByText('Logout'))
    expect(mutate).toHaveBeenCalled()
  })

  it('renders the user avatar image when a picture is available', () => {
    vi.mocked(useMe).mockReturnValue({
      data: { user: { id: 'u1', email: 'a@b.com', name: 'Alice', picture: 'https://x/y.png' } },
      isLoading: false,
    })
    const { container } = renderWithProviders(React.createElement(AppShell, null, null))
    expect(container.querySelector('img[src="https://x/y.png"]')).toBeTruthy()
  })

  it('does not render the AI usage meter in the sidebar (it lives in the assistant)', () => {
    const { container } = renderWithProviders(React.createElement(AppShell, null, null))
    expect(container.textContent).not.toContain('requests today')
  })
})
