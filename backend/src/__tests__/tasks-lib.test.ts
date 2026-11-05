import { describe, it, expect } from 'vite-plus/test'
import { computeNextDue } from '../lib/tasks.js'

// computeNextDue is the recurrence roll-forward (ahaqqu/RumaQ#429 v1): the
// CURRENT due date anchors the schedule and the next occurrence advances past
// the completion day, so a chore completed late never comes due in the past.
// Pure date math — pinned here on fixed calendar days, no clock.

describe('computeNextDue (recurrence next-due on completion)', () => {
  it('advances a daily task one day past an on-time completion', () => {
    expect(computeNextDue('daily', '2026-11-10', '2026-11-10')).toBe('2026-11-11')
  })

  it('advances a weekly task exactly seven days', () => {
    expect(computeNextDue('weekly', '2026-11-02', '2026-11-02')).toBe('2026-11-09')
  })

  it('advances a monthly task one calendar month', () => {
    expect(computeNextDue('monthly', '2026-01-15', '2026-01-15')).toBe('2026-02-15')
  })

  it('anchors on the completion day when the task has no due date', () => {
    expect(computeNextDue('daily', null, '2026-11-06')).toBe('2026-11-07')
    expect(computeNextDue('monthly', null, '2026-11-06')).toBe('2026-12-06')
  })

  it('catches up past the completion day when the chore was completed late', () => {
    // Daily chore due the 2nd, completed the 6th: the missed days do not
    // stack up — the next due is the day AFTER completion.
    expect(computeNextDue('daily', '2026-11-02', '2026-11-06')).toBe('2026-11-07')
    // Weekly chore due last Monday, completed Thursday: next Monday.
    expect(computeNextDue('weekly', '2026-11-02', '2026-11-05')).toBe('2026-11-09')
  })

  it('clamps month-end arithmetic (Jan 31 + 1 month is Feb 28, not March 3)', () => {
    expect(computeNextDue('monthly', '2026-01-31', '2026-01-31')).toBe('2026-02-28')
    // Leap years clamp both ways: Jan 31 + 1 month lands on Feb 29 in a leap
    // year and on Feb 28 otherwise.
    expect(computeNextDue('monthly', '2024-01-31', '2024-01-31')).toBe('2024-02-29')
    expect(computeNextDue('monthly', '2023-01-31', '2023-01-31')).toBe('2023-02-28')
    // And the schedule stays anchored on the clamped day: Jan 31 → Feb 28 →
    // Mar 28 (each step advances from the previous, clamped, date).
    expect(computeNextDue('monthly', '2026-01-31', '2026-03-20')).toBe('2026-03-28')
  })

  it('never returns a date on or before the completion day', () => {
    expect(computeNextDue('daily', '2026-11-06', '2026-11-06')).toBe('2026-11-07')
    expect(computeNextDue('weekly', '2026-11-06', '2026-11-13')).toBe('2026-11-20')
  })
})
