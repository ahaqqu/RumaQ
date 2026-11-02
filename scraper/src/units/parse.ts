// Canonical unit normalization (issue #368 phase A): parse a product's unit
// field — falling back to tokens in its name — into a canonical
// { qty, unit } so cross-store comparison can divide the listed price into a
// per-kg / per-liter / per-piece unitPrice. The owner example is the spec:
// "beras ramos 1kg 100000 and beras pandan wangi 5kg 550000" must both
// compare as "beras per kg" (100000 vs 110000).
//
// Pure and total: garbage in → null out. This module never throws and never
// blocks validation — null simply means "not normalized"; name and price are
// never altered. All regexes are module-level constants (no input is ever
// interpolated into a pattern), so behavior is total on any input.
//
// Best-effort by design: the leftmost quantity in the string wins ("330ML,
// KARTON ISI : 24 BTL" is 330 ml, not 24 pieces), and compound forms outside
// the grammar ("N+M unit" packs) resolve to their first unit-bearing token.

export type CanonicalUnit = 'g' | 'ml' | 'pcs'

export interface ParsedUnit {
  /** Quantity in the canonical base unit: grams, milliliters, or pieces. */
  qty: number
  unit: CanonicalUnit
}

// Number literal: integers and one decimal separator (dot or comma — the
// live catalog uses both, e.g. "1.45 kg" and "1,5L"). No thousands grouping
// exists in the data, and a leading-zero integer ("0562 PCS") is a model
// number, not a quantity — rejected by leadingZero check below.
const NUM = String.raw`\d+(?:[.,]\d+)?`

// Unit tokens and their scale to the canonical base (kg/klg→g ×1000,
// l/ltr/liter→ml ×1000). Alternation order matters: longer tokens first so
// "grms" never degrades to "gr", "liter" never to "l".
const UNIT_TABLE: Record<string, { unit: CanonicalUnit; scale: number }> = {
  kg: { unit: 'g', scale: 1000 },
  klg: { unit: 'g', scale: 1000 },
  grms: { unit: 'g', scale: 1 },
  gram: { unit: 'g', scale: 1 },
  gr: { unit: 'g', scale: 1 },
  g: { unit: 'g', scale: 1 },
  ml: { unit: 'ml', scale: 1 },
  ltr: { unit: 'ml', scale: 1000 },
  liter: { unit: 'ml', scale: 1000 },
  l: { unit: 'ml', scale: 1000 },
  pcs: { unit: 'pcs', scale: 1 },
  pc: { unit: 'pcs', scale: 1 },
  buah: { unit: 'pcs', scale: 1 },
  btg: { unit: 'pcs', scale: 1 },
  batang: { unit: 'pcs', scale: 1 },
}

const UNIT_ALT = Object.keys(UNIT_TABLE).join('|')

// Multiplier and plain quantity patterns. The leftmost match in the text
// wins regardless of which pattern found it — position, not pattern
// priority, decides (the priority only breaks exact-position ties).
const NX_M_RE = new RegExp(`(${NUM})\\s*[x×]\\s*(${NUM})\\s*(${UNIT_ALT})\\b`, 'gi')
const ISI_RE = new RegExp(`\\bisi\\b[\\s:.]*(${NUM})(?:\\s*(${UNIT_ALT}))?\\b`, 'gi')
const PACK_RE = /\bpack\b[\s:]*(\d+(?:[.,]\d+)?)/gi
const PLAIN_RE = new RegExp(`(${NUM})\\s*(${UNIT_ALT})\\b`, 'gi')
// Bare token → qty 1. Unit fields are curated ("pcs" means one piece), but
// in product names only the count family is safe: a bare "BUAH"/"PCS" is a
// real count marker there, while a bare mass/volume abbreviation is an OCR
// misread hazard ("l" alone is a misread "1" — cf. UNIT_CORRECTIONS).
const BARE_RE = new RegExp(`\\b(${UNIT_ALT})\\b`, 'gi')
const COUNT_FAMILY = new Set(['pcs', 'pc', 'buah', 'btg', 'batang'])

// Packaging tokens stripped before the name fallback (500+ occurrences in
// the live catalog: "… PCK 150GR" → "150GR"). They are not unit tokens, so
// the scanner would skip them anyway — stripping is for the one overlap:
// bare "klg" is a kilogram token in a unit field but a packaging marker in
// names ("APPETON … KLG 900GR" is 900 g, not 1 kg). Only a klg NOT preceded
// by a number is stripped, so "5 KLG" keeps meaning 5 kg.
const PACKAGING_RE = /\b(?:pck|pch|btl|tpk)\b/gi
const BARE_KLG_RE = /(?<![\d.,]\s*)\bklg\b/gi

function tokenToParsed(token: string, qty: number): ParsedUnit | null {
  const entry = UNIT_TABLE[token.toLowerCase()]
  if (!entry) return null
  const scaled = qty * entry.scale
  if (!Number.isFinite(scaled) || scaled <= 0) return null
  return { qty: scaled, unit: entry.unit }
}

// A number literal is a real quantity when it is finite, positive, not a
// leading-zero model number ("0562"), and not a minus-glued negative
// ("-5 kg"). A minus that itself follows a digit is a range separator
// ("900-1000gram" contributes its upper bound), not a sign. Outcomes:
// 'absent' — the number was never a quantity (a model number); later
// matches and bare tokens stay eligible. 'blocked' — a real number that
// cannot carry a quantity (zero, negative); it suppresses the bare-token
// rescue at and after its position, so an explicit "0 g" is null, not 1 g.
type QtyOutcome = { kind: 'absent' } | { kind: 'blocked' } | { kind: 'ok'; qty: number }

function usableQty(raw: string, text: string, index: number): QtyOutcome {
  if (/^0\d/.test(raw)) return { kind: 'absent' }
  if (text[index - 1] === '-' && !/\d/.test(text[index - 2] ?? '')) return { kind: 'blocked' }
  const qty = Number.parseFloat(raw.replace(',', '.'))
  if (!Number.isFinite(qty) || qty <= 0) return { kind: 'blocked' }
  return { kind: 'ok', qty }
}

type MatchOutcome =
  | { status: 'absent' }
  | { status: 'blocked' }
  | { status: 'ok'; parsed: ParsedUnit }

// Scan window bound: the number+unit patterns backtrack digit runs, so a
// pathological all-digits string degrades quadratically (thermos A1, PR
// #372). 1024 is ~7.7x the longest name in the live catalog (132 chars);
// quantities beyond the window are ignored — already best-effort by design.
const MAX_SCAN = 1024

// Scan one string for the first (leftmost) quantity it carries. bareMode:
// 'all' allows a bare unit token to mean qty 1 (curated unit fields),
// 'count' only the count family (product names).
function scan(text: string, bareMode: 'all' | 'count'): ParsedUnit | null {
  if (text.length > MAX_SCAN) text = text.slice(0, MAX_SCAN)
  const valid: Array<{ index: number; priority: number; parsed: ParsedUnit }> = []
  let blockedIndex = Number.POSITIVE_INFINITY

  const consider = (re: RegExp, priority: number, build: (m: RegExpExecArray) => MatchOutcome) => {
    // Iterate past 'absent' matches (a model number is not a quantity) and
    // past 'blocked' ones ("0 g, 500 ml" keeps its later quantity) while
    // remembering blocked positions for the bare-token rule below.
    for (const m of text.matchAll(re)) {
      const outcome = build(m)
      if (outcome.status === 'ok') {
        valid.push({ index: m.index, priority, parsed: outcome.parsed })
        return
      }
      if (outcome.status === 'blocked') blockedIndex = Math.min(blockedIndex, m.index)
    }
  }

  // "6 x 38 g" / "2X500G" / "24 x 330 ml" → (6·38) g. The unit is required:
  // dimension ranges ("100X120CM") and sheet counts ("2X200'S") must not
  // become phantom piece counts.
  consider(NX_M_RE, 0, (m) => {
    const a = usableQty(m[1]!, text, m.index)
    // The second operand's real offset: the first digit run after the
    // separator (searching from past m[1] cannot land inside it). The
    // pattern already guarantees a separator there, so its minus check is
    // structurally inert — the honest anchor keeps usableQty's contract
    // uniform (thermos B1, PR #372).
    const bStart = m.index + m[0].indexOf(m[2]!, m[1]!.length)
    const b = usableQty(m[2]!, text, bStart)
    if (a.kind === 'blocked' || b.kind === 'blocked') return { status: 'blocked' }
    if (a.kind === 'absent' || b.kind === 'absent') return { status: 'absent' }
    const parsed = tokenToParsed(m[3]!, a.qty * b.qty)
    return parsed ? { status: 'ok', parsed } : { status: 'absent' }
  })
  // "isi 3" → 3 pcs; "isi 400gr" → 400 g; "KARTON ISI : 40 TPK" → 40 pcs
  // once the packaging token is stripped (or the earlier quantity wins).
  consider(ISI_RE, 1, (m) => {
    const qty = usableQty(m[1]!, text, m.index)
    if (qty.kind === 'blocked') return { status: 'blocked' }
    if (qty.kind === 'absent') return { status: 'absent' }
    if (!m[2]) return { status: 'ok', parsed: { qty: qty.qty, unit: 'pcs' } }
    const parsed = tokenToParsed(m[2], qty.qty)
    return parsed ? { status: 'ok', parsed } : { status: 'absent' }
  })
  // "pack 60" → 60 pcs.
  consider(PACK_RE, 2, (m) => {
    const qty = usableQty(m[1]!, text, m.index)
    if (qty.kind === 'blocked') return { status: 'blocked' }
    if (qty.kind === 'absent') return { status: 'absent' }
    return { status: 'ok', parsed: { qty: qty.qty, unit: 'pcs' } }
  })
  // Plain number+unit: "150 g", "2.4KG", "1,5L", "5 KLG", "900-1000gram"
  // (a range contributes its upper bound — the last number+unit). No
  // leading \b on the unit — "5kg" has no word boundary between digit and
  // unit.
  consider(PLAIN_RE, 3, (m) => {
    const qty = usableQty(m[1]!, text, m.index)
    if (qty.kind === 'blocked') return { status: 'blocked' }
    if (qty.kind === 'absent') return { status: 'absent' }
    const parsed = tokenToParsed(m[2]!, qty.qty)
    return parsed ? { status: 'ok', parsed } : { status: 'absent' }
  })

  // Bare unit token → qty 1 ("pcs"; "1 PCS, 4'S" → the "1 PCS" head).
  // Suppressed when a real-but-unusable number sits at or before the token
  // ("0 g" is an explicit zero, never 1 g), while a rejected model number
  // ("0562 PCS") leaves the bare count token eligible.
  for (const m of text.matchAll(BARE_RE)) {
    const token = m[1]!.toLowerCase()
    if (bareMode === 'count' && !COUNT_FAMILY.has(token)) continue
    if (m.index >= blockedIndex) break
    const parsed = tokenToParsed(token, 1)
    if (parsed) {
      valid.push({ index: m.index, priority: 4, parsed })
      break
    }
  }

  valid.sort((a, b) => a.index - b.index || a.priority - b.priority)
  return valid[0]?.parsed ?? null
}

/**
 * Parse a product's unit field (first) or name tokens (fallback) into a
 * canonical quantity. Returns null when nothing usable is found — the caller
 * treats that as "not normalized", never as a validation failure.
 */
export function parseUnit(unit: string | null, name: string): ParsedUnit | null {
  if (typeof unit === 'string' && unit.trim().length > 0) {
    const fromField = scan(unit, 'all')
    if (fromField) return fromField
  }
  if (typeof name !== 'string' || name.length === 0) return null
  const stripped = name.replace(PACKAGING_RE, ' ').replace(BARE_KLG_RE, ' ')
  return scan(stripped, 'count')
}

/**
 * Listed price per display unit: mass per kg (g/1000), volume per liter
 * (ml/1000), count per piece. Rounded integer; null when not derivable.
 * Derived from the LISTED price — promo interplay is effectiveUnitPrice's
 * job (scraper/src/match/promo.ts), the two never collide.
 */
export function computeUnitPrice(price: number, parsed: ParsedUnit): number | null {
  if (!Number.isFinite(price) || !Number.isFinite(parsed.qty) || parsed.qty <= 0) return null
  const perUnit = parsed.unit === 'pcs' ? price / parsed.qty : (price * 1000) / parsed.qty
  return Number.isFinite(perUnit) ? Math.round(perUnit) : null
}
