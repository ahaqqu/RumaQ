import { describe, it, expect } from 'vite-plus/test'
import { render } from '@testing-library/react'
import React from 'react'
import { expiryTone, ExpiryBadge, selectDueSoon } from './DocumentExpiry.jsx'

// Unit coverage for the extracted expiry surfaces (V2-B2): the tone
// thresholds, the chip copy contract, and the due-soon selection. i18n runs
// uninitialized, so the chip renders raw keys — the same idiom as the page
// suite. These contracts no longer need the whole page mounted.

describe('expiryTone thresholds (#426)', () => {
  it('danger under 7 days (expired/negative included), warn under 30, muted beyond', () => {
    expect(expiryTone(-10)).toBe('danger')
    expect(expiryTone(-1)).toBe('danger')
    expect(expiryTone(0)).toBe('danger')
    expect(expiryTone(6)).toBe('danger')
    expect(expiryTone(7)).toBe('warn') // the 7-day boundary itself: amber
    expect(expiryTone(29)).toBe('warn')
    expect(expiryTone(30)).toBe('muted') // the 30-day boundary itself: muted
    expect(expiryTone(200)).toBe('muted')
  })

  it('answers null for undated documents — no chip at all', () => {
    expect(expiryTone(null)).toBeNull()
    expect(expiryTone(undefined)).toBeNull()
  })
})

describe('ExpiryBadge copy contract (#426)', () => {
  it('renders the expired key for negative distances, the count-down key otherwise, nothing for undated', () => {
    const { container } = render(React.createElement(ExpiryBadge, { days: -4 }))
    expect(container.querySelector('[data-testid="expiry-chip"]')?.textContent).toContain(
      'documents.expiredDaysAgo'
    )
    expect(container.querySelector('[data-testid="expiry-chip"]')?.className).toContain(
      'text-danger'
    )

    const ahead = render(React.createElement(ExpiryBadge, { days: 3 }))
    expect(ahead.container.textContent).toContain('documents.expiresInDays')

    const today = render(React.createElement(ExpiryBadge, { days: 0 }))
    expect(today.container.textContent).toContain('documents.expiresToday')

    const none = render(React.createElement(ExpiryBadge, { days: null }))
    expect(none.container.querySelector('[data-testid="expiry-chip"]')).toBeNull()
  })
})

describe('selectDueSoon (#426)', () => {
  const doc = (overrides = {}) => ({
    id: 'doc-1',
    name: 'KTP',
    days_until_expiry: null,
    remind_days_before: null,
    ...overrides,
  })

  it('keeps documents inside their OWN remind window; NULL window reads as the 30-day default', () => {
    const docs = [
      doc({ id: 'a', days_until_expiry: 25, remind_days_before: 30 }), // 25 <= 30 → in
      doc({ id: 'b', days_until_expiry: 31, remind_days_before: 30 }), // 31 > 30 → out
      doc({ id: 'c', days_until_expiry: 30, remind_days_before: null }), // NULL → 30; boundary in
      doc({ id: 'd', days_until_expiry: 31, remind_days_before: null }), // default 30 → out
      doc({ id: 'e', days_until_expiry: 3, remind_days_before: 7 }), // 3 <= 7 → in
      doc({ id: 'f', days_until_expiry: 8, remind_days_before: 7 }), // 8 > 7 → out
    ]
    expect(selectDueSoon(docs).map((d) => d.id)).toEqual(['e', 'a', 'c'])
  })

  it('sorts soonest expiry first (negative distances lead)', () => {
    const docs = [
      doc({ id: 'far', days_until_expiry: 20, remind_days_before: 30 }),
      doc({ id: 'expired', days_until_expiry: -2, remind_days_before: 30 }),
      doc({ id: 'soon', days_until_expiry: 2, remind_days_before: 30 }),
    ]
    expect(selectDueSoon(docs).map((d) => d.id)).toEqual(['expired', 'soon', 'far'])
  })

  it('excludes undated documents and tolerates null/undefined input', () => {
    expect(selectDueSoon([doc({ days_until_expiry: null, remind_days_before: 30 })])).toEqual([])
    expect(selectDueSoon([])).toEqual([])
    expect(selectDueSoon(undefined)).toEqual([])
  })
})
