// Port of haqita scripts/matching/promo_parser.py — Indonesian promo text
// parsing (effective unit price math) and OCR period parsing. Ported
// faithfully; the only deliberate change is in toIsoDate (RumaQ rejects
// impossible OCR dates like "45 Mei").
//
// Trimmed vs haqita: the display-layer helpers (title-casing,
// normalization, categorization — promo_parser's `__main__` block) are NOT
// ported; nothing in src/ consumed them. They return with their future
// consumer (the /prices UI) and remain readable in haqita history.
//
// Effective unit price math:
// - bundle_buy / get_free / multi_price: division (per-piece price from total bundle)
// - discount_pct / discount_fixed: NO math. The OCR captures the post-discount
//   price in the `price` field per the OCR prompt rules, so applying the
//   discount again would double-discount and produce a too-low value.

export type PromoKind =
  | 'bundle_buy'
  | 'get_free'
  | 'discount_pct'
  | 'discount_fixed'
  | 'multi_price'
  | 'single'

export interface PromoResult {
  promoType: PromoKind
  effectiveUnitPrice: number
}

// Ordered patterns — first match wins.
const PATTERNS: [RegExp, PromoKind][] = [
  // "Beli 2 Gratis 1" / "Beli 3 Gratis 1" / "Buy 1 Get 1"
  [/(?:beli|buy)\s+(\d+)\s*(?:gratis|free|get)\s+(\d+)/i, 'get_free'],
  // "DAPAT 5 pcs" / "dapat 3 buah" / "2 Pack"
  [/(?:dapat|get)\s+(\d+)\s*(?:pcs|buah|pack)?/i, 'bundle_buy'],
  // "2/Rp 10.000" or "3 pcs / Rp15.000"
  [/(\d+)\s*(?:pcs|buah)?\s*\/\s*(?:Rp\.?\s*)?([\d.,]+)/i, 'multi_price'],
  // "Diskon 20%"
  [/diskon\s+(\d+)\s*%/i, 'discount_pct'],
  // "Hemat Rp 5.000"
  [/hemat\s+(?:Rp\.?\s*)?([\d.,]+)/i, 'discount_fixed'],
]

/** Convert '15.000' or '15,000' to 15000. */
function parsePrice(raw: string): number {
  return Number.parseInt(raw.replace(/\./g, '').replace(/,/g, ''), 10)
}

function parseSinglePromo(promoText: string, basePrice: number): PromoResult {
  for (const [pattern, kind] of PATTERNS) {
    const m = pattern.exec(promoText)
    if (!m) continue
    if (kind === 'get_free') {
      const total = Number.parseInt(m[1]!, 10) + Number.parseInt(m[2]!, 10)
      return {
        promoType: 'get_free',
        effectiveUnitPrice: Math.max(1, Math.floor(basePrice / total)),
      }
    }
    if (kind === 'bundle_buy') {
      const count = Number.parseInt(m[1]!, 10)
      return {
        promoType: 'bundle_buy',
        effectiveUnitPrice: Math.max(1, Math.floor(basePrice / count)),
      }
    }
    if (kind === 'multi_price') {
      const count = Number.parseInt(m[1]!, 10)
      const price = parsePrice(m[2]!)
      return {
        promoType: 'multi_price',
        effectiveUnitPrice: Math.max(1, Math.floor(price / count)),
      }
    }
    if (kind === 'discount_pct' || kind === 'discount_fixed') {
      // OCR already captured the post-discount price — no further math.
      return { promoType: kind, effectiveUnitPrice: basePrice }
    }
  }

  return { promoType: 'single', effectiveUnitPrice: basePrice }
}

const singleResult = (basePrice: number): PromoResult => ({
  promoType: 'single',
  effectiveUnitPrice: basePrice,
})

/**
 * Parse promo text against the base (OCR) price. Accepts a single string, a
 * list of strings, or null. When given a list, each entry is parsed
 * independently and the result with the lowest effective unit price (best
 * deal for the customer) wins.
 */
export function parsePromo(
  promoText: string | string[] | null | undefined,
  basePrice: number
): PromoResult {
  if (!promoText) return singleResult(basePrice)

  const promoList = (
    typeof promoText === 'string' ? [promoText] : promoText.filter((p) => p && p.trim().length > 0)
  ).map((p) => String(p))

  if (promoList.length === 0) return singleResult(basePrice)

  const results = promoList.map((p) => parseSinglePromo(p, basePrice))

  const matched = results.filter((r) => r.promoType !== 'single')
  const best =
    matched.length > 0
      ? matched.reduce((a, b) => (b.effectiveUnitPrice < a.effectiveUnitPrice ? b : a))
      : results[0]!

  return { promoType: best.promoType, effectiveUnitPrice: best.effectiveUnitPrice }
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  mei: '05',
  jun: '06',
  jul: '07',
  agu: '08',
  sep: '09',
  okt: '10',
  nov: '11',
  des: '12',
  may: '05',
  aug: '08',
  oct: '10',
  dec: '12',
}

function toIsoDate(day: number, monthStr: string, year: string): string | null {
  const month = MONTHS[monthStr.toLowerCase().slice(0, 3)]
  if (!month) return null
  // OCR digits can be impossible ("45 Mei", "30 Feb"): round-trip through
  // Date UTC so only dates that actually exist are emitted.
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, day))
  const exists =
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === day
  return exists ? `${year}-${month}-${String(day).padStart(2, '0')}` : null
}

/**
 * Parse an OCR'd period string into (validFrom, validUntil) ISO dates.
 * Port of haqita promo_parser.parse_period (canonical home; the pipeline
 * re-exports this).
 */
export function parsePeriod(period: string | null | undefined): [string | null, string | null] {
  if (!period) return [null, null]

  // Range: "7 - 20 Mei 2026", "14-17 Mei 2026", "Berlaku 1-15 Mei 2026"
  const range = /(\d{1,2})\s*[-–—]\s*(\d{1,2})\s+(\w+)\s+(\d{4})/.exec(period)
  if (range) {
    return [
      toIsoDate(Number(range[1]), range[3]!, range[4]!),
      toIsoDate(Number(range[2]), range[3]!, range[4]!),
    ]
  }

  // Single end date: "s/d 20 Mei 2026", "sd. 20 Mei 2026", "sampai/until ..."
  const until = /(?:s[/.]?d|sampai|until)\s+(\d{1,2})\s+(\w+)\s+(\d{4})/i.exec(period)
  if (until) {
    return [null, toIsoDate(Number(until[1]), until[2]!, until[3]!)]
  }

  // Bare single date: "20 Mei 2026"
  const single = /(\d{1,2})\s+(\w+)\s+(\d{4})/.exec(period)
  if (single) {
    return [null, toIsoDate(Number(single[1]), single[2]!, single[3]!)]
  }

  return [null, null]
}
