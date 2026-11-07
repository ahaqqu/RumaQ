import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import React from 'react'
import { AliasCandidatesPanel } from './AliasCandidatesPanel.jsx'

// Real-copy pass for the alias-candidates panel (ahaqqu/RumaQ#515). The
// sibling AliasCandidatesPanel.test.jsx runs on test-setup's raw-key t(), so
// assertions read keys and the interpolated numbers are invisible to them:
// dropping `{ count }`, passing the wrong count, or zeroing the partial-failure
// count would all stay green. This file resolves en.json and interpolates like
// i18next does (the ProductRenameForm.i18n.test.jsx idiom) and pins the
// sentences the acceptance criteria name: the confirm names the count it is
// about to move, the success notice names the approved count and the index
// version, and a partial failure names how many aliases were already approved.
vi.mock('react-i18next', async () => {
  const { vi } = await import('vite-plus/test')
  const en = (await import('../i18n/locales/en.json')).default
  const lookup = (key) => key.split('.').reduce((node, k) => (node == null ? node : node[k]), en)
  const t = (key, opts) => {
    if (opts && opts.returnObjects) return {}
    let template
    if (opts && typeof opts.count === 'number') {
      template = lookup(`${key}_${opts.count === 1 ? 'one' : 'other'}`)
    }
    if (typeof template !== 'string') template = lookup(key)
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

vi.mock('../lib/queries/products.js', () => ({
  useAliasCandidateCounts: vi.fn(),
  useBulkApproveExactAliases: vi.fn(),
}))

import { useAliasCandidateCounts, useBulkApproveExactAliases } from '../lib/queries/products.js'

function counts(exactCandidates) {
  return {
    data: { candidates: 1973, exactCandidates },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }
}

function bulk(mutate = vi.fn()) {
  return { mutate, isPending: false }
}

function approveButton(container) {
  return container.querySelector('[data-testid="alias-bulk-approve"]')
}

describe('AliasCandidatesPanel real copy (#515)', () => {
  beforeEach(() => {
    vi.mocked(useAliasCandidateCounts).mockReturnValue(counts(42))
    vi.mocked(useBulkApproveExactAliases).mockReturnValue(bulk())
    window.confirm = vi.fn(() => true)
  })

  it('names the exact-match count in the confirm', () => {
    const { container } = render(React.createElement(AliasCandidatesPanel))
    fireEvent.click(approveButton(container))

    expect(window.confirm).toHaveBeenCalledWith(
      'Approve 42 exact-name alias candidates? They enter the canonical index; every other candidate stays for manual review.'
    )
  })

  it('uses the singular confirm when one candidate matches', () => {
    vi.mocked(useAliasCandidateCounts).mockReturnValue(counts(1))
    const { container } = render(React.createElement(AliasCandidatesPanel))
    fireEvent.click(approveButton(container))

    expect(window.confirm).toHaveBeenCalledWith(
      'Approve 1 exact-name alias candidate? It enters the canonical index; every other candidate stays for manual review.'
    )
  })

  it('reports the approved count and the new index version on success', () => {
    const mutate = vi.fn((_variables, options) => {
      options.onSuccess({
        exactCandidates: 42,
        approved: 42,
        remainingCandidates: 1931,
        indexVersion: 9,
      })
    })
    vi.mocked(useBulkApproveExactAliases).mockReturnValue(bulk(mutate))

    const { container } = render(React.createElement(AliasCandidatesPanel))
    fireEvent.click(approveButton(container))

    const notice = container.querySelector('[data-testid="alias-bulk-success"]')
    expect(notice.textContent).toContain('Approved 42 exact-name aliases.')
    expect(notice.textContent).toContain('Canonical index version')
    expect(container.querySelector('[data-testid="alias-bulk-index-version"]').textContent).toBe(
      '9'
    )
  })

  it('says nothing is left when the run approved zero', () => {
    const mutate = vi.fn((_variables, options) => {
      options.onSuccess({
        exactCandidates: 0,
        approved: 0,
        remainingCandidates: 1973,
        indexVersion: 9,
      })
    })
    vi.mocked(useBulkApproveExactAliases).mockReturnValue(bulk(mutate))

    const { container } = render(React.createElement(AliasCandidatesPanel))
    fireEvent.click(approveButton(container))

    expect(container.querySelector('[data-testid="alias-bulk-success"]').textContent).toContain(
      'Nothing to approve — no candidate exactly matches its product name.'
    )
  })

  it('names how many aliases were already approved when the run stops mid-way', () => {
    const mutate = vi.fn((_variables, options) => {
      options.onError({ status: 500, body: { approved: 3 } })
    })
    vi.mocked(useBulkApproveExactAliases).mockReturnValue(bulk(mutate))

    const { container } = render(React.createElement(AliasCandidatesPanel))
    fireEvent.click(approveButton(container))

    expect(container.querySelector('[data-testid="alias-bulk-error"]').textContent).toBe(
      '3 aliases were approved before the run stopped. Refresh to see the current counts.'
    )
  })

  it('shows the generic failure when the run committed nothing', () => {
    const mutate = vi.fn((_variables, options) => {
      options.onError({ status: 500, body: { approved: 0 } })
    })
    vi.mocked(useBulkApproveExactAliases).mockReturnValue(bulk(mutate))

    const { container } = render(React.createElement(AliasCandidatesPanel))
    fireEvent.click(approveButton(container))

    expect(container.querySelector('[data-testid="alias-bulk-error"]').textContent).toBe(
      'The bulk approval could not be completed.'
    )
  })
})
