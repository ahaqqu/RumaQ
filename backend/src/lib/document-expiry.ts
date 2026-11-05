// Document expiry & renewal reminder rules (ahaqqu/RumaQ#426) — the lifecycle
// subdomain of the vault, split out of lib/documents.ts so the #426 rules
// (calendar, validation, the PATCH default/invariant resolution, the nightly
// due-set sweep) have one importable home: the routes import the validation
// shapes, the vault lib imports the calendar helpers for its projections, and
// the cron imports only the sweep.
//
// This module is intentionally free of imports from documents.ts (structural
// parameter types only, D1Database comes from workers-types) — vault mutation
// machinery (audit statements, read-backs, error classes) stays there, so
// there is no import cycle in either direction.

/** The app-level remind window (see the migration 0026 header for why this
 * default lives in the app and not as a column DEFAULT), and the PATCH
 * validation bounds: integer days. */
export const DEFAULT_REMIND_DAYS_BEFORE = 30
export const REMIND_DAYS_MIN = 1
export const REMIND_DAYS_MAX = 365

// --- Household calendar ----------------------------------------------------
// All date math is calendar-day arithmetic over ISO YYYY-MM-DD text (the
// 0020/0026 storage shape): both sides parse as fixed midnights, so a whole
// day is exactly 86,400,000 ms and no DST can shift a boundary.
//
// The calendar is pinned at UTC+7 (WIB) — the Indonesia-first product's
// dominant audience. Deriving "today" from the UTC calendar would leave every
// response between local midnight and ~07:00 WIB one day behind the
// household's calendar: the chip would say "expires in 1 day" for a document
// expiring TODAY, and the danger/warn tone boundary would shift by the same
// skew. ONE helper below feeds all three surfaces — the list projections'
// days_until_expiry, the expiring_within horizon, and the nightly cron sweep —
// so they can never disagree. Localization of the offset (per-household
// settings) can ride on later; every call site takes `now` as an injectable
// parameter, which is what keeps the fixed-clock tests exact.

/**
 * The household calendar day as ISO YYYY-MM-DD, pinned at UTC+7 (WIB).
 * Shift the instant, then read the UTC date of the shifted instant — exact
 * because the shift is a constant offset (no DST in the target zone).
 */
export function householdIsoDate(now: Date): string {
  return new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10)
}

/**
 * A REAL calendar date in YYYY-MM-DD form — the regex alone accepts
 * 2026-02-31, so the round-trip through Date.UTC pins month lengths (and
 * leap years). Used by the PATCH validation; the CHECK-less column relies
 * on this being the only writer.
 */
export function isValidExpiryDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const roundTrip = new Date(Date.UTC(year, month - 1, day))
  return (
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day
  )
}

/**
 * Whole days from `today` (ISO date) until `expiresOn` (ISO date). Negative
 * = already expired. Invalid inputs answer null — the projections degrade
 * to "no expiry" rather than inventing a number.
 */
export function daysUntil(expiresOn: string | null, today: string): number | null {
  if (!expiresOn || !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) return null
  const parse = (iso: string): number => {
    const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((parse(expiresOn) - parse(today)) / 86_400_000)
}

// --- PATCH resolution ------------------------------------------------------

export type ExpiryUpdateFields = {
  expiresOn?: string | null
  remindDaysBefore?: number
}

/**
 * The resolved expiry payload for one PATCH (#426): the route validates the
 * raw fields (date shape, window bounds) and hands the document row plus the
 * raw PATCH fields here; this resolves the app-level default and maintains
 * the stored invariant expires_on non-null ⇒ remind_days_before non-null.
 *
 *   - clearing the expiry (expires_on: null) clears the window with it —
 *     a reminder window without an expiry is meaningless,
 *   - setting/keeping an expiry without an explicit window keeps the
 *     document's existing window when it already had one (a date correction
 *     must not silently clobber a chosen window) and otherwise applies the
 *     DEFAULT_REMIND_DAYS_BEFORE,
 *   - a window without an expiry (present or being set) is a 400 at the
 *     route — there is nothing to remind about, which is why the window-only
 *     branch can trust document.expires_on / fields.remindDaysBefore.
 */
export function resolveExpiryUpdate(
  document: { expires_on: string | null; remind_days_before: number | null },
  fields: ExpiryUpdateFields
): { expiresOn: string | null; remindDaysBefore: number | null } {
  if (fields.expiresOn === null) {
    return { expiresOn: null, remindDaysBefore: null }
  }
  if (fields.expiresOn !== undefined) {
    return {
      expiresOn: fields.expiresOn,
      remindDaysBefore:
        fields.remindDaysBefore ?? document.remind_days_before ?? DEFAULT_REMIND_DAYS_BEFORE,
    }
  }
  // Window-only PATCH (expiry guaranteed by the route's 400 pre-check; an
  // empty body never reaches here, so the window is present).
  return { expiresOn: document.expires_on, remindDaysBefore: fields.remindDaysBefore ?? null }
}

// --- Renewal reminder sweep (#426) ----------------------------------------

export type DueDocument = {
  household_id: string
  id: string
  name: string
  expires_on: string
  remind_days_before: number | null
  days_until_expiry: number
}

/**
 * The due set for the nightly tick (#426): every document whose expiry has
 * entered its own reminder window (days_until_expiry <= remind_days_before,
 * the NULL window read as DEFAULT_REMIND_DAYS_BEFORE), across ALL households
 * — the cron runs with no caller household. Expired documents stay in the
 * set (they are the most due). One full pass over the expiry-bearing rows
 * keeps every date computation in this module's helpers (the same daysUntil
 * the projections use) instead of a second SQL dialect of the rule; vault
 * sizes are household-scale, so the scan is bounded by design.
 */
export async function listDueDocumentReminders(
  db: D1Database,
  now: Date = new Date()
): Promise<DueDocument[]> {
  const { results } = await db
    .prepare(
      `SELECT id, household_id, name, expires_on, remind_days_before
         FROM documents
        WHERE expires_on IS NOT NULL`
    )
    .bind() // Zero-param statement; .bind() keeps the statement shape uniform.
    .all<{
      id: string
      household_id: string
      name: string
      expires_on: string
      remind_days_before: number | null
    }>()
  const today = householdIsoDate(now)
  const due: DueDocument[] = []
  for (const row of results) {
    const days = daysUntil(row.expires_on, today)
    if (days === null) continue
    const window = row.remind_days_before ?? DEFAULT_REMIND_DAYS_BEFORE
    if (days <= window) {
      due.push({ ...row, days_until_expiry: days })
    }
  }
  return due.sort((a, b) => a.expires_on.localeCompare(b.expires_on) || a.id.localeCompare(b.id))
}

/**
 * The nightly tick's report (#426): compute the due set and log a compact
 * summary — v1 renders in-app (the documents page derives due-soon from the
 * same rows), so this sweep is observability, not a new notification channel
 * (the #353 retention-sweep precedent: cron piggyback, log as the artifact).
 * v2 dispatch rides this exact set once a channel exists.
 */
export async function logDueDocumentReminders(
  db: D1Database,
  now: Date = new Date()
): Promise<DueDocument[]> {
  const due = await listDueDocumentReminders(db, now)
  if (due.length > 0) {
    const households = new Set(due.map((d) => d.household_id))
    console.log(
      `[documents] renewal reminders: ${due.length} document(s) due across ${households.size} household(s)`
    )
  }
  return due
}
