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

/** Next occurrence of the member's birth month/day on or after `today` (the
 * calendar's birthday preset). Feb 29 clamps to Feb 28 in non-leap years —
 * the same clamping idea as the tasks domain's monthly roll-forward. Pinned
 * with fixed-input unit tests in household-date.test.js (ahaqqu/RumaQ#468
 * review C1-A1): the prefill lands in every month, so the page test computes
 * its expectation from THIS function instead of skipping 11 months of the
 * year. */
export function nextBirthday(birthDate, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return null
  const [, month, day] = birthDate.split('-').map(Number)
  const baseYear = Number(today.slice(0, 4))
  for (let year = baseYear; year <= baseYear + 1; year++) {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`
    if (iso >= today) return iso
  }
  return null
}
