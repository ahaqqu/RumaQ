import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Login } from './Login.jsx'
import * as api from '../lib/api'

vi.mock('../lib/api', () => ({
  login: vi.fn(),
  emailAuthStatus: vi.fn(),
  emailLogin: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

function renderWithQuery(ui) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(React.createElement(QueryClientProvider, { client: queryClient }, ui))
}

describe('Login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders Google sign-in button', async () => {
    api.emailAuthStatus.mockResolvedValue({ enabled: false })
    const { container } = renderWithQuery(React.createElement(Login))
    await waitFor(() => expect(container.querySelector('button')).toBeTruthy())
    expect(container.textContent).toContain('login.signIn')
  })

  it('calls login on Google button click', async () => {
    api.emailAuthStatus.mockResolvedValue({ enabled: false })
    const { container } = renderWithQuery(React.createElement(Login))
    await waitFor(() => expect(container.querySelector('button')).toBeTruthy())
    fireEvent.click(container.querySelector('button'))
    expect(api.login).toHaveBeenCalled()
  })

  it('shows email form when email auth is enabled', async () => {
    api.emailAuthStatus.mockResolvedValue({ enabled: true })
    const { container } = renderWithQuery(React.createElement(Login))
    await waitFor(() => expect(container.querySelector('form')).toBeTruthy())
    expect(container.querySelector('input[type="email"]')).toBeTruthy()
    expect(container.querySelector('input[type="password"]')).toBeTruthy()
  })

  it('submits email login and navigates on success', async () => {
    const navigate = vi.fn()
    vi.doMock('@tanstack/react-router', () => ({
      useNavigate: () => navigate,
    }))
    api.emailAuthStatus.mockResolvedValue({ enabled: true })
    api.emailLogin.mockResolvedValue({ ok: true })

    const { container } = renderWithQuery(React.createElement(Login))
    await waitFor(() => expect(container.querySelector('form')).toBeTruthy())

    const emailInput = container.querySelector('input[type="email"]')
    const passwordInput = container.querySelector('input[type="password"]')
    fireEvent.change(emailInput, { target: { value: 'a@b.com' } })
    fireEvent.change(passwordInput, { target: { value: 'secret' } })
    fireEvent.submit(container.querySelector('form'))

    await waitFor(() => expect(api.emailLogin).toHaveBeenCalledWith('a@b.com', 'secret'))
  })

  it('shows error message on email login failure', async () => {
    api.emailAuthStatus.mockResolvedValue({ enabled: true })
    api.emailLogin.mockRejectedValue(new Error('Invalid credentials'))

    const { container } = renderWithQuery(React.createElement(Login))
    await waitFor(() => expect(container.querySelector('form')).toBeTruthy())

    const emailInput = container.querySelector('input[type="email"]')
    const passwordInput = container.querySelector('input[type="password"]')
    fireEvent.change(emailInput, { target: { value: 'a@b.com' } })
    fireEvent.change(passwordInput, { target: { value: 'secret' } })
    fireEvent.submit(container.querySelector('form'))

    await waitFor(() => expect(container.textContent).toContain('Invalid credentials'))
  })

  it('disables submit button while loading', async () => {
    api.emailAuthStatus.mockResolvedValue({ enabled: true })
    let resolveLogin
    api.emailLogin.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLogin = resolve
        })
    )

    const { container } = renderWithQuery(React.createElement(Login))
    await waitFor(() => expect(container.querySelector('form')).toBeTruthy())

    const emailInput = container.querySelector('input[type="email"]')
    const passwordInput = container.querySelector('input[type="password"]')
    fireEvent.change(emailInput, { target: { value: 'a@b.com' } })
    fireEvent.change(passwordInput, { target: { value: 'secret' } })
    const submitBtn = container.querySelector('button[type="submit"]')
    fireEvent.click(submitBtn)
    expect(submitBtn.disabled).toBe(true)
    resolveLogin({ ok: true })
  })
})
