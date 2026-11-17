import { cn } from '../lib/cn.js'

// The shared metadata affordances of the QA review surfaces (issues #630 and
// #717): the em-dash placeholder, the verbatim value/percent formatters, the
// dt/dd pair, and the dl grid both expanded panels open into. Extracted from
// BrochureReview and PromosReview so the two panels cannot drift (issue #721
// review B1) — the per-surface field lists stay in each page.
export const NONE = '—'

// The cell text for one metadata field: null/'' collapse to the NONE
// placeholder, everything else renders as the exact string ingested — the
// panels are the ground truth for ingestion review, so no formatting here.
export function displayValue(value) {
  if (value == null) return NONE
  const text = String(value)
  return text === '' ? NONE : text
}

// The match-confidence cell: a ratio renders as a rounded percent; null or a
// non-numeric value collapses to NONE.
export function confidenceLabel(value) {
  if (value == null || Number.isNaN(Number(value))) return NONE
  return `${Math.round(Number(value) * 100)}%`
}

// One dt/dd pair: muted label above the verbatim value; `mono` switches the
// value to the monospace column for machine-shaped fields (keys, URLs,
// dates).
export function MetaField({ label, value, mono = false }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-text-muted">{label}</dt>
      <dd className={cn('mt-0.5 break-words text-sm', mono && 'font-mono text-xs')}>{value}</dd>
    </div>
  )
}

// The dl grid the expanded metadata renders into — two columns on small
// screens, three on wide. `testId` keeps each surface's selectors distinct
// for the QA suites.
export function MetadataDl({ testId, children }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3" data-testid={testId}>
      {children}
    </dl>
  )
}
