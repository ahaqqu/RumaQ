import { describe, it, expect, vi } from 'vite-plus/test'
import { isoOf, nextBirthday, parseISO, todayISO } from './household-date.js'

// Fixed-input pins for the household-date helpers (ahaqqu/RumaQ#468 review
// C1-A1): the birthday clamp/rollover math previously had no reliable pin —
// the page test only asserted it when CI ran in June. These run on literal
// dates, so every case holds in any month CI happens to run.

describe('nextBirthday', () => {
  it('returns this year’s occurrence when it is still ahead', () => {
    expect(nextBirthday('2022-06-15', '2026-01-10')).toBe('2026-06-15')
  })

  it('is inclusive: today IS the birthday', () => {
    expect(nextBirthday('2022-06-15', '2026-06-15')).toBe('2026-06-15')
  })

  it('rolls to next year once this year’s occurrence has passed', () => {
    expect(nextBirthday('2022-06-15', '2026-06-16')).toBe('2027-06-15')
  })

  it('crosses the year boundary (Jan 1 birthday seen from Dec 31)', () => {
    expect(nextBirthday('1990-01-01', '2026-12-31')).toBe('2027-01-01')
  })

  it('clamps Feb 29 to Feb 28 in a non-leap year', () => {
    expect(nextBirthday('2004-02-29', '2027-01-05')).toBe('2027-02-28')
  })

  it('keeps Feb 29 in a leap year (rolling past the non-leap clamp)', () => {
    expect(nextBirthday('2004-02-29', '2027-03-01')).toBe('2028-02-29')
  })

  it('rejects a malformed birth_date instead of guessing', () => {
    expect(nextBirthday('15-06-2022', '2026-01-10')).toBe(null)
  })
})

describe('todayISO (the WIB mirror)', () => {
  it('stays on the same household day at 23:59 WIB', () => {
    // 2026-11-07T16:59:00Z is 2026-11-07 23:59 WIB.
    vi.useFakeTimers({ now: new Date('2026-11-07T16:59:00Z') })
    try {
      expect(todayISO()).toBe('2026-11-07')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rolls to the next household day at midnight WIB', () => {
    // 2026-11-07T17:30:00Z is 2026-11-08 00:30 WIB — the thermos A3 case.
    vi.useFakeTimers({ now: new Date('2026-11-07T17:30:00Z') })
    try {
      expect(todayISO()).toBe('2026-11-08')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('parseISO / isoOf', () => {
  it('round-trips an ISO day on the UTC grid, never localizing', () => {
    expect(isoOf(parseISO('2026-11-15'))).toBe('2026-11-15')
    expect(parseISO('2026-11-15').getUTCMonth()).toBe(10)
  })
})
