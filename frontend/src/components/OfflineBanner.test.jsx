import { describe, it, expect, afterEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import React from 'react'
import { OfflineBanner } from './OfflineBanner.jsx'

function setOnline(value) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true })
}

afterEach(() => {
  setOnline(true)
})

describe('OfflineBanner', () => {
  it('renders nothing when online', () => {
    setOnline(true)
    const { container } = render(React.createElement(OfflineBanner))
    expect(container.firstChild).toBeNull()
  })

  it('shows a banner when offline', () => {
    setOnline(false)
    const { container } = render(React.createElement(OfflineBanner))
    expect(container.querySelector('[role="status"]')).toBeTruthy()
    expect(container.textContent).toContain('offline.banner')
  })

  it('appears when the browser goes offline', () => {
    setOnline(true)
    const { container } = render(React.createElement(OfflineBanner))
    expect(container.firstChild).toBeNull()

    setOnline(false)
    fireEvent(window, new Event('offline'))
    expect(container.querySelector('[role="status"]')).toBeTruthy()
  })
})
