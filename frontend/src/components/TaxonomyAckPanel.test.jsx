import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import React from 'react'
import { TaxonomyAckPanel } from './TaxonomyAckPanel.jsx'

// The hooks are mocked at their boundary (the AliasCandidatesPanel.test.jsx
// idiom): these tests cover the panel's state machine — the count-gated
// action, the required confirm, busy, the success line, and the failure line —
// not React Query or the network.
vi.mock('../lib/queries/review.js', () => ({
  useAcknowledgeTaxonomy: vi.fn(),
}))

import { useAcknowledgeTaxonomy } from '../lib/queries/review.js'

function ack(overrides = {}) {
  return {
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    data: null,
    ...overrides,
  }
}

function ackButton(container) {
  return [...container.querySelectorAll('button')].find((el) =>
    el.textContent.startsWith('review.taxonomyAck')
  )
}

describe('TaxonomyAckPanel', () => {
  beforeEach(() => {
    vi.mocked(useAcknowledgeTaxonomy).mockReturnValue(ack())
    // The panel's confirm is the browser dialog (the AliasCandidatesPanel
    // idiom), so the tests stub it and assert on the call.
    window.confirm = vi.fn(() => true)
  })

  it('renders the lead line and the count-named action when pending flags exist', () => {
    const { container } = render(React.createElement(TaxonomyAckPanel, { pendingCount: 603 }))
    expect(container.textContent).toContain('review.taxonomyLead')
    const button = ackButton(container)
    expect(button.textContent).toBe('review.taxonomyAck')
    expect(button.disabled).toBe(false)
  })

  it('hides the action when nothing is pending — the lead still explains the page', () => {
    const { container } = render(React.createElement(TaxonomyAckPanel, { pendingCount: 0 }))
    expect(container.textContent).toContain('review.taxonomyLead')
    expect(ackButton(container)).toBeUndefined()
  })

  it('mutates only after the confirm accepts, naming the count it acts on', () => {
    const { container } = render(React.createElement(TaxonomyAckPanel, { pendingCount: 603 }))
    fireEvent.click(ackButton(container))
    expect(window.confirm).toHaveBeenCalledWith('review.taxonomyAckConfirm')
    expect(useAcknowledgeTaxonomy().mutate).toHaveBeenCalled()
  })

  it('does not mutate when the confirm is dismissed', () => {
    window.confirm = vi.fn(() => false)
    const { container } = render(React.createElement(TaxonomyAckPanel, { pendingCount: 603 }))
    fireEvent.click(ackButton(container))
    expect(window.confirm).toHaveBeenCalled()
    expect(useAcknowledgeTaxonomy().mutate).not.toHaveBeenCalled()
  })

  it('disables the action while the acknowledgement records', () => {
    vi.mocked(useAcknowledgeTaxonomy).mockReturnValue(ack({ isPending: true }))
    const { container } = render(React.createElement(TaxonomyAckPanel, { pendingCount: 603 }))
    expect(ackButton(container).disabled).toBe(true)
    expect(container.querySelector('[role="status"]').textContent).toBe('review.taxonomyAckWorking')
  })

  it('names the acknowledged count when the bulk decision lands', () => {
    vi.mocked(useAcknowledgeTaxonomy).mockReturnValue(
      ack({ isSuccess: true, data: { acknowledged: 603, remaining: 0 } })
    )
    const { container } = render(React.createElement(TaxonomyAckPanel, { pendingCount: 0 }))
    const status = [...container.querySelectorAll('[role="status"]')]
    expect(status.some((el) => el.textContent === 'review.taxonomyAckDone')).toBe(true)
  })

  it('renders the failure line as an alert on error', () => {
    vi.mocked(useAcknowledgeTaxonomy).mockReturnValue(ack({ isError: true }))
    const { container } = render(React.createElement(TaxonomyAckPanel, { pendingCount: 603 }))
    const alert = container.querySelector('[role="alert"]')
    expect(alert.textContent).toBe('review.taxonomyAckFailed')
  })
})
