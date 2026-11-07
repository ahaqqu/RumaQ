// Vault expiry OCR (ahaqqu/RumaQ#433): the post-model validation and policy
// layer for reading a document image's expiry date with the user's OWN AI
// provider. Split from the route so the rules are unit-testable without HTTP,
// per the vault's page/lib split (lib/document-expiry.ts owns the calendar
// rules, this owns the OCR round-trip rules; the AI door owns the provider
// call). runExpiryOcr additionally OWNS the attempt's audit pairing — the
// ai_usage_events row + the outcome log line, written once, on every path that
// reaches the provider decision (review T4-B2: the invariant lives here, not as
// two parallel copies in the route).
//
// #523 P4: this is a VISION call, through the door's `vision()` on the
// household's `vision` capability. Before P4 the shim dispatched it on the
// legacy single-provider path with `ai_vision_model ?? ai_model`; the capability
// assignment is now the only input, so the model, the provider row and the
// usage row's dimensions all come from the resolved handle.
//
// The model NEVER writes: this module only produces a suggestion the expiry
// editor prefills, and the user confirms through the existing #426 PATCH
// (which keeps writing its own 'update' audit row).

import type { Env } from '../types.js'
import {
  AiError,
  EMPTY_USAGE,
  parseJsonResponse,
  vision,
  type AiAccessHandle,
  type AiCall,
  type TokenUsage,
} from './ai/index.js'
import { recordAiUsageEvent } from './ai/usage.js'
import { isValidExpiryDate } from './document-expiry.js'

// The vault's expiry-date extraction prompt (issue #433). LOAD-BEARING and
// owner-reviewed like the pipeline prompts: the model's answer feeds the
// expiry editor, so the rules pin WHICH date counts (validity end — never an
// issuance, registration, purchase, or effective-from date) and how the many
// Indonesian/English document printings map to one ISO date. KTP has no
// expiry — returning null there is correct, not a failure. Moved out of
// lib/ai.ts when the P2 shim was deleted in P4 (#523): a prompt is product
// policy and stays outside the door.
export function buildExpiryExtractionPrompt(): string {
  return `You are a document OCR assistant. Look at the scanned document image and find the date the document's VALIDITY ENDS (its expiry date).

Return ONLY valid JSON in this exact format:
{ "expires_on": "YYYY-MM-DD or null" }

What counts as the expiry date:
- The date the document STOPS being valid: "Berlaku s/d", "Masa Berlaku", "Berlaku Hingga", "Valid Until", "Valid Thru", "Date of Expiry", "Expiry Date", "Kedaluwarsa", "Sampai Dengan".
- Examples by document type: passport → "Date of Expiry"/"Tanggal Kedaluwarsa"; SIM (driver licence) → "Berlaku Hingga"; STNK → "MASA BERLAKU S/D" (the LATER date shown, not "TGL JATUH TEMPO"); insurance policy → the period END date; warranty card → end of the warranty period.

What does NOT count (never return these):
- Issue, issuance, registration, purchase, or effective-from dates: "Tanggal Terbit", "Diterbitkan", "Issued on", "Tgl Pembelian", "Tanggal Effective", "Valid From".
- Payment due dates, instalment schedules, or any other date on the page.

Rules:
- Convert whatever printed format you find (DD-MM-YYYY, DD/MM/YYYY, "DD MMM YYYY", Indonesian month names like MEI/AGT/DES) into YYYY-MM-DD.
- Documents that never expire (for example a KTP/e-KTP marked "SEUMUR HIDUP") have no expiry: return null.
- If the expiry date is absent, unreadable, or ambiguous, return null. Never guess.
- Do NOT include any text outside the JSON.`
}

// The raw model answer: the date field is validated below (a real calendar
// date or JSON null), never used as-is. The key must be PRESENT — a missing
// `expires_on` is an off-schema answer, not "no date found".
export type RawExpiryExtraction = {
  expires_on?: string | null
}

/** The one extraction policy (the door's parseJsonResponse) + the feature's shape. */
export function parseExpiryExtraction(content: string): RawExpiryExtraction {
  return parseJsonResponse<RawExpiryExtraction>(content)
}

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
 * never be a date the user could not have typed) or JSON null ("no expiry
 * found", a legitimate answer). Anything else — wrong type, a MISSING key
 * (undefined: an off-schema answer like `{"expiry_date": ...}` or `{}`),
 * a well-formed non-date like 2026-02-31 — is a rejection, not a fallback
 * (review T4-A3: only null means "no date found"; silently reading an
 * off-schema answer as "no date" would disguise a schema violation as a
 * legitimate KTP-style answer).
 */
export function normalizeExpirySuggestion(raw: unknown): string | null {
  if (raw === null) return null
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

/**
 * One OCR attempt end-to-end: the provider call (or the TEST_MODE stub),
 * the strict post-model validation, and — on EVERY path that reaches the
 * provider decision, failures included — the audit pairing (usage event +
 * outcome log), written exactly once (review T4-B2). Throws on failure AFTER
 * auditing; the route owns mapping the rethrown error to the HTTP response.
 *
 * The usage row is the call's own dimensions (#523 P4): capability 'vision',
 * the household that paid, the funding source, and the model actually sent —
 * read from the call result, or from `AiError.call`/`usage` when the provider
 * billed an attempt that produced no usable answer ("failure carries the
 * bill", plan §2.2). A `not_configured` failure has no call and writes nothing.
 */
export async function runExpiryOcr(
  env: Env['Bindings'],
  args: {
    access: AiAccessHandle
    imageBytes: ArrayBuffer
    contentType: string
    userId: string
    householdId: string
    documentId: string
    fileId: string
  }
): Promise<{ suggestion: string | null; outcome: ExpiryOcrOutcome; model: string | null }> {
  // The audit pairing exists ONCE (T4-B2): every path that reaches the
  // provider decision funnels through here — success, TEST_MODE, provider
  // failure, validation rejection (the provider billed those inputs even
  // when the answer was unusable).
  const finish = async (
    call: AiCall | null,
    usage: TokenUsage,
    outcome: ExpiryOcrOutcome
  ): Promise<void> => {
    if (call) {
      await recordAiUsageEvent(env, { userId: args.userId, call, usage })
    }
    logExpiryOcrOutcome({
      householdId: args.householdId,
      documentId: args.documentId,
      fileId: args.fileId,
      model: call?.model ?? null,
      outcome,
    })
  }

  let suggestion: string | null
  if (env.TEST_MODE === 'true') {
    suggestion = '2027-06-05'
    await finish(args.access.call, EMPTY_USAGE, expiryOcrOutcome(suggestion))
    return { suggestion, outcome: expiryOcrOutcome(suggestion), model: args.access.call.model }
  }

  // The attempt's bill, captured BEFORE validation: a rejected answer was still
  // a provider call, and the provider billed those inputs.
  let call: AiCall | null = null
  let usage: TokenUsage = EMPTY_USAGE
  try {
    const result = await vision({
      env,
      userId: args.userId,
      householdId: args.householdId,
      access: args.access,
      // One user turn: the feature's prompt text and the image it reads.
      parts: [
        { type: 'text', text: buildExpiryExtractionPrompt() },
        { type: 'image', bytes: args.imageBytes, mimeType: args.contentType },
      ],
    })
    call = result.call
    usage = result.usage
    // The post-model gate (issue #433): a real calendar date or null —
    // anything else is a rejection the user sees, never a silent guess.
    suggestion = normalizeExpirySuggestion(parseExpiryExtraction(result.text).expires_on)
  } catch (err) {
    const failure = err instanceof AiError ? err : null
    await finish(
      call ?? failure?.call ?? null,
      call ? usage : (failure?.usage ?? EMPTY_USAGE),
      err instanceof DocumentOcrError ? 'rejected' : 'failed'
    )
    throw err
  }

  const outcome = expiryOcrOutcome(suggestion)
  await finish(call, usage, outcome)
  return { suggestion, outcome, model: call?.model ?? null }
}
