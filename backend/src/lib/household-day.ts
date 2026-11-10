// The household calendar day (#554, #516 C6): every calendar day the backend
// decides — the /api/home expiry and month-spend windows, purchase date
// stamps (scan default, plan check-off), the AI-usage day buckets — is a
// household day in WIB (UTC+7), never the Worker's UTC day. Between 00:00 and
// 07:00 WIB the UTC calendar is still yesterday, so a plain
// `toISOString().slice(0, 10)` skews every window one day behind the
// household: a purchase made at 00:30 WIB was stored with yesterday's date,
// the month-spend window crossed months at 07:00 WIB instead of midnight.
//
// WIB has no DST, so a fixed +07:00 offset is exact and testable: shift the
// instant by the offset, then read the shifted instant's UTC calendar.
//
// Stored calendar-day columns (the one statement of it): every YYYY-MM-DD
// `date` column written by the API — purchases.date, ai_usage_events.date,
// documents.expires_on, tasks due/completed dates — carries a WIB household
// calendar day, derived at write time. Rows written before #554 may carry the
// UTC day for events in the 00:00–07:00 WIB window; they are not migrated —
// the strings stay readable and every read derives from the stored day.
//
// Frontend mirror: frontend/src/lib/household-date.js (todayISO) — the
// frontend cannot import backend lib code, so the constant offset is
// duplicated there with comments tying the two together.

const WIB_OFFSET_MS = 7 * 3_600_000

/**
 * The household calendar day as ISO YYYY-MM-DD, pinned at UTC+7 (WIB).
 * Shift the instant, then read the UTC date of the shifted instant — exact
 * because the shift is a constant offset (no DST in the target zone).
 */
export function householdIsoDate(now: Date): string {
  return new Date(now.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * The household calendar day shifted by whole days: `householdDayFrom(now, 7)`
 * is "seven days from today" ON the household calendar (the expiry cutoffs),
 * a negative shift reaches back ("the last 30 days" of purchases). Adding
 * whole days to the instant is exact calendar arithmetic here — WIB has no
 * DST, so the shifted instant's household day is the original's + N days.
 */
export function householdDayFrom(now: Date, days: number): string {
  return householdIsoDate(new Date(now.getTime() + days * 86_400_000))
}

/**
 * The household calendar MONTH as YYYY-MM — the month-spend window and the
 * history month buckets bucket by this. It is the month prefix of the
 * household day, never the UTC month: near month boundaries the two differ
 * for the whole 00:00–07:00 WIB window.
 */
export function householdMonth(now: Date): string {
  return householdIsoDate(now).slice(0, 7)
}
