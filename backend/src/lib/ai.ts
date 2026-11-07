// DEPRECATED — the legacy AI surface (ahaqqu/RumaQ#523 P2). DELETED IN P4.
//
// This file is a THIN SHIM: it keeps the pre-P2 exports (same signatures, same
// error messages) so not a single feature file changes while the door lands,
// and every call now goes through `lib/ai/adapters/*` inside the door. It owns
// no transport, no provider hostname and no key handling beyond forwarding the
// caller's own arguments:
//
//   - provider/message shaping, the wire dispatch and the error vocabulary live
//     in lib/ai/legacy.ts + lib/ai/adapters/*;
//   - prompts stay OUTSIDE the door on purpose (plan §2.5): they are product
//     policy, owner-reviewed, and the door takes messages, not prompts.
//
// The export list is FROZEN for P2 — P4 replaces each call site with
// `resolveAccess` + `completeText`/`vision`/`decide` from `./ai/index.js` and
// deletes this file. Do not add features here.

import { legacyCompleteText, type LegacyCompleteArgs } from './ai/legacy.js'
import { AiError, usageCollector, type ThinkingLevel, type TokenUsage } from './ai/index.js'
import { parseJsonResponse } from './ai/parse.js'
import type { AiMessage } from './ai/types.js'

export type ParsedItem = {
  name: string
  qty: number
  unit: string
  price: number
  total?: number
}

export type ScanResult = {
  store_name?: string
  date?: string
  items: ParsedItem[]
}

export type PlanItem = {
  name: string
  qty: number
  unit: string
  store_id: string | null
  price_estimate: number | null
  why: string
}

export type PlanResult = {
  items: PlanItem[]
}

export function buildScanPrompt(): string {
  return `You are a receipt OCR assistant. Extract line items from the receipt image.

Return ONLY valid JSON in this exact format:
{
  "store_name": "Name of store (if visible)",
  "date": "Purchase date in YYYY-MM-DD format (if visible)",
  "items": [
    { "name": "Item name", "qty": 1, "unit": "pcs", "price": 10000, "total": 10000 }
  ]
}

Rules:
- Extract every item line from the receipt.
- qty must be a number (default 1 if not specified).
- unit should be the unit of measurement (pcs, kg, L, pack, etc).
- price is the per-item unit price (the per-piece HARGA/price column), not the line total; only fall back to the line total when no unit price is shown.
- total is the printed line total for the item when the receipt shows one; omit it otherwise.
- Omit subtotals, taxes, and total lines.
- If you cannot read the receipt clearly, return { "items": [] }.
- Do NOT include any text outside the JSON.`
}

// The vault's expiry-date extraction prompt (issue #433). LOAD-BEARING and
// owner-reviewed like the pipeline prompts: the model's answer feeds the
// expiry editor, so the rules pin WHICH date counts (validity end — never an
// issuance, registration, purchase, or effective-from date) and how the many
// Indonesian/English document printings map to one ISO date. KTP has no
// expiry — returning null there is correct, not a failure.
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

export type AiCallOpts = {
  baseUrl?: string | null
  model?: string | null
  thinkingLevel?: ThinkingLevel | null
  onUsage?: (usage: TokenUsage) => void
  // Optional call deadline. The provider fetches take it as their
  // AbortSignal, so a caller with a bounded budget (the review evaluator's
  // synchronous fan-out) cancels a hung provider instead of awaiting it
  // forever. Undefined = the legacy behavior (no deadline).
  signal?: AbortSignal
}

export { usageCollector, parseJsonResponse }
export type { AiMessage, ThinkingLevel, TokenUsage }

function legacyArgs(
  provider: string,
  apiKey: string,
  messages: AiMessage[],
  opts: AiCallOpts | undefined
): LegacyCompleteArgs {
  return {
    provider,
    apiKey,
    messages,
    baseUrl: opts?.baseUrl,
    model: opts?.model,
    thinkingLevel: opts?.thinkingLevel,
    signal: opts?.signal,
  }
}

/** Did the provider report token counts (not merely "zero tokens")? */
function reportedUsage(usage: TokenUsage | undefined): TokenUsage | null {
  if (!usage) return null
  const any = usage.input_tokens !== 0 || usage.output_tokens !== 0 || usage.cached_tokens !== null
  return any ? usage : null
}

async function legacyCall(args: LegacyCompleteArgs, opts: AiCallOpts | undefined): Promise<string> {
  try {
    const result = await legacyCompleteText(args)
    // The pre-P2 callback contract: report usage only when the provider did.
    if (result.usage && opts?.onUsage) opts.onUsage(result.usage)
    return result.text
  } catch (err) {
    // FAILURE CARRIES THE BILL (plan §2.2): a provider that answered but whose
    // answer was unusable (empty content, off-schema JSON) already billed those
    // inputs. The pre-P2 dispatcher reported usage before rejecting the answer,
    // so forward it here before the rethrow and the caller's accumulator keeps
    // its failed-attempt tokens.
    if (err instanceof AiError && opts?.onUsage) {
      const usage = reportedUsage(err.usage)
      if (usage) opts.onUsage(usage)
    }
    throw err
  }
}

/** Legacy completion: system prompt + user prompt in, the model's text out. */
export async function completeText(
  provider: string,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  opts?: AiCallOpts
): Promise<string> {
  const messages: AiMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]
  return legacyCall(legacyArgs(provider, apiKey, messages, opts), opts)
}

async function completeVision(
  imageBuffer: ArrayBuffer,
  imageType: string,
  prompt: string,
  provider: string,
  apiKey: string,
  opts?: AiCallOpts
): Promise<string> {
  const messages: AiMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image', bytes: imageBuffer, mimeType: imageType },
      ],
    },
  ]
  return legacyCall(legacyArgs(provider, apiKey, messages, opts), opts)
}

export async function extractReceiptItems(
  imageBuffer: ArrayBuffer,
  imageType: string,
  provider: string,
  apiKey: string,
  opts?: AiCallOpts
): Promise<ScanResult> {
  const content = await completeVision(
    imageBuffer,
    imageType,
    buildScanPrompt(),
    provider,
    apiKey,
    opts
  )
  const result = parseJsonResponse<ScanResult>(content)

  const items: ParsedItem[] = ((result.items || []) as Record<string, unknown>[]).map((it) => ({
    name: String(it.name || ''),
    qty: Number(it.qty) || 1,
    unit: String(it.unit || 'pcs'),
    price: Math.round(Number(it.price) || 0),
    total: it.total ? Math.round(Number(it.total)) : undefined,
  }))

  return {
    store_name: result.store_name ? String(result.store_name) : undefined,
    date: result.date ? String(result.date) : undefined,
    items,
  }
}

// The raw model answer for the vault's expiry extraction (issue #433): the
// date field is validated by the caller (lib/document-ocr.ts) — this layer
// owns the provider call and the strict JSON parse only, mirroring
// extractReceiptItems.
export type RawExpiryExtraction = {
  expires_on?: string | null
}

export async function extractExpiryDate(
  imageBuffer: ArrayBuffer,
  imageType: string,
  provider: string,
  apiKey: string,
  opts?: AiCallOpts
): Promise<RawExpiryExtraction> {
  const content = await completeVision(
    imageBuffer,
    imageType,
    buildExpiryExtractionPrompt(),
    provider,
    apiKey,
    opts
  )
  return parseJsonResponse<RawExpiryExtraction>(content)
}
