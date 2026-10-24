import { describe, it, expect, vi, afterEach } from 'vite-plus/test'
import { render } from '@testing-library/react'
import React, { useEffect } from 'react'
import { useOnlineStatus } from './useOnlineStatus.js'

function Status({ onChange }) {
  const online = useOnlineStatus()
  useEffect(() => {
    if (onChange) onChange(online)
  }, [online, onChange])
  return React.createElement('span', { 'data-online': String(online) })
}

function setOnline(value) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true })
}

describe('useOnlineStatus', () => {
  afterEach(() => {
    setOnline(true)
  })

  it('returns true when navigator.onLine is true', () => {
    setOnline(true)
    const { container } = render(React.createElement(Status))
    expect(container.querySelector('span').getAttribute('data-online')).toBe('true')
  })

  it('returns false when navigator.onLine is false', () => {
    setOnline(false)
    const { container } = render(React.createElement(Status))
    expect(container.querySelector('span').getAttribute('data-online')).toBe('false')
  })

  it('subscribes to online/offline events', () => {
    const addEventListener = vi.spyOn(window, 'addEventListener')
    render(React.createElement(Status))
    expect(addEventListener).toHaveBeenCalledWith('online', expect.any(Function))
    expect(addEventListener).toHaveBeenCalledWith('offline', expect.any(Function))
    addEventListener.mockRestore()
  })
})
