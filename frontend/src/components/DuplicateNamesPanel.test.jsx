import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import React from 'react'
import { DuplicateNamesPanel } from './DuplicateNamesPanel.jsx'

// The report hook is mocked at its boundary (the ProductRenameForm.test.jsx
// idiom): these tests cover the panel's state machine — lazy fetch, empty,
// error, truncated, and the group/product rendering — not React Query.
vi.mock('../lib/queries/products.js', () => ({
  useDuplicateProductNames: vi.fn(),
}))

import { useDuplicateProductNames } from '../lib/queries/products.js'

const GROUPS = [
  {
    normalizedName: 'beras ramos 5 kg',
    displayName: 'beras ramos 5 kg',
    productCount: 2,
    products: [
      {
        productKey: 'beras--ramos--5-kg--provisional',
        name: 'beras ramos 5 kg',
        status: 'needs_review',
        updatedAt: '2026-11-05T00:00:00.000Z',
        stores: ['alfamart'],
        primaryStore: 'alfamart',
      },
      {
        productKey: 'beras--ramos--5-kg',
        name: 'Beras Ramos 5 kg',
        status: 'provisional',
        updatedAt: '2026-11-01T00:00:00.000Z',
        stores: ['lotte-mart', 'superindo'],
        primaryStore: 'lotte-mart',
      },
    ],
  },
  {
    normalizedName: 'gula pasir gulaku 1 kg',
    displayName: 'Gula Pasir Gulaku 1 kg',
    productCount: 2,
    products: [
      {
        productKey: 'gula--gulaku--1-kg',
        name: 'Gula Pasir Gulaku 1 kg',
        status: 'canonical',
        updatedAt: '2026-11-03T00:00:00.000Z',
        stores: [],
        primaryStore: null,
      },
    ],
  },
]

function report(overrides = {}) {
  return {
    data: { limit: 200, truncated: false, groups: GROUPS },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    ...overrides,
  }
}

function showToggle(container) {
  return [...container.querySelectorAll('button')].find((button) =>
    ['duplicates.show', 'duplicates.hide'].includes(button.textContent)
  )
}

describe('DuplicateNamesPanel', () => {
  beforeEach(() => {
    vi.mocked(useDuplicateProductNames).mockReturnValue(report())
  })

  it('stays collapsed — and fetches nothing — until the admin opens it', () => {
    vi.mocked(useDuplicateProductNames).mockReturnValue(
      report({ data: undefined, isLoading: true })
    )
    const { container } = render(React.createElement(DuplicateNamesPanel))
    expect(useDuplicateProductNames).toHaveBeenCalledWith({ enabled: false })
    expect(container.querySelector('[data-testid="duplicate-names-groups"]')).toBeNull()

    const toggle = showToggle(container)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)

    expect(useDuplicateProductNames).toHaveBeenLastCalledWith({ enabled: true })
    // Raw i18n keys: the shared i18n mock returns keys, not copy.
    expect(container.textContent).toContain('duplicates.loading')
  })

  it('lists every duplicate group with its product keys, statuses, stores and dates', () => {
    vi.mocked(useDuplicateProductNames).mockReturnValue(
      report({
        isLoading: false,
        data: { limit: 200, truncated: false, groups: GROUPS },
      })
    )
    const { container } = render(React.createElement(DuplicateNamesPanel))
    fireEvent.click(showToggle(container))

    const rows = container.querySelectorAll('[data-testid="duplicate-name-product"]')
    expect(rows).toHaveLength(3)
    const text = container.textContent
    expect(text).toContain('beras ramos 5 kg')
    expect(text).toContain('Beras Ramos 5 kg')
    expect(text).toContain('Gula Pasir Gulaku 1 kg')

    // The product key is the report's actionable handle for each row.
    expect(text).toContain('beras--ramos--5-kg--provisional')
    expect(text).toContain('beras--ramos--5-kg')
    expect(text).toContain('gula--gulaku--1-kg')

    // Status and stores come straight from the report; a product with no
    // alias yet says so instead of rendering an empty gap.
    expect(text).toContain('rename.statusNeedsReview')
    expect(text).toContain('rename.statusCanonical')
    expect(text).toContain('lotte-mart, superindo')
    expect(text).toContain('duplicates.noStores')
    expect(text).toContain('duplicates.productCount')
    // The date is formatted, not the raw ISO timestamp.
    expect(text).not.toContain('2026-11-05T00:00:00.000Z')
  })

  it('shows a graceful empty state when no names collide', () => {
    vi.mocked(useDuplicateProductNames).mockReturnValue(
      report({ data: { limit: 200, truncated: false, groups: [] } })
    )
    const { container } = render(React.createElement(DuplicateNamesPanel))
    fireEvent.click(showToggle(container))

    expect(container.querySelector('[data-testid="duplicate-names-empty"]')).not.toBeNull()
    expect(container.textContent).toContain('duplicates.empty')
    expect(container.querySelector('[data-testid="duplicate-names-groups"]')).toBeNull()
  })

  it('flags a truncated report instead of presenting it as complete', () => {
    vi.mocked(useDuplicateProductNames).mockReturnValue(
      report({ data: { limit: 1, truncated: true, groups: [GROUPS[0]] } })
    )
    const { container } = render(React.createElement(DuplicateNamesPanel))
    fireEvent.click(showToggle(container))

    expect(container.querySelector('[data-testid="duplicate-names-truncated"]')).not.toBeNull()
    expect(container.textContent).toContain('duplicates.truncated')
  })

  it('offers a retry when the report fails to load', () => {
    const refetch = vi.fn()
    vi.mocked(useDuplicateProductNames).mockReturnValue(
      report({ data: undefined, isError: true, refetch })
    )
    const { container } = render(React.createElement(DuplicateNamesPanel))
    fireEvent.click(showToggle(container))

    expect(container.textContent).toContain('duplicates.error')
    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'duplicates.retry'
    )
    expect(retry).not.toBeUndefined()
    fireEvent.click(retry)
    expect(refetch).toHaveBeenCalledTimes(1)
  })
})
