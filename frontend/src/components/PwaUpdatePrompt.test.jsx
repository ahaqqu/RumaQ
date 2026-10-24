import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import React from 'react'
import { PwaUpdatePrompt } from './PwaUpdatePrompt.jsx'

const mockUseRegisterSW = vi.fn()

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => mockUseRegisterSW(),
}))

describe('PwaUpdatePrompt', () => {
  beforeEach(() => {
    mockUseRegisterSW.mockReturnValue({
      needRefresh: [false, vi.fn()],
      updateServiceWorker: vi.fn(),
    })
  })

  it('renders nothing when no update is available', () => {
    const { container } = render(React.createElement(PwaUpdatePrompt))
    expect(container.firstChild).toBeNull()
  })

  it('renders update banner when update is available', () => {
    mockUseRegisterSW.mockReturnValue({
      needRefresh: [true, vi.fn()],
      updateServiceWorker: vi.fn(),
    })
    const { container } = render(React.createElement(PwaUpdatePrompt))
    expect(container.textContent).toContain('Update available')
    expect(container.querySelectorAll('button').length).toBe(2)
  })

  it('calls updateServiceWorker when update button clicked', () => {
    const updateServiceWorker = vi.fn()
    const setNeedRefresh = vi.fn()
    mockUseRegisterSW.mockReturnValue({
      needRefresh: [true, setNeedRefresh],
      updateServiceWorker,
    })
    const { container } = render(React.createElement(PwaUpdatePrompt))
    const buttons = container.querySelectorAll('button')
    fireEvent.click(buttons[0])
    expect(updateServiceWorker).toHaveBeenCalledWith(true)
  })

  it('dismisses banner when dismiss button clicked', () => {
    const updateServiceWorker = vi.fn()
    const setNeedRefresh = vi.fn()
    mockUseRegisterSW.mockReturnValue({
      needRefresh: [true, setNeedRefresh],
      updateServiceWorker,
    })
    const { container } = render(React.createElement(PwaUpdatePrompt))
    const buttons = container.querySelectorAll('button')
    fireEvent.click(buttons[1])
    expect(setNeedRefresh).toHaveBeenCalledWith(false)
  })
})
