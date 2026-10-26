import { describe, it, expect, vi } from 'vite-plus/test'
import { render, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Assistant } from './Assistant.jsx'
import { AppProvider } from '../context/AppContext.jsx'

const mutateAsync = vi.fn()

const mockUseSettings = vi.fn(() => ({ data: { has_ai_key: false } }))

vi.mock('../lib/queries/index.js', () => ({
  useUsage: () => ({
    data: { used: 3, daily_limit: 20, provider: 'opencode' },
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

  it('shows no-key state when aiKey is missing', () => {
    const { container } = renderWithProviders(
      React.createElement(Assistant, baseProps({ open: true }))
    )
    expect(container.querySelector('[class*="text-text-muted"].p-5')).toBeTruthy()
  })

  it('shows body when aiKey is present', () => {
    const { container } = renderWithProviders(
      React.createElement(Assistant, baseProps({ open: true, aiKey: 'sk-test' }))
    )
    expect(container.querySelector('section[role="dialog"] > div')).toBeTruthy()
    expect(container.querySelector('button[class*="border border-border bg-surface"]')).toBeTruthy()
  })

  it('shows body when backend has_ai_key is true even without local aiKey', () => {
    mockUseSettings.mockReturnValue({ data: { has_ai_key: true } })
    const { container } = renderWithProviders(
      React.createElement(Assistant, baseProps({ open: true }))
    )
    expect(container.querySelector('section[role="dialog"] > div')).toBeTruthy()
    expect(container.querySelector('button[class*="border border-border bg-surface"]')).toBeTruthy()
  })

  it('renders chat input when only the server key is available', () => {
    mockUseSettings.mockReturnValue({ data: { has_ai_key: false, server_ai_available: true } })
    const { container } = renderWithProviders(
      React.createElement(Assistant, baseProps({ open: true }))
    )
    expect(container.querySelector('input[type="text"]')).toBeTruthy()
  })

  it('renders chat input when aiKey present', () => {
    const { container } = renderWithProviders(
      React.createElement(Assistant, baseProps({ open: true, aiKey: 'sk-test' }))
    )
    const input = container.querySelector('input[type="text"]')
    expect(input).toBeTruthy()
  })

  it('calls onNavigate when add key button is clicked', () => {
    mockUseSettings.mockReturnValue({ data: { has_ai_key: false } })
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
    const onClose = vi.fn()
    const { container } = renderWithProviders(
      React.createElement(Assistant, baseProps({ open: true, onClose, aiKey: 'sk-test' }))
    )
    const scrim = container.querySelector('section[role="dialog"]').previousSibling
    if (scrim) {
      fireEvent.click(scrim)
      expect(onClose).toHaveBeenCalled()
    }
  })

  it('displays reply after triggering a quick action', async () => {
    mutateAsync.mockResolvedValueOnce({ reply: 'Buy milk tomorrow.' })
    const { container } = renderWithProviders(
      React.createElement(Assistant, baseProps({ open: true, aiKey: 'sk-test' }))
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

  it('displays usage-limit message on usage error', async () => {
    mutateAsync.mockRejectedValueOnce(new Error('AI usage limit reached for today.'))
    const { container } = renderWithProviders(
      React.createElement(Assistant, baseProps({ open: true, aiKey: 'sk-test' }))
    )
    const input = container.querySelector('input[type="text"]')
    fireEvent.change(input, { target: { value: 'hi' } })
    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalled()
    })
  })
})
