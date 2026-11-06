// The household-date helpers: the ONE frontend definition of the WIB day and
// the UTC ISO grid math, shared by the pages that render household time
// (Tasks overdue highlight, Calendar month view) instead of a page-local copy
// each (ahaqqu/RumaQ#468 review C1-B4).

// The household calendar day as ISO YYYY-MM-DD, pinned at UTC+7 (WIB) — the
// frontend MIRROR of the backend's householdIsoDate (lib/document-expiry.ts,
// #426; the frontend cannot import backend lib code, so the constant offset
// is duplicated with this comment tying the two together — thermos A3
// decision). A plain-UTC "today" left the overdue highlight ~7 hours late
// every WIB night: a chore due yesterday kept its highlight until 07:00.
export function todayISO() {
  return new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10)
}

// ISO date text as a UTC-midnight Date — the household day convention never
// localizes (the backend mirrors this in lib/document-expiry.ts).
export function parseISO(iso) {
  return new Date(`${iso}T00:00:00Z`)
}

// A UTC Date back to ISO YYYY-MM-DD (the month grid and window bounds).
export function isoOf(date) {
  return date.toISOString().slice(0, 10)
}
