// Pure OCR-output processing — port of haqita scripts/ocr/ocr_processor.py.
// No SDK imports here so parsing/validation is testable without Gemini.

export interface RawOcrItem {
  name?: string | null
  brand?: string | null
  unit?: string | null
  price?: number | string | null
  promo?: unknown
  period?: string | null
}

export interface OcrItem {
  name: string
  brand: string | null
  unit: string | null
  price: number
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
  return JSON.parse(match[0]) as RawOcrItem[]
}

const MIN_PRICE = 100
const MAX_PRICE = 1_000_000

/** Normalize an OCR'd price string to integer IDR (haqita clean_price). */
export function cleanPrice(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  let s = String(raw)
    .replace(/[Rr][Pp]\.?\s*/g, '')
    .trim()
  s = s.replace(/(\d)\.(\d{3})(?!\d)/g, '$1$2')
  s = s.replace(/,/g, '').replace(/ /g, '').replace(/\./g, '')
  const value = Number.parseFloat(s)
  if (!Number.isFinite(value)) return null
  const int = Math.trunc(value)
  return int >= MIN_PRICE && int <= MAX_PRICE ? int : null
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
 * rejected (short name, unusable price).
 */
export function validateProduct(
  raw: RawOcrItem,
  imageSource: string
): [ValidatedProduct, null] | [null, string] {
  const name = String(raw.name ?? '').trim()
  if (name.length < 3) return [null, 'name_too_short']

  const price = cleanPrice(raw.price)
  if (price === null) return [null, `price_invalid: ${String(raw.price)}`]

  const brand = raw.brand ? String(raw.brand).trim() : null
  return [
    {
      name,
      brand: brand && brand.length > 0 ? brand : null,
      unit: cleanUnit(raw.unit),
      price,
      promo: normalizePromo(raw.promo),
      period: raw.period ? String(raw.period).trim() : null,
      ocrRawPrice: String(raw.price ?? ''),
      imageSource,
    },
    null,
  ]
}
