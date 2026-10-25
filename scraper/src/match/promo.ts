// Port of haqita scripts/matching/promo_parser.py — Indonesian promo text
// parsing (effective unit price math), promo normalization/categorization,
// and OCR period parsing. Ported faithfully; the only deliberate change is
// in toIsoDate (RumaQ rejects impossible OCR dates like "45 Mei").
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
  /** Original promo text (all entries joined when a list was given). */
  display: string
  /** Effective units received. */
  unitCount: number
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
        display: promoText,
        unitCount: total,
        effectiveUnitPrice: Math.max(1, Math.floor(basePrice / total)),
      }
    }
    if (kind === 'bundle_buy') {
      const count = Number.parseInt(m[1]!, 10)
      return {
        promoType: 'bundle_buy',
        display: promoText,
        unitCount: count,
        effectiveUnitPrice: Math.max(1, Math.floor(basePrice / count)),
      }
    }
    if (kind === 'multi_price') {
      const count = Number.parseInt(m[1]!, 10)
      const price = parsePrice(m[2]!)
      return {
        promoType: 'multi_price',
        display: promoText,
        unitCount: count,
        effectiveUnitPrice: Math.max(1, Math.floor(price / count)),
      }
    }
    if (kind === 'discount_pct' || kind === 'discount_fixed') {
      // OCR already captured the post-discount price — no further math.
      return { promoType: kind, display: promoText, unitCount: 1, effectiveUnitPrice: basePrice }
    }
  }

  return { promoType: 'single', display: promoText, unitCount: 1, effectiveUnitPrice: basePrice }
}

const singleResult = (basePrice: number): PromoResult => ({
  promoType: 'single',
  display: '',
  unitCount: 1,
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

  return {
    promoType: best.promoType,
    display: promoList.join(', '),
    unitCount: best.unitCount,
    effectiveUnitPrice: best.effectiveUnitPrice,
  }
}

// ---------------------------------------------------------------------------
// Promo normalization and categorization
// ---------------------------------------------------------------------------

const TITLE_CASE: Record<string, string> = {
  diskon: 'Diskon',
  ekstra: 'Ekstra',
  stiker: 'Stiker',
  gratis: 'Gratis',
  hemat: 'Hemat',
  lebih: 'Lebih',
  seharga: 'Seharga',
  harga: 'Harga',
  spesial: 'Spesial',
  'spesial!': 'Spesial!',
  promo: 'Promo',
  super: 'Super',
  mulai: 'Mulai',
  beli: 'Beli',
  satuan: 'Satuan',
  anggota: 'Anggota',
  khusus: 'Khusus',
  member: 'Member',
  special: 'Special',
  price: 'Price',
  baru: 'Baru',
  pilihan: 'Pilihan',
  segar: 'Segar',
  minggu: 'Minggu',
  ini: 'Ini',
  fresh: 'Fresh',
  deals: 'Deals!',
  'deals!': 'Deals!',
  pwp: 'PWP',
  maks: 'Maks.',
  'maks.': 'Maks.',
  max: 'Maks.',
  extra: 'Ekstra',
  anti: 'Anti',
  bocor: 'Bocor',
  serap: 'Serap',
  semua: 'Semua',
  rasa: 'Rasa',
  karton: 'Karton',
  isi: 'Isi',
  tpk: 'Tpk',
  produk: 'Produk',
  alami: 'Alami',
  naturally: 'Naturally',
  apel: 'Apel',
  fuji: 'Fuji',
  deal: 'Deal',
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

/** Apply title casing to known promo words while preserving numbers/prices. */
export function titleCasePromo(text: string): string {
  return text
    .split(/\s+/)
    .map((w) => {
      if (/^[\d.,]+$/.test(w)) return w
      if (/^\d+%$/.test(w)) return w
      if (/^\d/.test(w)) return w
      const lower = w.toLowerCase()
      const mapped = TITLE_CASE[lower]
      if (mapped) return mapped
      if (w.length > 1 && w === w.toUpperCase()) return capitalize(w)
      return w
    })
    .join(' ')
}

/**
 * Normalize a promo string into clean, title-cased segment(s). Splits
 * composite promos like 'DISKON 20% EKSTRA STIKER' into separate entries.
 */
export function normalizePromoText(text: string | null | undefined): string[] {
  if (!text || !text.trim()) return []

  const trimmed = text.trim()

  // Split composite promos: "DISKON X% EKSTRA STIKER" → ["Diskon X%", "Ekstra Stiker"]
  const diskon = /(DISKON\s+\d+%)\s+(EKSTRA\s+STIKER)/i.exec(trimmed)
  if (diskon) return [titleCasePromo(diskon[1]!), titleCasePromo(diskon[2]!)]

  const spesial = /(HARGA\s+SPESIAL)\s+(EKSTRA\s+STIKER)/i.exec(trimmed)
  if (spesial) return [titleCasePromo(spesial[1]!), titleCasePromo(spesial[2]!)]

  return [titleCasePromo(trimmed)]
}

export type PromoCategory =
  | 'discount_pct'
  | 'discount_fixed'
  | 'bogo'
  | 'bundle'
  | 'member_price'
  | 'promo_price'
  | 'freebie'
  | 'quantity_limit'
  | 'special'

/** Categorize a single normalized promo string. */
export function categorizePromo(text: string): PromoCategory {
  const lower = text.toLowerCase().trim()

  if (/^diskon\s+\d+%/.test(lower)) return 'discount_pct'
  if (/^hemat\s+\d+%/.test(lower)) return 'discount_pct'

  if (/^\d+\s+gratis\s+\d+/.test(lower)) return 'bogo'
  if (/beli\s+\d+\s+gratis\s+\d+/.test(lower)) return 'bogo'
  if (/gratis\s+\d+\s*\(/.test(lower)) return 'bogo'
  if (lower === 'gratis') return 'bogo'

  if (lower.includes('khusus member')) return 'member_price'
  if (lower.includes('member special price')) return 'member_price'
  if (lower.includes('ekstra diskon member')) return 'member_price'
  if (lower === 'pwp' || lower.startsWith('pwp ')) return 'member_price'

  if (lower.startsWith('gratis jasa')) return 'freebie'
  if (lower.startsWith('gratis es')) return 'freebie'
  if (lower.startsWith('disertai pembelian')) return 'freebie'

  if (/^maks\.?\s+\d+\s+[a-z]/.test(lower)) return 'quantity_limit'
  if (text.trim().startsWith('MAX')) return 'quantity_limit'

  if (/^hemat\s+rp/.test(lower)) return 'discount_fixed'
  if (/^beli\s+\d+\s+rp/.test(lower)) return 'discount_fixed'
  if (/^\d+\s*&\s*\d+\s+\w+/.test(lower)) return 'discount_fixed'
  if (lower.startsWith('harga promo ')) return 'discount_fixed'

  if (lower.includes('harga spesial')) return 'promo_price'
  if (lower.includes('harga mulai')) return 'promo_price'
  if (lower.includes('super promo')) return 'promo_price'
  if (lower.includes('promo 1 hari')) return 'promo_price'
  if (lower.includes('super deal')) return 'promo_price'
  if (lower.includes('fresh deals')) return 'promo_price'
  if (lower.includes('pilihan segar')) return 'promo_price'

  if (/^\d+\s+lebih\s+hemat/.test(lower)) return 'bundle'
  if (/^\d+\s+seharga/.test(lower)) return 'bundle'
  if (/beli\s+\d+\s+harga\s+satuan/.test(lower)) return 'bundle'
  if (/beli\s+\d+\s+lebih\s*!?$/.test(lower)) return 'bundle'
  if (lower.includes('beli banyak lebih hemat')) return 'bundle'
  if (lower === 'lebih hemat' || lower === 'lebih hemat!') return 'bundle'
  if (/^ekstra stiker/.test(lower)) return 'bundle'
  if (/^extra stiker/.test(lower)) return 'bundle'
  if (/^extra \+?\d+\s+pcs/.test(lower)) return 'bundle'
  if (lower.includes('ekstra serap')) return 'bundle'
  if (/^ekstra \+?\d+\s+pcs/.test(lower)) return 'bundle'
  if (lower.includes('karton isi')) return 'bundle'
  if (lower === 'ekstra diskon') return 'promo_price'

  return 'special'
}

export interface StandardizedPromo {
  normalized: string[]
  types: PromoCategory[]
  bestType: PromoCategory
  discountPct: number | null
  maxQty: number | null
  displaySummary: string
}

/**
 * Standardize a list of promo strings into a structured summary. Returns
 * null for empty input.
 */
export function standardizePromoList(promos: string[] | null): StandardizedPromo | null {
  if (!promos || promos.length === 0) return null

  const promoList = promos.filter((p) => p && String(p).trim().length > 0)
  if (promoList.length === 0) return null

  const allNormalized: string[] = []
  const allTypes: PromoCategory[] = []
  let discountPct: number | null = null
  let maxQty: number | null = null

  for (const raw of promoList) {
    for (const seg of normalizePromoText(raw)) {
      allNormalized.push(seg)
      const cat = categorizePromo(seg)
      allTypes.push(cat)

      if (cat === 'discount_pct') {
        const m = /(\d+)%/.exec(seg)
        if (m) {
          const val = Number.parseInt(m[1]!, 10)
          if (discountPct === null || val > discountPct) discountPct = val
        }
      }

      if (cat === 'quantity_limit') {
        const m = /maks\.?\s*(\d+)/i.exec(seg)
        if (m) {
          const val = Number.parseInt(m[1]!, 10)
          if (maxQty === null || val > maxQty) maxQty = val
        }
      }
    }
  }

  if (allNormalized.length === 0) return null

  const typePriority: Record<PromoCategory, number> = {
    discount_pct: 0,
    member_price: 1,
    bogo: 2,
    promo_price: 3,
    discount_fixed: 4,
    bundle: 5,
    freebie: 6,
    quantity_limit: 7,
    special: 8,
  }
  const bestType = allTypes.reduce((a, b) => (typePriority[b] < typePriority[a] ? b : a))

  return {
    normalized: allNormalized,
    types: allTypes,
    bestType,
    discountPct,
    maxQty,
    displaySummary: allNormalized[0]!,
  }
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
