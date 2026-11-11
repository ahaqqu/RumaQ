// Display-only normalization for the price surfaces (issue #633). Canonical
// names, units, aliases and product keys stay exactly as ingested — these
// helpers only shape what the shopper reads.

const ALL_UPPER = /^\p{Lu}+$/u
const ALL_LOWER = /^\p{Ll}+$/u
const HAS_LETTER = /\p{L}/u
const HAS_NON_LETTER = /[^\p{L}]/u
const HAS_DIGIT = /\p{Nd}/u
const LETTER_RUN = /\p{L}+/gu
const NON_ALNUM = /[^\p{L}\p{N}]+/gu

function upperFirst(word) {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

// One whitespace token of a product name. Punctuation and digits are raw
// identity markers (MR.P, 6×38g, RON 88), so they skip the casing rules.
function titleCaseNameToken(token) {
  if (!HAS_LETTER.test(token) || HAS_NON_LETTER.test(token)) return token
  if (ALL_UPPER.test(token)) {
    return token.length > 3 ? upperFirst(token) : token
  }
  if (ALL_LOWER.test(token)) return upperFirst(token)
  return token
}

// Promo labels are prose, unlike product names: a trailing "!" or "," must
// not stop "HARI!" from reading "Hari!". Tokens carrying digits (50%, 6×38g)
// stay untouched so a size or percentage never gains a stray capital.
function titleCasePromoToken(token) {
  if (HAS_DIGIT.test(token)) return token
  return token.replace(LETTER_RUN, (run) => {
    if (ALL_UPPER.test(run)) return run.length > 3 ? upperFirst(run) : run
    if (ALL_LOWER.test(run)) return upperFirst(run)
    return run
  })
}

// Casing-only display helper for semicolon-split promo segments.
export function prettyPromoText(text) {
  if (text == null) return ''
  const collapsed = String(text).trim().replace(/\s+/g, ' ')
  if (!collapsed) return ''
  return collapsed.split(' ').map(titleCasePromoToken).join(' ')
}

// Canonical abbreviations: weight/mass in lowercase, litre as L (the
// Indonesian price sheets write "1.5L"), and package counts spaced
// consistently (2pcs → 2 pcs).
const UNIT_ALIASES = new Map([
  ['mg', 'mg'],
  ['kg', 'kg'],
  ['kilogram', 'kg'],
  ['kilograms', 'kg'],
  ['g', 'g'],
  ['gr', 'g'],
  ['gram', 'g'],
  ['grams', 'g'],
  ['ml', 'ml'],
  ['milliliter', 'ml'],
  ['milliliters', 'ml'],
  ['millilitre', 'ml'],
  ['millilitres', 'ml'],
  ['l', 'L'],
  ['liter', 'L'],
  ['liters', 'L'],
  ['litre', 'L'],
  ['litres', 'L'],
  ['pcs', 'pcs'],
  ['pc', 'pc'],
  ['pack', 'pack'],
  ['packs', 'packs'],
  ['sachet', 'sachet'],
  ['sachets', 'sachets'],
  ['buah', 'buah'],
])

// Longest alias first so "grams" wins over "g" and "ml" over "l".
const UNIT_ALTERNATION = [...UNIT_ALIASES.keys()].sort((a, b) => b.length - a.length).join('|')
const UNIT_RE = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_ALTERNATION})\\b`, 'gi')
// "6×38g", "6 x 45 ml", "1 L x 12" — a size multiplier, always a real ×.
const MULTIPLIER_RE = new RegExp(
  `(\\d+(?:[.,]\\d+)?\\s*(?:${UNIT_ALTERNATION})?)\\s*[x×]\\s*(?=\\d)`,
  'gi'
)

// Spacing/canonicalization for size tokens only. Text without a number+unit
// pair (Spring, buah on its own, RON 88) is left exactly as it came in.
export function prettyUnit(unit) {
  if (unit == null) return ''
  return String(unit)
    .trim()
    .replace(MULTIPLIER_RE, (_, left) => `${left.trim()} × `)
    .replace(UNIT_RE, (_, amount, abbreviation) => {
      const canonical = UNIT_ALIASES.get(abbreviation.toLowerCase())
      return `${amount} ${canonical ?? abbreviation}`
    })
}

// Title-case a product name without touching canonical identity: uppercase
// words longer than three letters become words, short acronyms (ABC, SGM,
// UHT, RON, XL) survive, and mixed-case or digit/punctuation-bearing tokens
// (MR.P, 6×38g, RON 88) are preserved. Size tokens are then spaced by
// prettyUnit so names read "300 ml" and "6 × 38 g".
export function prettyName(name) {
  if (name == null) return ''
  const collapsed = String(name).trim().replace(/\s+/g, ' ')
  if (!collapsed) return ''
  return prettyUnit(collapsed.split(' ').map(titleCaseNameToken).join(' '))
}

function alnumKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(NON_ALNUM, '')
}

// " · Brand" only when the brand is not already in the display name —
// "RON 88 Spring 300ml · RON 88" and "CARNATION … · CARNATION" are the same
// words twice. Compare alphanumerics only (case/punctuation-insensitive) and
// skip brands too short to compare meaningfully (XL, A B).
export function brandSuffix(name, brand) {
  const brandKey = alnumKey(brand)
  if (brandKey.length < 3) return ''
  if (alnumKey(name).includes(brandKey)) return ''
  const prettyBrand = prettyName(brand)
  return prettyBrand ? ` · ${prettyBrand}` : ''
}
