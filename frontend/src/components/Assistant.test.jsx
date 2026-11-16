import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Assistant } from './Assistant.jsx'
import { AppProvider } from '../context/AppContext.jsx'

const mutateAsync = vi.fn()

const NONE_STATUS = { decision: 'none', reasoning: 'none', vision: 'none' }
const CONNECTED_STATUS = { decision: 'none', reasoning: 'household', vision: 'none' }

const mockUseSettings = vi.fn(() => ({
  data: { ai_status: NONE_STATUS },
}))

vi.mock('../lib/queries/index.js', () => ({
  useUsage: () => ({
    data: {
      used: 3,
      input_tokens: 900,
      output_tokens: 200,
      cached_tokens: 400,
      provider: 'opencode',
      key_source: 'server',
    },
  }),
  useSendChatMessage: () => ({
    isPending: false,
    mutateAsync,
  }),
  useSettings: () => mockUseSettings(),
}))

function renderWithProviders(ui) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(AppProvider, null, ui)
    )
  )
}

const baseProps = (overrides = {}) => ({
  open: false,
  onOpen: vi.fn(),
  onClose: vi.fn(),
  onNavigate: vi.fn(),
  ...overrides,
})

describe('Assistant', () => {
  beforeEach(() => {
    // Connectivity rides the household's capability status alone (audit L7):
    // the default is nothing configured, and no browser key exists to OR in.
    mockUseSettings.mockReturnValue({ data: { ai_status: NONE_STATUS } })
    localStorage.removeItem('rumaq_ai_key')
  })

  it('renders FAB button', () => {
    const { container } = renderWithProviders(React.createElement(Assistant, baseProps()))
    expect(container.querySelector('button[aria-label="assistant.fabLabel"]')).toBeTruthy()
  })

  it('opens dialog when open=true', () => {
    const { container } = renderWithProviders(
      React.createElement(Assistant, baseProps({ open: true }))
    )
    expect(container.querySelector('section[role="dialog"]')).toBeTruthy()
  })

  it('shows the no-key state when no capability is configured', () => {
    const { container } = renderWithProviders(
      React.createElement(Assistant, baseProps({ open: true }))
    )
    expect(container.querySelector('[class*="text-text-muted"].p-5')).toBeTruthy()
  })

  it('shows body when the household has a configured capability, without a local key', () => {
    // #523 P3: `has_ai_key` is gone with the column it described; the household's
    // capability status is the honest signal.
    mockUseSettings.mockReturnValue({ data: { ai_status: CONNECTED_STATUS } })
    const { container } = renderWithProviders(
      React.createElement(Assistant, baseProps({ open: true }))
    )
    expect(container.querySelector('section[role="dialog"] > div')).toBeTruthy()
    expect(container.querySelector('button[class*="border border-border bg-surface"]')).toBeTruthy()
  })

  it('renders the not-connected state when no capability is configured', () => {
    const { container } = renderWithProviders(
      React.createElement(Assistant, baseProps({ open: true }))
    )
    expect(container.querySelector('input[type="text"]')).toBeNull()
  })

  it('renders chat input when the reasoning capability is configured', () => {
    mockUseSettings.mockReturnValue({ data: { ai_status: CONNECTED_STATUS } })
    const { container } = renderWithProviders(
      React.createElement(Assistant, baseProps({ open: true }))
    )
    const input = container.querySelector('input[type="text"]')
    expect(input).toBeTruthy()
  })

  // L7/C5 (audit): the pre-split browser key no longer ORs into "connected".
  // A stale localStorage secret (what older builds wrote) must not light the
  // dot for a request that would never carry it — the no-key state renders.
  it('does not count a stale localStorage AI key as connected', () => {
    localStorage.setItem('rumaq_ai_key', 'sk-stale-from-old-build')
    const { container } = renderWithProviders(
      React.createElement(Assistant, baseProps({ open: true }))
    )
    expect(container.querySelector('input[type="text"]')).toBeNull()
    expect(container.textContent).toContain('assistant.connectKeyFirst')
  })

  it('calls onNavigate when add key button is clicked', () => {
    const onClose = vi.fn()
    const onNavigate = vi.fn()
    const { container } = renderWithProviders(
      React.createElement(Assistant, baseProps({ open: true, onClose, onNavigate }))
    )
    const settingsBtn = container.querySelector('button.mt-5')
    if (settingsBtn) {
      fireEvent.click(settingsBtn)
      expect(onClose).toHaveBeenCalled()
      expect(onNavigate).toHaveBeenCalledWith('settings')
    }
  })

  it('calls onClose when scrim is clicked', () => {
    mockUseSettings.mockReturnValue({ data: { ai_status: CONNECTED_STATUS } })
    const onClose = vi.fn()
    const { container } = renderWithProviders(
      React.createElement(Assistant, baseProps({ open: true, onClose }))
    )
    const scrim = container.querySelector('section[role="dialog"]').previousSibling
    if (scrim) {
      fireEvent.click(scrim)
      expect(onClose).toHaveBeenCalled()
    }
  })

  it('displays reply after triggering a quick action', async () => {
    mockUseSettings.mockReturnValue({ data: { ai_status: CONNECTED_STATUS } })
    mutateAsync.mockResolvedValueOnce({ reply: 'Buy milk tomorrow.' })
    const { container } = renderWithProviders(
      React.createElement(Assistant, baseProps({ open: true }))
    )
    const actionBtns = container.querySelectorAll(
      'button[class*="border border-border bg-surface"]'
    )
    expect(actionBtns.length).toBeGreaterThan(0)
    fireEvent.click(actionBtns[0])
    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalled()
    })
  })

  it('displays the provider error message on a failed call', async () => {
    // The daily usage cap was removed (#353): no 429 usage-limit path exists,
    // so errors surface as the provider message they are.
    mockUseSettings.mockReturnValue({ data: { ai_status: CONNECTED_STATUS } })
    mutateAsync.mockRejectedValueOnce(new Error('AI chat failed: provider down.'))
    const { container } = renderWithProviders(
      React.createElement(Assistant, baseProps({ open: true }))
    )
    const input = container.querySelector('input[type="text"]')
    fireEvent.change(input, { target: { value: 'hi' } })
    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => {
      // The suite's i18n mock returns raw keys: reaching the assistant.error
      // branch (instead of a usage-limit branch) is the assertion.
      expect(container.textContent).toContain('assistant.error')
      expect(container.textContent).not.toContain('assistant.usageLimit')
    })
  })
})
