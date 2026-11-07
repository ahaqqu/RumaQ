import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import React from 'react'
import { AliasCandidatesPanel } from './AliasCandidatesPanel.jsx'

// The hooks are mocked at their boundary (the DuplicateNamesPanel.test.jsx
// idiom): these tests cover the panel's state machine — counts, the required
// confirm, busy, success/partial-failure copy, and the read error — not React
// Query or the network.
vi.mock('../lib/queries/products.js', () => ({
  useAliasCandidateCounts: vi.fn(),
  useBulkApproveExactAliases: vi.fn(),
}))

import { useAliasCandidateCounts, useBulkApproveExactAliases } from '../lib/queries/products.js'

function counts(overrides = {}) {
  return {
    data: { candidates: 1973, exactCandidates: 42 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    ...overrides,
  }
}

function bulk(overrides = {}) {
  return { mutate: vi.fn(), isPending: false, ...overrides }
}

function approveButton(container) {
  return container.querySelector('[data-testid="alias-bulk-approve"]')
}

describe('AliasCandidatesPanel', () => {
  beforeEach(() => {
    vi.mocked(useAliasCandidateCounts).mockReturnValue(counts())
    vi.mocked(useBulkApproveExactAliases).mockReturnValue(bulk())
    // The panel's confirm is the browser dialog (the ProductRenameForm revert
    // idiom), so the tests stub it and assert on the call.
    window.confirm = vi.fn(() => true)
  })

  it('renders both counts and enables the action when exact matches exist', () => {
    const { container } = render(React.createElement(AliasCandidatesPanel))
    expect(container.querySelector('[data-testid="alias-candidates-panel"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="alias-candidate-total"]').textContent).toBe(
      '1973'
    )
    expect(container.querySelector('[data-testid="alias-candidate-exact"]').textContent).toBe('42')
    expect(approveButton(container).textContent).toBe('aliasBulk.approve')
    expect(approveButton(container).disabled).toBe(false)
  })

  it('disables the action when there is no exact match to approve', () => {
    vi.mocked(useAliasCandidateCounts).mockReturnValue(
      counts({ data: { candidates: 1973, exactCandidates: 0 } })
    )
    const { container } = render(React.createElement(AliasCandidatesPanel))
    const button = approveButton(container)
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(useBulkApproveExactAliases().mutate).not.toHaveBeenCalled()
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('requires the confirm — cancelling it approves nothing', () => {
    const mutate = vi.fn()
    vi.mocked(useBulkApproveExactAliases).mockReturnValue(bulk({ mutate }))
    window.confirm = vi.fn(() => false)

    const { container } = render(React.createElement(AliasCandidatesPanel))
    fireEvent.click(approveButton(container))

    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(window.confirm).toHaveBeenCalledWith('aliasBulk.confirm')
    expect(mutate).not.toHaveBeenCalled()
  })

  it('runs the action after the confirm', () => {
    const mutate = vi.fn()
    vi.mocked(useBulkApproveExactAliases).mockReturnValue(bulk({ mutate }))

    const { container } = render(React.createElement(AliasCandidatesPanel))
    fireEvent.click(approveButton(container))

    expect(window.confirm).toHaveBeenCalledWith('aliasBulk.confirm')
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('shows the busy state and ignores a second click while pending', () => {
    const mutate = vi.fn()
    vi.mocked(useBulkApproveExactAliases).mockReturnValue(bulk({ mutate, isPending: true }))

    const { container } = render(React.createElement(AliasCandidatesPanel))
    const button = approveButton(container)
    expect(button.textContent).toBe('aliasBulk.approving')
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('reports the success receipt with the new index version', () => {
    const mutate = vi.fn((_variables, options) => {
      options.onSuccess({
        exactCandidates: 42,
        approved: 42,
        remainingCandidates: 1931,
        indexVersion: 9,
      })
    })
    vi.mocked(useBulkApproveExactAliases).mockReturnValue(bulk({ mutate }))

    const { container } = render(React.createElement(AliasCandidatesPanel))
    fireEvent.click(approveButton(container))

    const notice = container.querySelector('[data-testid="alias-bulk-success"]')
    expect(notice).not.toBeNull()
    expect(notice.textContent).toContain('aliasBulk.success')
    expect(container.querySelector('[data-testid="alias-bulk-index-version"]').textContent).toBe(
      '9'
    )
  })

  it('says nothing was approved when the run approved zero', () => {
    const mutate = vi.fn((_variables, options) => {
      options.onSuccess({
        exactCandidates: 1,
        approved: 0,
        remainingCandidates: 1973,
        indexVersion: 9,
      })
    })
    vi.mocked(useBulkApproveExactAliases).mockReturnValue(bulk({ mutate }))

    const { container } = render(React.createElement(AliasCandidatesPanel))
    fireEvent.click(approveButton(container))

    expect(container.querySelector('[data-testid="alias-bulk-success"]').textContent).toContain(
      'aliasBulk.nothingToApprove'
    )
    expect(container.querySelector('[data-testid="alias-bulk-index-version"]').textContent).toBe(
      '9'
    )
  })

  it('reports a failed run, including the count reached before the chunk failed', () => {
    const mutate = vi.fn((_variables, options) => {
      options.onError({ status: 500, body: { approved: 3 } })
    })
    vi.mocked(useBulkApproveExactAliases).mockReturnValue(bulk({ mutate }))

    const { container } = render(React.createElement(AliasCandidatesPanel))
    fireEvent.click(approveButton(container))

    const alert = container.querySelector('[data-testid="alias-bulk-error"]')
    expect(alert).not.toBeNull()
    expect(alert.textContent).toBe('aliasBulk.approveErrorPartial')
    expect(container.querySelector('[data-testid="alias-bulk-success"]')).toBeNull()
  })

  it('reports a failed run without a committed count as the generic error', () => {
    const mutate = vi.fn((_variables, options) => {
      options.onError({ status: 500, body: { approved: 0 } })
    })
    vi.mocked(useBulkApproveExactAliases).mockReturnValue(bulk({ mutate }))

    const { container } = render(React.createElement(AliasCandidatesPanel))
    fireEvent.click(approveButton(container))

    expect(container.querySelector('[data-testid="alias-bulk-error"]').textContent).toBe(
      'aliasBulk.approveError'
    )
  })

  it('shows the loading state and the read error with retry', () => {
    vi.mocked(useAliasCandidateCounts).mockReturnValue(counts({ data: undefined, isLoading: true }))
    const loading = render(React.createElement(AliasCandidatesPanel))
    expect(loading.container.textContent).toContain('aliasBulk.loading')
    expect(approveButton(loading.container).disabled).toBe(true)
    loading.unmount()

    const refetch = vi.fn()
    vi.mocked(useAliasCandidateCounts).mockReturnValue(
      counts({ data: undefined, isError: true, refetch })
    )
    const failed = render(React.createElement(AliasCandidatesPanel))
    expect(failed.container.textContent).toContain('aliasBulk.error')
    const retry = [...failed.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'aliasBulk.retry'
    )
    fireEvent.click(retry)
    expect(refetch).toHaveBeenCalledTimes(1)
  })
})
