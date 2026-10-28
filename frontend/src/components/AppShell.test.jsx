import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppProvider } from '../context/AppContext.jsx'
import { AppShell } from './AppShell.jsx'
import { useSettings, useUsage, useSendChatMessage } from '../lib/queries/index.js'
import { useMe, useLogout } from '../lib/queries/me.js'

// The global test-setup t() mock returns raw keys; these tests assert the
// rendered token counts, so resolve en.json and interpolate like i18next.
vi.mock('react-i18next', async () => {
  const { vi } = await import('vite-plus/test')
  const en = (await import('../i18n/locales/en.json')).default
  const t = (key, opts) => {
    if (opts && opts.returnObjects) return {}
    const template = key.split('.').reduce((node, k) => (node == null ? node : node[k]), en)
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

const mockUsage = { used: 17, daily_limit: 20, provider: 'Gemini' }

vi.mock('../lib/queries/me.js', () => ({
  useMe: vi.fn(),
  useLogout: vi.fn(),
}))

vi.mock('../lib/queries/index.js', () => ({
  useSettings: vi.fn(),
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
    vi.mocked(useSettings).mockReturnValue({ data: { has_ai_key: false } })
    vi.mocked(useUsage).mockReturnValue({ data: mockUsage })
    vi.mocked(useSendChatMessage).mockReturnValue({ mutateAsync: vi.fn(), isPending: false })
  })

  it('renders app shell', () => {
    const { container } = renderWithProviders(
      React.createElement(AppShell, null, React.createElement('div', null, 'content'))
    )
    expect(container.querySelector('[class*="min-h-dvh"]')).toBeTruthy()
  })

  it('renders rail navigation', () => {
    const { container } = renderWithProviders(
      React.createElement(AppShell, null, React.createElement('div', null, 'content'))
    )
    expect(container.querySelector('aside')).toBeTruthy()
  })

  it('renders children', () => {
    const { container } = renderWithProviders(
      React.createElement(AppShell, null, React.createElement('div', { id: 'test-child' }))
    )
    expect(container.querySelector('#test-child')).toBeTruthy()
  })

  it('renders bottom bar navigation', () => {
    const { container } = renderWithProviders(
      React.createElement(AppShell, null, React.createElement('div', null, 'content'))
    )
    expect(container.querySelector('nav[aria-label="Home"]')).toBeTruthy()
  })

  it('renders topbar', () => {
    const { container } = renderWithProviders(
      React.createElement(AppShell, null, React.createElement('div', null, 'content'))
    )
    expect(container.querySelector('header')).toBeTruthy()
  })

  it('renders user initials when no picture', () => {
    const { container } = renderWithProviders(
      React.createElement(AppShell, null, React.createElement('div', null, 'content'))
    )
    const initials = Array.from(container.querySelectorAll('[class*="rounded-pill"]')).find(
      (el) => el.textContent === 'A'
    )
    expect(initials).toBeTruthy()
  })

  it('calls logout on logout button click', () => {
    const mutate = vi.fn()
    vi.mocked(useLogout).mockReturnValue({ mutate, data: null })
    const { container } = renderWithProviders(
      React.createElement(AppShell, null, React.createElement('div', null, 'content'))
    )
    const logoutBtn = container.querySelector('button.text-xs.text-text-muted')
    if (logoutBtn) fireEvent.click(logoutBtn)
    expect(mutate).toHaveBeenCalled()
  })

  it('shows AI connected state when settings has_ai_key is true', () => {
    vi.mocked(useSettings).mockReturnValue({ data: { has_ai_key: true } })
    const { container } = renderWithProviders(
      React.createElement(AppShell, null, React.createElement('div', null, 'content'))
    )
    expect(container.querySelector('[class*="h-[5px]"]')).toBeTruthy()
  })

  it('shows danger usage tone', () => {
    vi.mocked(useSettings).mockReturnValue({ data: { has_ai_key: true } })
    vi.mocked(useUsage).mockReturnValue({ data: { used: 20, daily_limit: 20, provider: 'Gemini' } })
    const { container } = renderWithProviders(
      React.createElement(AppShell, null, React.createElement('div', null, 'content'))
    )
    expect(container.querySelector('.text-danger')).toBeTruthy()
  })

  it('shows token usage without a cap meter for own-key users', () => {
    vi.mocked(useSettings).mockReturnValue({ data: { has_ai_key: true } })
    vi.mocked(useUsage).mockReturnValue({
      data: {
        used: 3,
        daily_limit: 20,
        provider: 'ollama',
        input_tokens: 18230,
        output_tokens: 6100,
        key_source: 'user',
      },
    })
    const { container } = renderWithProviders(
      React.createElement(AppShell, null, React.createElement('div', null, 'content'))
    )
    expect(container.querySelector('[class*="h-[5px]"]')).toBeNull()
    expect(container.textContent).toContain('18.2k in · 6.1k out today · your own key')
  })
})
