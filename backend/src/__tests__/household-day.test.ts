import { describe, it, expect } from 'vite-plus/test'
import { householdDayFrom, householdIsoDate, householdMonth } from '../lib/household-day.js'

// Boundary pins for the household calendar (#554, #516 C6): the household
// operates in WIB (UTC+7, no DST). Every instant below is chosen INSIDE the
// 00:00–07:00 WIB skew window, where the UTC calendar is still the previous
// day — the plain toISOString().slice(0, 10) stamps were wrong exactly here.
// The mirror of these pins on the frontend is lib/household-date.test.js.

describe('householdIsoDate — the WIB day boundary', () => {
  it('rolls to the next household day at 00:30 WIB (17:30 UTC the day before)', () => {
    // UTC says 2026-11-07; the household has been on 2026-11-08 for half an hour.
    expect(householdIsoDate(new Date('2026-11-07T17:30:00.000Z'))).toBe('2026-11-08')
  })

  it('stays on the same household day at 23:30 WIB (16:30 UTC)', () => {
    expect(householdIsoDate(new Date('2026-11-07T16:30:00.000Z'))).toBe('2026-11-07')
  })

  it('agrees with the UTC calendar mid-day', () => {
    expect(householdIsoDate(new Date('2026-11-07T09:30:00.000Z'))).toBe('2026-11-07')
  })

  it('crosses the month boundary at 00:30 WIB on the 1st', () => {
    // UTC: October 31, 17:30. Household: November 1, 00:30.
    expect(householdIsoDate(new Date('2026-10-31T17:30:00.000Z'))).toBe('2026-11-01')
  })

  it('crosses the year boundary at 00:30 WIB on Jan 1', () => {
    expect(householdIsoDate(new Date('2026-12-31T17:30:00.000Z'))).toBe('2027-01-01')
  })

  it('holds the exact first instant of the household day (midnight WIB)', () => {
    expect(householdIsoDate(new Date('2026-11-07T17:00:00.000Z'))).toBe('2026-11-08')
    expect(householdIsoDate(new Date('2026-11-07T16:59:59.999Z'))).toBe('2026-11-07')
  })
})

describe('householdMonth — the WIB month', () => {
  it('is the household month, not the UTC month, inside the skew window', () => {
    expect(householdMonth(new Date('2026-10-31T17:30:00.000Z'))).toBe('2026-11')
    expect(householdMonth(new Date('2026-10-31T16:30:00.000Z'))).toBe('2026-10')
  })

  it('matches the household day it is derived from', () => {
    const now = new Date('2026-12-31T17:30:00.000Z')
    expect(householdIsoDate(now)).toBe('2027-01-01')
    expect(householdMonth(now)).toBe('2027-01')
  })
})

describe('householdDayFrom — cutoffs on the household calendar', () => {
  it('adds seven days across a month edge (the expiry cutoff)', () => {
    // Household today: 2026-11-01 (00:30 WIB). +7 days lands on 2026-11-08;
    // UTC-day arithmetic from the same instant would have said 2026-11-07.
    expect(householdDayFrom(new Date('2026-10-31T17:30:00.000Z'), 7)).toBe('2026-11-08')
  })

  it('reaches back thirty days across a month edge (the purchases window)', () => {
    // Household today: 2026-11-01. −30 days = 2026-10-02.
    expect(householdDayFrom(new Date('2026-10-31T17:30:00.000Z'), -30)).toBe('2026-10-02')
  })

  it('is exact at zero and across year edges', () => {
    expect(householdDayFrom(new Date('2026-11-07T16:30:00.000Z'), 0)).toBe('2026-11-07')
    expect(householdDayFrom(new Date('2026-12-31T17:30:00.000Z'), 7)).toBe('2027-01-08')
  })
})
