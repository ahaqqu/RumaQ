// Vault expiry OCR (ahaqqu/RumaQ#433): the post-model validation and policy
// layer for reading a document image's expiry date with the user's OWN AI
// provider (resolved through lib/ai-access.ts — never the pipeline, never a
// hardcoded provider). Split from the route so the rules are unit-testable
// without HTTP, per the vault's page/lib split (lib/document-expiry.ts owns
// the calendar rules, this owns the OCR round-trip rules; lib/ai.ts owns the
// provider call itself). runExpiryOcr additionally OWNS the attempt's audit
// pairing — the ai_usage_events row + the outcome log line, written once, on
// every path that reaches the provider decision (review T4-B2: the invariant
// lives here, not as two parallel copies in the route).
//
// The model NEVER writes: this module only produces a suggestion the expiry
// editor prefills, and the user confirms through the existing #426 PATCH
// (which keeps writing its own 'update' audit row).

import type { Env } from '../types.js'
import { extractExpiryDate, usageCollector, type TokenUsage } from './ai.js'
import { recordAiUsageEvent, type AiAccess } from './ai-access.js'
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
 */
export async function runExpiryOcr(
  env: Env['Bindings'],
  args: {
    access: AiAccess
    imageBytes: ArrayBuffer
    contentType: string
    userId: string
    householdId: string
    documentId: string
    fileId: string
  }
): Promise<{ suggestion: string | null; outcome: ExpiryOcrOutcome }> {
  // The model asked for IS the usage event's model — the receipt/chat paths
  // record access.model, vision work records access.visionModel (null = the
  // provider default applied).
  const usageEvent = {
    userId: args.userId,
    provider: args.access.provider,
    model: args.access.visionModel,
    keySource: args.access.keySource,
  }
  const tokenUsage: TokenUsage = { input_tokens: 0, output_tokens: 0, cached_tokens: null }

  // The audit pairing exists ONCE (T4-B2): every path that reaches the
  // provider decision funnels through here — success, TEST_MODE, provider
  // failure, validation rejection (the provider billed those inputs even
  // when the answer was unusable).
  const finish = async (outcome: ExpiryOcrOutcome): Promise<void> => {
    await recordAiUsageEvent(env, {
      ...usageEvent,
      inputTokens: tokenUsage.input_tokens,
      outputTokens: tokenUsage.output_tokens,
      cachedTokens: tokenUsage.cached_tokens,
    })
    logExpiryOcrOutcome({
      householdId: args.householdId,
      documentId: args.documentId,
      fileId: args.fileId,
      model: args.access.visionModel,
      outcome,
    })
  }

  let suggestion: string | null
  if (env.TEST_MODE === 'true') {
    suggestion = '2027-06-05'
  } else {
    try {
      const raw = await extractExpiryDate(
        args.imageBytes,
        args.contentType,
        args.access.provider,
        args.access.apiKey,
        {
          baseUrl: args.access.baseUrl,
          model: args.access.visionModel,
          // No thinkingLevel: extraction wants a cheap, deterministic read,
          // and reasoning_effort on a vision-only model is a provider 400.
          onUsage: usageCollector(tokenUsage),
        }
      )
      // The post-model gate (issue #433): a real calendar date or null —
      // anything else is a rejection the user sees, never a silent guess.
      suggestion = normalizeExpirySuggestion(raw.expires_on)
    } catch (err) {
      await finish(err instanceof DocumentOcrError ? 'rejected' : 'failed')
      throw err
    }
  }

  const outcome = expiryOcrOutcome(suggestion)
  await finish(outcome)
  return { suggestion, outcome }
}
