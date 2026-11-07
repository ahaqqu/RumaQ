import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppProvider } from '../context/AppContext.jsx'
import { PluginCatalogProvider } from '../plugins/context.jsx'
import { AppShell } from './AppShell.jsx'
import {
  useSettings,
  useUpdateSettings,
  useUsage,
  useSendChatMessage,
  useHouseholds,
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
  useHouseholds: vi.fn(),
}))

// The global test-setup pins useMatches to '/', but the page-title lookup
// must be exercised on a plugin route (a deep link into a disabled plugin
// shows the real page name, not the "Home" fallback). This file-local mock
// overrides the setup's for this file, with a redirectable route id.
const routerState = vi.hoisted(() => ({ routeId: '/' }))
vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual('@tanstack/react-router')
  return {
    ...actual,
    useMatches: () => [{ routeId: routerState.routeId, pathname: routerState.routeId }],
    useNavigate: () => vi.fn(),
    Link: ({ children, to, className, ...props }) =>
      React.createElement('a', { ...props, className, href: to, 'data-testid': 'link' }, children),
    Outlet: () => null,
  }
})

function renderWithProviders(ui) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        AppProvider,
        null,
        // The shell's nav filter reads the plugin catalog (#436); useMe is
        // module-mocked above, so the provider sees the same payload.
        React.createElement(PluginCatalogProvider, null, ui)
      )
    )
  )
}

describe('AppShell', () => {
  beforeEach(() => {
    routerState.routeId = '/'
    vi.mocked(useMe).mockReturnValue({
      data: { user: { id: 'u1', email: 'a@b.com', name: 'Alice', picture: null } },
      isLoading: false,
    })
    vi.mocked(useLogout).mockReturnValue({ mutate: vi.fn(), data: null })
    vi.mocked(useSettings).mockReturnValue({
      data: { has_ai_key: false, active_household_name: 'Keluarga Putri' },
    })
    vi.mocked(useHouseholds).mockReturnValue({
      data: {
        households: [
          {
            id: 'h1',
            name: 'Keluarga Putri',
            role: 'owner',
            member_count: 4,
            is_active: true,
          },
        ],
      },
    })
    vi.mocked(useUpdateSettings).mockReturnValue({ mutate: vi.fn() })
    // Assistant is mounted by the shell; it consumes usage + chat hooks.
    vi.mocked(useUsage).mockReturnValue({
      data: {
        used: 3,
        input_tokens: 900,
        output_tokens: 200,
        cached_tokens: null,
        key_source: 'server',
      },
    })
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

  it('renders the household card from settings with the member count', () => {
    const { getByTestId } = renderWithProviders(React.createElement(AppShell, null, null))
    const card = getByTestId('household-card')
    expect(card.textContent).toContain('Keluarga Putri')
    // "4 people · Your shared kitchen" — the Figma household-card identity.
    expect(card.textContent).toContain('4 people')
    expect(card.textContent).toContain('Your shared kitchen')
  })

  it('gives the household card link an accessible name containing its visible text', () => {
    const { getByTestId, getByRole } = renderWithProviders(
      React.createElement(AppShell, null, null)
    )
    const link = getByTestId('household-card').closest('a')
    // WCAG 2.5.3 / axe label-content-name-mismatch (#498): every visible
    // string must be part of the accessible name. Role queries match on the
    // computed accessible name, so asserting the role proves it — an
    // aria-label alone would not.
    for (const visible of ['Keluarga Putri', '4 people', 'Your shared kitchen']) {
      expect(getByRole('link', { name: new RegExp(visible) })).toBe(link)
    }
    // Order matters too: the name starts with the visible lines verbatim.
    expect(getByRole('link', { name: /^Keluarga Putri 4 people · Your shared kitchen$/ })).toBe(
      link
    )
  })

  it('links the household card into the Household members screen', () => {
    const { getByTestId } = renderWithProviders(React.createElement(AppShell, null, null))
    const card = getByTestId('household-card')
    expect(card.closest('a')?.getAttribute('href')).toBe('/household')
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

  it('renders the mobile tab bar icon-only with equal slots and accessible names', () => {
    const { container } = renderWithProviders(React.createElement(AppShell, null, null))
    const bar = container.querySelector('nav.lg\\:hidden')
    expect(bar).toBeTruthy()
    const slots = [...bar.children]
    expect(slots.map((a) => a.getAttribute('aria-label'))).toEqual([
      'Home',
      'Inventory',
      'Ask RumaQ',
      'Plan',
      'Prices',
    ])
    // Icon-only: no visible text labels inside the bar itself
    expect(bar.textContent.trim()).toBe('')
  })

  it('opens the mobile drawer from the brand mark and closes on Escape', () => {
    const { container } = renderWithProviders(React.createElement(AppShell, null, null))
    expect(container.querySelector('aside[role="dialog"]')).toBeNull()
    fireEvent.click(container.querySelector('button[aria-label="Open menu"]'))
    const drawer = container.querySelector('aside[role="dialog"]')
    expect(drawer).toBeTruthy()
    // History lives in the drawer (moved out of the mobile header)
    expect(drawer.querySelector('a[href="/history"]')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(container.querySelector('aside[role="dialog"]')).toBeNull()
  })

  it('moves focus into the drawer on open and keeps Tab inside it', () => {
    const { container } = renderWithProviders(React.createElement(AppShell, null, null))
    fireEvent.click(container.querySelector('button[aria-label="Open menu"]'))
    const drawer = container.querySelector('aside[role="dialog"]')
    // The modal dialog receives focus when it opens (aria-modal contract)
    expect(drawer.contains(document.activeElement)).toBe(true)
    // Tab from the panel itself wraps to the drawer's first focusable control
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(drawer.contains(document.activeElement)).toBe(true)
    expect(document.activeElement.getAttribute('aria-label')).toBe('Close menu')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(container.querySelector('aside[role="dialog"]')).toBeNull()
  })

  it('shows Household members to everyone but operator surfaces only to admins', () => {
    const { container } = renderWithProviders(React.createElement(AppShell, null, null))
    // The HOUSEHOLD ADMIN group heading and the Household members entry exist
    // for every user; operator items do not.
    expect(container.textContent).toContain('Household admin')
    expect(container.textContent).toContain('Household members')
    expect(container.textContent).not.toContain('Scraper Monitor')

    vi.mocked(useMe).mockReturnValue({
      data: { user: { id: 'u1', email: 'a@b.com', name: 'Alice', isAdmin: true } },
      isLoading: false,
    })
    const adminView = renderWithProviders(React.createElement(AppShell, null, null))
    expect(adminView.container.textContent).toContain('Household admin')
    expect(adminView.container.textContent).toContain('Scraper Monitor')
  })

  it('keeps plugin nav entries when /api/me omits enabledPlugins (legacy payloads)', () => {
    // The beforeEach useMe payload carries no enabledPlugins field — the
    // additive contract (#436, plan §4.5) reads absent as all enabled.
    const { container } = renderWithProviders(React.createElement(AppShell, null, null))
    expect(container.querySelector('a[href="/documents"]')).toBeTruthy()
  })

  it('hides a disabled plugin from the sidebar and the mobile drawer', () => {
    vi.mocked(useMe).mockReturnValue({
      data: {
        user: { id: 'u1', email: 'a@b.com', name: 'Alice', picture: null },
        enabledPlugins: [],
      },
      isLoading: false,
    })
    const { container } = renderWithProviders(React.createElement(AppShell, null, null))
    expect(container.querySelector('a[href="/documents"]')).toBeNull()
    // The filter feeds every render site — the drawer must not keep showing
    // a disabled surface (plan §4.5).
    fireEvent.click(container.querySelector('button[aria-label="Open menu"]'))
    const drawer = container.querySelector('aside[role="dialog"]')
    expect(drawer).toBeTruthy()
    expect(drawer.querySelector('a[href="/documents"]')).toBeNull()
    // Core household-admin entries are unaffected.
    expect(drawer.querySelector('a[href="/household"]')).toBeTruthy()
  })

  it('titles a deep link into a disabled plugin with the real page name', () => {
    // The gate blocks the page itself, but the header must still read
    // "Documents": the title lookup composes the UNfiltered catalog while
    // the nav renders the filtered one — the filtered lookup fell back to
    // "Home" here.
    routerState.routeId = '/documents'
    vi.mocked(useMe).mockReturnValue({
      data: {
        user: { id: 'u1', email: 'a@b.com', name: 'Alice', picture: null },
        enabledPlugins: [],
      },
      isLoading: false,
    })
    const { container } = renderWithProviders(React.createElement(AppShell, null, null))
    expect(container.textContent).toContain('Your household / Documents')
    expect(container.textContent).not.toContain('Your household / Home')
    // The nav link itself stays filtered out of the sidebar.
    expect(container.querySelector('a[href="/documents"]')).toBeNull()
  })

  it('renders the account block without a logout button (logout lives in Settings)', () => {
    const { getByText, container } = renderWithProviders(React.createElement(AppShell, null, null))
    expect(getByText('Alice').textContent).toBe('Alice')
    expect(container.textContent).not.toContain('Logout')
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
