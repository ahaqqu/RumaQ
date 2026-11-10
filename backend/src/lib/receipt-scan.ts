// Receipt scan — the prompt and the strict answer parser for the receipt OCR
// call (the vault's lib/document-ocr.ts sibling). Both live OUTSIDE the AI door
// on purpose (plan §2.5): a prompt is product policy, owner-reviewed, and
// feature-level validation belongs to the feature. The transport that sends the
// image is the door's `vision()` on the household's `vision` capability — never
// the reasoning/text model (#523 P4: this module used to reach the text model
// through the legacy shim, which sent a receipt image to a text-only model).
//
// Moved out of lib/ai.ts when the P2 shim was deleted in P4. Nothing here knows
// a provider, an endpoint or a key.

import { parseJsonResponse } from './ai/index.js'

export type ParsedItem = {
  name: string
  qty: number
  unit: string
  price: number
  total?: number
  // #567-B1: set when qty is anything but exactly 1 AND the scan read no
  // printed line total — the line is exactly where the prompt's line-total
  // fallback (price := the line amount) would be multiplied by qty into the
  // persisted grand total. The review screen must hold submit until the user
  // confirms the unit price.
  needsPriceReview?: boolean
}

export type ScanResult = {
  store_name?: string
  date?: string
  items: ParsedItem[]
}

// #567-B1 (review addendum, deliberate change): since #518 the line's amount
// is PERSISTED and summed into the permanent grand total. The prompt's
// line-total fallback (price := the line amount when no unit price is shown)
// could therefore put a line amount into `price` with `total` omitted — and
// the server would multiply it by qty. Two halves: the model must now
// ACCOMPANY every fallback with the same amount as `total` (the
// printed-total-wins rule then carries the line), and parseScanResult flags
// lines whose qty is not exactly 1 and that carry no total, so the review
// screen holds submit until the user confirms the unit price — never silently
// multiplied.
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
- total is the printed line total for the item when the receipt shows one; when no unit price is shown and price is the line-total fallback, ALWAYS emit that same line amount as total too.
- Omit subtotals, taxes, and total lines.
- If you cannot read the receipt clearly, return { "items": [] }.
- Do NOT include any text outside the JSON.`
}

/**
 * The strict post-model gate (the lib/document-ocr.ts normalizeExpirySuggestion
 * pattern): the answer must be one JSON object with an `items` array. Item
 * fields are normalized to the editor's shape (a missing qty is 1, a missing
 * unit is 'pcs', prices are whole rupiah) — the receipt review screen lets the
 * user fix the rest, so a partially readable line is a suggestion, not a
 * failure. An answer that is not JSON at all is a rejection.
 */
export function parseScanResult(content: string): ScanResult {
  const result = parseJsonResponse<Partial<ScanResult>>(content)
  const rawItems = Array.isArray(result.items) ? result.items : []

  const items: ParsedItem[] = rawItems.map((it) => {
    const row = (it ?? {}) as Record<string, unknown>
    const qty = Number(row.qty) || 1
    // A printed line total is a POSITIVE whole-rupiah amount: 0, a negative or
    // an unreadable value is not a printed total, so it must not anchor the
    // line (a negative would also fail the POST's integer >= 0 validation).
    const rawTotal = Math.round(Number(row.total))
    const total = Number.isFinite(rawTotal) && rawTotal > 0 ? rawTotal : undefined
    return {
      name: String(row.name || ''),
      qty,
      unit: String(row.unit || 'pcs'),
      price: Math.round(Number(row.price) || 0),
      total,
      // #567-B1: a line whose qty is not exactly 1 and that has no printed
      // total is the one shape where the prompt's line-total fallback misread
      // compounds — qty × price would multiply a possibly-line-total price
      // into the persisted grand total (qty 10 inflates, qty 0.5 halves).
      // Flag it (only when true) so the review screen holds submit until the
      // user confirms the unit price; qty=1 cannot compound, and a printed
      // total already anchors the amount.
      ...(qty !== 1 && total == null ? { needsPriceReview: true } : {}),
    }
  })

  return {
    store_name: result.store_name ? String(result.store_name) : undefined,
    date: result.date ? String(result.date) : undefined,
    items,
  }
}
