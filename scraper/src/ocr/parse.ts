// Pure OCR-output processing — port of haqita scripts/ocr/ocr_processor.py.
// No SDK imports here so parsing/validation is testable without Gemini.

export interface RawOcrItem {
  name?: string | null
  brand?: string | null
  unit?: string | null
  price?: number | string | null
  /**
   * Issue #367: the strikethrough/original price the model emits when the
   * source shows one. Model-controlled output (unlike priceFromDom below) —
   * it flows through parseOcrJson untouched and sanitize in validateProduct.
   */
  originalPrice?: number | string | null
  /**
   * Set by the catalog stores (issue #363): the price comes from the site's
   * rendered card text, not OCR, so the OCR digit-misread bounds (MAX_PRICE)
   * do not apply — a genuine premium SKU above 1M IDR validates.
   */
  priceFromDom?: boolean
  promo?: unknown
  period?: string | null
}

export interface OcrItem {
  name: string
  brand: string | null
  unit: string | null
  price: number
  originalPrice: number | null
  promo: string[] | null
  period: string | null
  ocrRawPrice: string
}

/** Strip markdown fences and extract the JSON array from a model response. */
export function parseOcrJson(rawText: string): RawOcrItem[] {
  const clean = rawText
    .trim()
    .replace(/^```[a-z]*\s*/gm, '')
    .replace(/\s*```$/gm, '')
  const match = /\[[\s\S]*\]/.exec(clean)
  if (!match) {
    throw new Error(`No JSON array found in OCR response: ${clean.slice(0, 200)}`)
  }
  const items = JSON.parse(match[0]) as RawOcrItem[]
  // Review A1 (PR #366): priceFromDom is set by the catalog adaptation only
  // (pipeline.ts catalogItemToRaw). The OCR path parses MODEL output here, so
  // a hallucinated flag must not survive — it would let the OCR path waive
  // its own MAX_PRICE misread guard. originalPrice (issue #367) is
  // model-controlled too but must FLOW THROUGH — it is the measured field,
  // sanitized downstream in validateProduct.
  for (const item of items) delete item.priceFromDom
  return items
}

const MIN_PRICE = 100
const MAX_PRICE = 1_000_000

/**
 * Normalize a price string to integer IDR (haqita clean_price) with NO range
 * bounds — pure parsing, shared by the OCR path and the DOM-priced catalog
 * path (issue #363). Bounds are applied by the callers that own them.
 */
export function parseIdrValue(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  let s = String(raw)
    .replace(/[Rr][Pp]\.?\s*/g, '')
    .trim()
  s = s.replace(/(\d)\.(\d{3})(?!\d)/g, '$1$2')
  s = s.replace(/,/g, '').replace(/ /g, '').replace(/\./g, '')
  const value = Number.parseFloat(s)
  if (!Number.isFinite(value)) return null
  return Math.trunc(value)
}

// Common OCR corruptions of unit strings (haqita _UNIT_CORRECTIONS). The
// standalone-l rule is refined vs haqita: "l g" (misread 1) becomes "1 g",
// but a genuine liter after a number — "1 L" — is left alone, per the
// ingest contract example in docs/plan/haqita-integration.md §5.2.
const UNIT_CORRECTIONS: [RegExp, string][] = [
  [/\bSg\b/gi, '5g'],
  [/\bBg\b/gi, '8g'],
  [/\bIOO\b/gi, '100'],
  [/\bI00\b/gi, '100'],
  [/\bS00\b/gi, '500'],
  [/\bSOO\b/gi, '500'],
  [/(?<!\d\s?)\bl\b/gi, '1'],
]

export function cleanUnit(raw: string | null | undefined): string | null {
  if (!raw) return null
  let s = raw.trim()
  for (const [pattern, replacement] of UNIT_CORRECTIONS) {
    s = s.replace(pattern, replacement)
  }
  return s.length > 0 ? s : null
}

/** Normalize the model's promo field to a list of strings or null. */
export function normalizePromo(promo: unknown): string[] | null {
  if (!promo) return null
  if (Array.isArray(promo)) {
    const result = promo
      .filter((p) => p !== null && p !== undefined)
      .map((p) => String(p).trim())
      .filter((p) => p.length > 0)
    return result.length > 0 ? result : null
  }
  const single = String(promo).trim()
  return single.length > 0 ? [single] : null
}

export type ValidatedProduct = OcrItem & { imageSource: string }

/**
 * Validate one raw OCR item. Returns [null, reason] when the item must be
 * rejected (short name, missing price, unusable price).
 */
export function validateProduct(
  raw: RawOcrItem,
  imageSource: string
): [ValidatedProduct, null] | [null, string] {
  const name = String(raw.name ?? '').trim()
  if (name.length < 3) return [null, 'name_too_short']

  // Issue #365: an absent price (null/undefined/blank — the no-price lineup
  // entries some sources carry) is expected and benign, not a misread, so it
  // classifies as price_missing and leaves price_invalid for actual bad
  // values. The item is still dropped: a product without a price cannot
  // publish.
  if (raw.price === null || raw.price === undefined || String(raw.price).trim() === '') {
    return [null, 'price_missing']
  }

  const value = parseIdrValue(raw.price)
  // Issue #363: the bounds are an OCR digit-misread guard. The sub-MIN floor
  // applies to every path; the 1M ceiling only guards the OCR path — a
  // DOM-priced catalog item (priceFromDom) has no misread failure mode, so a
  // genuine premium SKU above 1M IDR validates.
  if (value === null || value < MIN_PRICE) {
    return [null, `price_invalid: ${String(raw.price)}`]
  }
  if (value > MAX_PRICE && !raw.priceFromDom) {
    return [null, `price_invalid: ${String(raw.price)}`]
  }
  const price = value

  // Issue #367: sanitize the strikethrough/original price — pure parse, NO
  // bounds (the misread guards above exist to protect the paid price that
  // publishes; a junk originalPrice must never reject an otherwise valid
  // item), garbage/unparseable/negative → null. Rides the product onto the
  // payload as measurement data only (the shadow diff's validation vehicle).
  const originalValue = parseIdrValue(raw.originalPrice ?? null)
  const originalPrice = originalValue !== null && originalValue >= 0 ? originalValue : null

  const brand = raw.brand ? String(raw.brand).trim() : null
  return [
    {
      name,
      brand: brand && brand.length > 0 ? brand : null,
      unit: cleanUnit(raw.unit),
      price,
      originalPrice,
      promo: normalizePromo(raw.promo),
      period: raw.period ? String(raw.period).trim() : null,
      ocrRawPrice: String(raw.price ?? ''),
      imageSource,
    },
    null,
  ]
}
