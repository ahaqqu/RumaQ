import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PluginGate } from './PluginGate.jsx'
import { PluginCatalogProvider } from './context.jsx'
import { getMe } from '../lib/api'

// The gate asserts real copy, so resolve en.json and interpolate like
// i18next (the global test-setup t() mock returns raw keys).
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

vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(message, status) {
      super(message)
      this.status = status
    }
  },
  getMe: vi.fn(),
  logout: vi.fn(),
}))

function renderGate() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <PluginCatalogProvider>
        <PluginGate plugin="documents">
          <div>the vault page</div>
        </PluginGate>
      </PluginCatalogProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.mocked(getMe).mockReset()
})

describe('PluginGate', () => {
  it('renders the route for an enabled plugin (absent field = all enabled)', () => {
    vi.mocked(getMe).mockResolvedValue({ user: { id: 'u1' } })
    const { getByText } = renderGate()
    expect(getByText('the vault page')).toBeTruthy()
  })

  it('shows the disabled empty state instead of the page for a disabled plugin', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user: { id: 'u1' },
      enabledPlugins: [],
    })
    const { findByText, container } = renderGate()
    // Calm empty state (§3.2) — the plugin's own label, never a crash or a
    // silent blank; the page itself never mounts so it cannot fetch the 404s
    // the backend gate answers.
    expect(await findByText('Documents is turned off')).toBeTruthy()
    expect(await findByText(/off for your household/)).toBeTruthy()
    expect(container.textContent).not.toContain('the vault page')
    expect(container.querySelector('svg')).toBeTruthy()
  })
})
