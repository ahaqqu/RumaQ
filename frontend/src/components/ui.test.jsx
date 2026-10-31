import { describe, it, expect, vi } from 'vite-plus/test'
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

// The global test-setup t() mock returns raw keys; these tests assert the
// rendered token counts, so resolve en.json and interpolate like i18next.
vi.mock('react-i18next', async () => {
  const { vi } = await import('vite-plus/test')
  const en = (await import('../i18n/locales/en.json')).default
  const t = (key, opts) => {
    if (opts && opts.returnObjects) return {}
    const template = key.split('.').reduce((node, k) => (node == null ? node : node[k]), en)
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
        usage: {
          provider: 'Gemini',
          used: 5,
          input_tokens: 1200,
          output_tokens: 350,
          cached_tokens: 700,
          key_source: 'user',
        },
      })
    )
    expect(container.querySelector('[class*="flex flex-col gap-3 p-5"]')).toBeTruthy()
  })

  it('renders nothing without usage data', () => {
    const { container } = render(React.createElement(UsageMeter))
    expect(container.querySelector('[class*="flex flex-col gap-3 p-5"]')).toBeNull()
  })

  it('shows calls, token counts and the cache hit rate', () => {
    const { container } = render(
      React.createElement(UsageMeter, {
        usage: {
          provider: 'Gemini',
          used: 4,
          input_tokens: 1200,
          output_tokens: 350,
          cached_tokens: 700,
          key_source: 'user',
        },
      })
    )
    expect(container.textContent).toContain('Gemini')
    expect(container.textContent).toContain('4 calls today')
    expect(container.textContent).toContain('1.2k in')
    expect(container.textContent).toContain('350 out')
    expect(container.textContent).toContain('58%')
    expect(container.textContent).toContain('cache hit rate')
  })

  it('never renders a cap meter, limit, warn or danger (#353)', () => {
    const { container } = render(
      React.createElement(UsageMeter, {
        usage: {
          provider: 'Gemini',
          used: 999,
          input_tokens: 1200,
          output_tokens: 350,
          cached_tokens: null,
          key_source: 'server',
        },
      })
    )
    expect(container.querySelector('.h-2')).toBeNull()
    expect(container.textContent).not.toContain('/20')
    expect(container.textContent).not.toContain('Daily limit')
    expect(container.textContent).not.toContain('danger')
    expect(container.textContent).toContain("RumaQ's shared server key")
    // No cache data reported: no fabricated 0%, the rate block is absent.
    expect(container.textContent).not.toContain('0%')
    expect(container.textContent).not.toContain('cache hit rate')
  })
})

describe('MetaItem', () => {
  it('renders children', () => {
    const { container } = render(React.createElement(MetaItem, { icon: IconPin }, 'test children'))
    expect(container.textContent).toContain('test children')
  })
})
