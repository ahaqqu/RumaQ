// Vault expiry OCR (ahaqqu/RumaQ#433): the post-model validation and policy
// layer for reading a document image's expiry date with the user's OWN AI
// provider (resolved through lib/ai-access.ts — never the pipeline, never a
// hardcoded provider). Split from the route so the rules are unit-testable
// without HTTP, per the vault's page/lib split (lib/document-expiry.ts owns
// the calendar rules, this owns the OCR round-trip rules; lib/ai.ts owns the
// provider call itself).
//
// The model NEVER writes: this module only produces a suggestion the expiry
// editor prefills, and the user confirms through the existing #426 PATCH
// (which keeps writing its own 'update' audit row).

import { isValidExpiryDate } from './document-expiry.js'

// Vision models read pixels, not PDFs: only the vault's image types can ride
// the vision call. PDF is a legitimate vault type (sniff allowlist in
// lib/documents.ts) but a different extraction path — refused with a clear
// message rather than silently misread.
export const EXPIRY_OCR_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
])

export function isExpiryOcrSupported(contentType: string): boolean {
  return EXPIRY_OCR_MIME_TYPES.has(contentType)
}

export class DocumentOcrError extends Error {
  constructor(message = 'Could not read an expiry date from this document') {
    super(message)
    this.name = 'DocumentOcrError'
  }
}

/**
 * The strict post-model validation (the pipeline's proven pattern): the raw
 * `{ expires_on }` JSON must be either a real calendar date (YYYY-MM-DD —
 * the same isValidExpiryDate the PATCH route enforces, so a suggestion can
 * never be a date the user could not have typed) or null ("no expiry found",
 * a legitimate answer). Anything else — wrong type, wrong shape, a
 * well-formed non-date like 2026-02-31 — is a rejection, not a fallback.
 */
export function normalizeExpirySuggestion(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string' || !isValidExpiryDate(raw)) {
    throw new DocumentOcrError()
  }
  return raw
}

/**
 * The attempt's outcome for the audit line — the model and outcome are
 * logged, never document content (issue #433 audit rule; the usage event
 * already carries provider/model/tokens for every attempt).
 */
export type ExpiryOcrOutcome = 'suggested' | 'no_date' | 'rejected' | 'failed'

export function expiryOcrOutcome(suggestion: string | null): ExpiryOcrOutcome {
  return suggestion === null ? 'no_date' : 'suggested'
}

export function logExpiryOcrOutcome(args: {
  householdId: string
  documentId: string
  fileId: string
  model: string | null
  outcome: ExpiryOcrOutcome
}): void {
  console.log(
    `[documents] expiry OCR: household=${args.householdId} document=${args.documentId} ` +
      `file=${args.fileId} model=${args.model ?? '(provider default)'} outcome=${args.outcome}`
  )
}
