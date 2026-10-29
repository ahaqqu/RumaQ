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

  it('renders the update banner when a new version is ready', () => {
    mockUseRegisterSW.mockReturnValue({
      needRefresh: [true, vi.fn()],
      updateServiceWorker: vi.fn(),
    })
    const { container } = render(React.createElement(PwaUpdatePrompt))
    expect(container.querySelector('[role="status"]')).toBeTruthy()
    expect(container.textContent).toContain('pwa.updateAvailable')
    expect(container.textContent).toContain('pwa.reload')
    expect(container.textContent).toContain('pwa.dismiss')
  })

  it('activates the waiting worker via updateServiceWorker on Reload', () => {
    const updateServiceWorker = vi.fn()
    mockUseRegisterSW.mockReturnValue({
      needRefresh: [true, vi.fn()],
      updateServiceWorker,
    })
    const { container } = render(React.createElement(PwaUpdatePrompt))
    fireEvent.click(container.querySelectorAll('button')[0])
    expect(updateServiceWorker).toHaveBeenCalledWith(true)
  })

  it('dismisses the banner until the next needRefresh event', () => {
    const setNeedRefresh = vi.fn()
    mockUseRegisterSW.mockReturnValue({
      needRefresh: [true, setNeedRefresh],
      updateServiceWorker: vi.fn(),
    })
    const { container } = render(React.createElement(PwaUpdatePrompt))
    fireEvent.click(container.querySelectorAll('button')[1])
    expect(setNeedRefresh).toHaveBeenCalledWith(false)
  })
})
