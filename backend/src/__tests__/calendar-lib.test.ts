import { describe, it, expect } from 'vite-plus/test'
import {
  compareEntries,
  deriveDeadlineEntries,
  isValidEventTime,
  type CalendarEntry,
  type DeadlineDocument,
  type DeadlineEntry,
} from '../lib/calendar.js'

// The deadline derivation (ahaqqu/RumaQ#430) is PURE date math over ISO text
// — `today` is an injectable parameter (the #426 discipline), so these pins
// are exact, not clock-dependent. Everything else about the union view (the
// SQL, the household predicate, the visibility read) is pinned in
// calendar-sql.test.ts against a real SQLite engine.

const TODAY = '2026-11-06'

function doc(overrides: Partial<DeadlineDocument> = {}): DeadlineDocument {
  return {
    id: 'd1',
    name: 'STNK Bapak',
    member_id: 'm-ibu',
    expires_on: '2026-11-25',
    remind_days_before: 30,
    ...overrides,
  }
}

describe('deriveDeadlineEntries (the derive-on-read deadline projection)', () => {
  it('projects an expiry into a deadline entry with the doc: id and the computed distance', () => {
    const entries = deriveDeadlineEntries([doc()], TODAY)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'deadline',
      id: 'doc:d1',
      document_id: 'd1',
      title: 'STNK Bapak',
      date: '2026-11-25',
      member_id: 'm-ibu',
      days_until_expiry: 19,
      due_soon: true,
    })
  })

  it('reads a NULL remind window as the 30-day default (#426 app-level default)', () => {
    const inside = deriveDeadlineEntries(
      [doc({ remind_days_before: null, expires_on: '2026-12-05' })],
      TODAY
    )
    expect(inside[0].days_until_expiry).toBe(29)
    expect(inside[0].due_soon).toBe(true)
    const outside = deriveDeadlineEntries(
      [doc({ remind_days_before: null, expires_on: '2026-12-07' })],
      TODAY
    )
    expect(outside[0].days_until_expiry).toBe(31)
    expect(outside[0].due_soon).toBe(false)
  })

  it('honors a custom window: 7 days means due-soon only in the last week', () => {
    const day8 = deriveDeadlineEntries(
      [doc({ remind_days_before: 7, expires_on: '2026-11-14' })],
      TODAY
    )
    expect(day8[0].due_soon).toBe(false)
    const day7 = deriveDeadlineEntries(
      [doc({ remind_days_before: 7, expires_on: '2026-11-13' })],
      TODAY
    )
    expect(day7[0].due_soon).toBe(true)
  })

  it('keeps expired documents due (negative distance, always due_soon)', () => {
    const expired = deriveDeadlineEntries([doc({ expires_on: '2026-10-31' })], TODAY)
    expect(expired[0].days_until_expiry).toBe(-6)
    expect(expired[0].due_soon).toBe(true)
  })

  it('is exactly due on the boundary day (distance 0 = today)', () => {
    const today = deriveDeadlineEntries([doc({ expires_on: TODAY })], TODAY)
    expect(today[0].days_until_expiry).toBe(0)
    expect(today[0].due_soon).toBe(true)
  })

  it('degrades a malformed stored date to no entry, never an invented number', () => {
    // daysUntil validates the ISO SHAPE (a hand-edited 2026-02-31 yields a
    // shifted-but-deterministic number — the #434 behavior, not re-validated
    // here); only a malformed value degrades to nothing.
    const entries = deriveDeadlineEntries([doc({ expires_on: 'soon' })], TODAY)
    expect(entries).toHaveLength(0)
  })

  it('does not narrow the window by the remind window — the caller’s date range is the filter', () => {
    // A far-future renewal (16 months out) still projects — the calendar month
    // grid stays plannable; remind_days_before only drives the due_soon flag.
    const far = deriveDeadlineEntries([doc({ expires_on: '2028-03-10' })], TODAY)
    expect(far[0].due_soon).toBe(false)
    expect(far[0].days_until_expiry).toBeGreaterThan(400)
  })
})

describe('compareEntries (the day-chronological union order)', () => {
  const deadline = (over: { id: string; date: string; title?: string }): DeadlineEntry => ({
    kind: 'deadline',
    id: over.id,
    document_id: over.id,
    title: over.title ?? 'Deadline',
    date: over.date,
    member_id: null,
    days_until_expiry: 0,
    due_soon: false,
  })

  const eventEntry = (over: {
    id: string
    date: string
    title?: string
    time?: string | null
  }): CalendarEntry => ({
    kind: 'event',
    id: over.id,
    household_id: 'h1',
    title: over.title ?? 'Event',
    date: over.date,
    time: over.time ?? null,
    visibility: 'all',
    member_ids: null,
    created_by_member_id: null,
    created_at: '2026-11-06 00:00:00',
    updated_at: '2026-11-06 00:00:00',
  })

  it('orders by date first', () => {
    const a = eventEntry({ id: 'a', date: '2026-11-10' })
    const b = eventEntry({ id: 'b', date: '2026-11-11' })
    expect(compareEntries(a, b)).toBeLessThan(0)
  })

  it('puts all-day entries (and deadlines — all-day by definition) before timed events', () => {
    const allDay = eventEntry({ id: 'a', date: '2026-11-10' })
    const timed = eventEntry({ id: 'b', date: '2026-11-10', time: '09:30' })
    const derived = deadline({ id: 'd', date: '2026-11-10' })
    expect(compareEntries(allDay, timed)).toBeLessThan(0)
    expect(compareEntries(derived, timed)).toBeLessThan(0)
    expect(compareEntries(timed, allDay)).toBeGreaterThan(0)
  })

  it('orders timed events chronologically within a day', () => {
    const early = eventEntry({ id: 'a', date: '2026-11-10', time: '07:00' })
    const late = eventEntry({ id: 'b', date: '2026-11-10', time: '19:00' })
    expect(compareEntries(early, late)).toBeLessThan(0)
  })

  it('breaks ties on title, then id (deterministic, the 0022 discipline)', () => {
    const a = deadline({ id: 'a', date: '2026-11-10', title: 'Aku' })
    const b = deadline({ id: 'b', date: '2026-11-10', title: 'Buku' })
    expect(compareEntries(a, b)).toBeLessThan(0)
    const a2 = deadline({ id: 'a2', date: '2026-11-10', title: 'same' })
    const b2 = deadline({ id: 'b2', date: '2026-11-10', title: 'same' })
    expect(compareEntries(a2, b2)).toBeLessThan(0)
    expect(compareEntries(a2, a2)).toBe(0)
  })
})

describe('isValidEventTime (the optional HH:MM wall-clock shape)', () => {
  it('accepts the 24h clock', () => {
    for (const ok of ['00:00', '09:30', '23:59', '17:05']) {
      expect(isValidEventTime(ok)).toBe(true)
    }
  })

  it('rejects everything else', () => {
    for (const bad of ['24:00', '9:30', '07:5', '07:60', '7:5', '0700', '', '07:30:00', 'ab:cd']) {
      expect(isValidEventTime(bad)).toBe(false)
    }
  })
})
