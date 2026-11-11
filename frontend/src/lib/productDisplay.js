// Display-only normalization for the price surfaces (issue #633). Canonical
// names, units, aliases and product keys stay exactly as ingested — these
// helpers only shape what the shopper reads.

const ALL_UPPER = /^\p{Lu}+$/u
const ALL_LOWER = /^\p{Ll}+$/u
const HAS_LETTER = /\p{L}/u
const HAS_NON_LETTER = /[^\p{L}]/u
const HAS_DIGIT = /\p{Nd}/u
const LETTER_RUN = /\p{L}+/gu
const ALNUM_CHAR = /[\p{L}\p{N}]/u

function upperFirst(word) {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

// The shared acronym policy: an uppercase run of at most three letters is an
// acronym (ABC, SGM, UHT, RON, XL) and survives, while a longer run is a
// shouted word and takes sentence case. Lowercase runs do too; mixed-case
// runs are identity markers (iPhone) and stay raw. Both product names and
// promo labels go through this one rule so a future policy change lives here.
const MAX_ACRONYM_LENGTH = 3

function caseWord(run) {
  if (ALL_UPPER.test(run)) return run.length > MAX_ACRONYM_LENGTH ? upperFirst(run) : run
  if (ALL_LOWER.test(run)) return upperFirst(run)
  return run
}

// One whitespace token of a product name. Punctuation and digits are raw
// identity markers (MR.P, 6×38g, RON 88), so they skip the casing rules.
function titleCaseNameToken(token) {
  if (!HAS_LETTER.test(token) || HAS_NON_LETTER.test(token)) return token
  return caseWord(token)
}

// Promo labels are prose, unlike product names: a trailing "!" or "," must
// not stop "HARI!" from reading "Hari!". Tokens carrying digits (50%, 6×38g)
// stay untouched so a size or percentage never gains a stray capital.
function titleCasePromoToken(token) {
  if (HAS_DIGIT.test(token)) return token
  return token.replace(LETTER_RUN, caseWord)
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

// Words of a display name for the duplicate-brand check: lowercase letters
// and digits only, plus the offsets that start/end a word in that stream.
// Punctuation is a separator, not an identity marker, so "MR.P" still spells
// the brand "MRP" and "RON-88" matches "RON 88", while "Sariwangi" is one
// word and cannot contain the brand "Sari".
function wordKey(value) {
  const text = String(value ?? '').toLowerCase()
  let key = ''
  const boundaries = new Set([0])
  let separated = false
  for (const character of text) {
    if (!ALNUM_CHAR.test(character)) {
      separated = true
      continue
    }
    if (separated) boundaries.add(key.length)
    separated = false
    key += character
  }
  boundaries.add(key.length)
  return { key, boundaries }
}

function containsBrandWords(name, brandKey) {
  const nameKey = wordKey(name)
  for (
    let at = nameKey.key.indexOf(brandKey);
    at !== -1;
    at = nameKey.key.indexOf(brandKey, at + 1)
  ) {
    if (nameKey.boundaries.has(at) && nameKey.boundaries.has(at + brandKey.length)) return true
  }
  return false
}

// " · Brand" only when the brand is not already in the display name —
// "RON 88 Spring 300ml · RON 88" and "CARNATION … · CARNATION" are the same
// words twice. A brand only counts as present when it lines up with whole
// words ("Sariwangi" is not "Sari", "Indomie" is not "Ina"), ignoring case
// and punctuation; even a short brand (XL, 3M) is appended when it is
// genuinely missing. A brand with no letters or digits ("-", "!!") is not a
// brand at all and never earns a suffix.
export function brandSuffix(name, brand) {
  const brandKey = wordKey(brand).key
  if (!brandKey) return ''
  if (containsBrandWords(name, brandKey)) return ''
  const prettyBrand = prettyName(brand)
  return prettyBrand ? ` · ${prettyBrand}` : ''
}
