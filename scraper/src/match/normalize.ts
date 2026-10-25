// Port of haqita scripts/matching/normalizer.py — name, unit, and brand
// normalization for product matching. All functions are pure; hot ones are
// memoized where beneficial. Ported faithfully (including the UNIT_TYPE_MAP
// suffix-scan order) so diff-tests against the Python original hold.

// ---------------------------------------------------------------------------
// Brand normalization
// ---------------------------------------------------------------------------

export const BRAND_ALIASES: Record<string, string> = {
  lndomie: 'indomie',
  lndomi: 'indomie',
  s0sro: 'sosro',
  s0s0: 'sosro',
  'ult rajaya': 'ultrajaya',
  'ultra jaya': 'ultrajaya',
  ultrqjaya: 'ultrajaya',
}

/** Lowercase, space-stripped brand; known OCR-typos map to canonical names. */
export function normalizeBrand(brand: string | null | undefined): string {
  if (!brand) return ''
  return BRAND_ALIASES[brand.toLowerCase().trim()] ?? brand.toLowerCase().trim()
}

// ---------------------------------------------------------------------------
// Unit type detection
// ---------------------------------------------------------------------------

export type UnitType = 'weight' | 'volume' | 'count'

// A Map (not a plain object) so the suffix scan in unitType() iterates in
// insertion order exactly like Python's dict — 'bag' must hit 'bag' only
// after 'g' has had its chance, matching the original's (subtle) behavior.
export const UNIT_TYPE_MAP = new Map<string, UnitType>([
  ['g', 'weight'],
  ['gram', 'weight'],
  ['gr', 'weight'],
  ['kg', 'weight'],
  ['ml', 'volume'],
  ['l', 'volume'],
  ['liter', 'volume'],
  ['lt', 'volume'],
  ['pcs', 'count'],
  ['pack', 'count'],
  ['sachet', 'count'],
  ['bks', 'count'],
  ['bungkus', 'count'],
  ['botol', 'count'],
  ['kaleng', 'count'],
  ['pck', 'count'],
  ['pch', 'count'],
  ['tub', 'count'],
  ['box', 'count'],
  ['bag', 'count'],
  ['set', 'count'],
  ['s', 'count'],
])

export function unitType(unit: string | null | undefined): UnitType | null {
  if (!unit) return null
  const u = unit
    .toLowerCase()
    .trim()
    .replace(/[.,]+$/, '')
  const exact = UNIT_TYPE_MAP.get(u)
  if (exact) return exact
  for (const [suffix, type] of UNIT_TYPE_MAP) {
    if (u.endsWith(suffix)) return type
  }
  return null
}

/** True if types match OR either unit is unknown (lenient for OCR noise). */
export function unitsTypeCompatible(
  u1: string | null | undefined,
  u2: string | null | undefined
): boolean {
  const t1 = unitType(u1)
  const t2 = unitType(u2)
  if (t1 === null || t2 === null) return true
  return t1 === t2
}

// ---------------------------------------------------------------------------
// Unit value normalization
// ---------------------------------------------------------------------------

// Matches: "85 g", "1.5 L", "2 x 800 ml", "6 x 45 ml", "1100's"
const UNIT_VALUE_RE = /(\d+(?:[.,]\d+)?)\s*(?:[×xX]\s*(\d+(?:[.,]\d+)?))?\s*([a-z]+(?:'[a-z]*)?)/i

/** Parsed unit: normalized value in base units (g / ml / pieces) + its type. */
export interface ParsedUnit {
  value: number
  type: UnitType
}

export function parseUnitToBase(unit: string | null | undefined): ParsedUnit | null {
  if (!unit) return null

  const m = UNIT_VALUE_RE.exec(unit)
  if (!m) return null

  const qty = Number.parseFloat(m[1]!.replace(',', '.'))
  const multiplier = m[2] ? Number.parseFloat(m[2].replace(',', '.')) : 1.0
  const rawUnit = m[3]!.toLowerCase()

  const type = unitType(rawUnit)
  if (type === null) return null

  let total = qty * multiplier

  // Convert to base: kg→g, L→ml
  if (type === 'weight' && rawUnit === 'kg') total *= 1000
  else if (type === 'volume' && ['l', 'lt', 'liter'].includes(rawUnit)) total *= 1000

  return { value: total, type }
}

/** True if unit values are within tolerance (default ±15% for OCR noise). */
export function unitsValueCompatible(
  u1: string | null | undefined,
  u2: string | null | undefined,
  tolerance = 0.15
): boolean {
  const p1 = parseUnitToBase(u1)
  const p2 = parseUnitToBase(u2)
  if (p1 === null || p2 === null) return true
  if (p1.type !== p2.type) return false
  if (p1.value === 0 || p2.value === 0) return true
  const ratio = Math.min(p1.value, p2.value) / Math.max(p1.value, p2.value)
  return ratio >= 1.0 - tolerance
}

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

// Strips unit-like tokens from product names so they don't interfere with
// matching. \p{L}\p{N} mirrors Python's unicode-aware \w for Indonesian names.
const UNIT_TOKEN_RE =
  /\b\d+(?:[.,]\d+)?\s*(?:[×xX]\s*\d+(?:[.,]\d+)?\s*)?(?:kg|g|gram|ml|l|liter|lt|pcs|pack|sachet|bks|bungkus|botol|kaleng|pck|pch|tub|box|bag|set|s)\b/gi

const normalizeNameCache = new Map<string, string>()

export function normalizeName(name: string): string {
  const cached = normalizeNameCache.get(name)
  if (cached !== undefined) return cached
  let n = name.toLowerCase()
  n = n.replace(UNIT_TOKEN_RE, '')
  n = n.replace(/[^\p{L}\p{N}_\s]/gu, ' ')
  n = n.replace(/\s+/g, ' ').trim()
  if (normalizeNameCache.size >= 2048) normalizeNameCache.clear()
  normalizeNameCache.set(name, n)
  return n
}

/** Order-independent token set for exact matching. */
export function canonicalTokens(name: string): Set<string> {
  return new Set(
    normalizeName(name)
      .split(' ')
      .filter((t) => t.length > 0)
  )
}

/** Jaccard similarity on token sets. Returns 0.0–1.0. */
export function tokenOverlap(nameA: string, nameB: string): number {
  const a = canonicalTokens(nameA)
  const b = canonicalTokens(nameB)
  if (a.size === 0 && b.size === 0) return 1.0
  if (a.size === 0 || b.size === 0) return 0.0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection++
  return intersection / (a.size + b.size - intersection)
}
