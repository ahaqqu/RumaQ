import { describe, it, expect } from 'vite-plus/test'
import { render } from '@testing-library/react'
import React from 'react'
import {
  LocChip,
  TimeSignal,
  EmptyState,
  SkeletonRows,
  UsageMeter,
  MetaItem,
  IconPin,
} from './ui.jsx'

describe('LocChip', () => {
  it('renders location name', () => {
    const { container } = render(React.createElement(LocChip, { loc: 'Kulkas' }))
    expect(container.textContent).toContain('Kulkas')
  })
})

describe('TimeSignal', () => {
  it('renders danger for expiring tomorrow', () => {
    const { container } = render(React.createElement(TimeSignal, { expiryDays: 1, runOut: 1 }))
    expect(container.querySelector('.text-danger')).toBeTruthy()
  })

  it('renders warn for expiring in 3 days', () => {
    const { container } = render(React.createElement(TimeSignal, { expiryDays: 3, runOut: 3 }))
    expect(container.querySelector('.text-warn')).toBeTruthy()
  })

  it('renders muted for expiring in 7 days', () => {
    const { container } = render(React.createElement(TimeSignal, { expiryDays: 7, runOut: 5 }))
    expect(container.querySelector('.text-text-muted')).toBeTruthy()
  })

  it('shows danger for runOut <= 2 when no expiry', () => {
    const { container } = render(React.createElement(TimeSignal, { expiryDays: null, runOut: 2 }))
    expect(container.querySelector('.text-danger')).toBeTruthy()
  })

  it('shows warn for runOut === 3 when no expiry', () => {
    const { container } = render(React.createElement(TimeSignal, { expiryDays: null, runOut: 3 }))
    expect(container.querySelector('.text-warn')).toBeTruthy()
  })

  it('shows muted for runOut > 3 when no expiry', () => {
    const { container } = render(React.createElement(TimeSignal, { expiryDays: null, runOut: 10 }))
    expect(container.querySelector('.text-text-muted')).toBeTruthy()
  })

  it('sets title when basis is provided', () => {
    const { container } = render(
      React.createElement(TimeSignal, {
        expiryDays: 3,
        runOut: 3,
        basis: 'test basis',
      })
    )
    expect(container.querySelector('[title]')).toBeTruthy()
  })

  it('shows muted for expiry days > 3 within useExpiry branch', () => {
    const { container } = render(React.createElement(TimeSignal, { expiryDays: 4, runOut: 5 }))
    expect(container.querySelector('.text-text-muted')).toBeTruthy()
  })
})

describe('EmptyState', () => {
  it('renders title and description', () => {
    const { container } = render(
      React.createElement(EmptyState, { title: 'Empty', desc: 'Nothing here' })
    )
    expect(container.textContent).toContain('Empty')
    expect(container.textContent).toContain('Nothing here')
  })

  it('renders action when provided', () => {
    const { container } = render(
      React.createElement(EmptyState, {
        title: 'Empty',
        desc: 'Nothing here',
        action: React.createElement('button', null, 'Add'),
      })
    )
    expect(container.querySelector('button')).toBeTruthy()
  })
})

describe('SkeletonRows', () => {
  it('renders 5 rows by default', () => {
    const { container } = render(React.createElement(SkeletonRows))
    const rows = container.querySelectorAll('[class*="grid-cols-[1fr_auto]"]')
    expect(rows.length).toBe(5)
  })

  it('renders custom n rows', () => {
    const { container } = render(React.createElement(SkeletonRows, { n: 3 }))
    const rows = container.querySelectorAll('[class*="grid-cols-[1fr_auto]"]')
    expect(rows.length).toBe(3)
  })
})

describe('UsageMeter', () => {
  it('renders usage info', () => {
    const { container } = render(
      React.createElement(UsageMeter, {
        usage: { provider: 'Gemini', used: 5, limit: 20 },
      })
    )
    expect(container.querySelector('[class*="flex flex-col gap-3 p-5"]')).toBeTruthy()
  })

  it('renders nothing without usage data', () => {
    const { container } = render(React.createElement(UsageMeter))
    expect(container.querySelector('[class*="flex flex-col gap-3 p-5"]')).toBeNull()
  })

  it('shows warning for high usage', () => {
    const { container } = render(
      React.createElement(UsageMeter, {
        usage: { provider: 'Gemini', used: 17, limit: 20 },
      })
    )
    expect(container.querySelector('.text-warn')).toBeTruthy()
  })

  it('shows danger for maxed usage', () => {
    const { container } = render(
      React.createElement(UsageMeter, {
        usage: { provider: 'Gemini', used: 20, limit: 20 },
      })
    )
    expect(container.querySelector('.text-danger')).toBeTruthy()
  })

  it('shows remaining for normal usage', () => {
    const { container } = render(
      React.createElement(UsageMeter, {
        usage: { provider: 'Gemini', used: 5, limit: 20 },
      })
    )
    expect(container.querySelector('.text-text-muted')).toBeTruthy()
  })

  it('shows unlimited usage for own-key users', () => {
    const { container } = render(
      React.createElement(UsageMeter, {
        usage: { provider: 'Gemini', used: 20, daily_limit: 20, key_source: 'user' },
      })
    )
    expect(container.querySelector('.text-danger')).toBeNull()
    expect(container.querySelector('.h-2')).toBeNull()
    expect(container.textContent).toContain('20')
  })
})

describe('MetaItem', () => {
  it('renders children', () => {
    const { container } = render(React.createElement(MetaItem, { icon: IconPin }, 'test children'))
    expect(container.textContent).toContain('test children')
  })
})
