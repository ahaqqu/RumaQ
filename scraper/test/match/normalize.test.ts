// Port of haqita tests/matching/test_normalizer.py — cases verbatim.

import { describe, expect, it } from 'vite-plus/test'

import {
  BRAND_ALIASES,
  canonicalTokens,
  normalizeBrand,
  normalizeName,
  parseUnitToBase,
  tokenOverlap,
  unitType,
  unitsTypeCompatible,
  unitsValueCompatible,
} from '../../src/match/normalize.js'

// ---------------------------------------------------------------------------
// normalizeBrand
// ---------------------------------------------------------------------------

describe('normalizeBrand', () => {
  it('lowercases', () => {
    expect(normalizeBrand('INDOMIE')).toBe('indomie')
  })

  it('strips whitespace', () => {
    expect(normalizeBrand('  Sosro  ')).toBe('sosro')
  })

  it('maps known aliases', () => {
    expect(normalizeBrand('lndomie')).toBe('indomie')
    expect(normalizeBrand('S0sro')).toBe('sosro')
    expect(normalizeBrand('Ult rajaya')).toBe('ultrajaya')
  })

  it('returns empty for null', () => {
    expect(normalizeBrand(null)).toBe('')
  })

  it('returns empty for empty string', () => {
    expect(normalizeBrand('')).toBe('')
  })

  it('passes unknown brands through', () => {
    expect(normalizeBrand('Golden Farm')).toBe('golden farm')
  })

  it('ships the haqita alias table verbatim', () => {
    expect(BRAND_ALIASES['ultrqjaya']).toBe('ultrajaya')
  })
})

// ---------------------------------------------------------------------------
// unitType
// ---------------------------------------------------------------------------

describe('unitType', () => {
  it('detects weight units', () => {
    expect(unitType('100 g')).toBe('weight')
    expect(unitType('1 kg')).toBe('weight')
  })

  it('detects volume units', () => {
    expect(unitType('500 ml')).toBe('volume')
    expect(unitType('1.5 L')).toBe('volume')
  })

  it('detects count units', () => {
    expect(unitType('6 pcs')).toBe('count')
    expect(unitType('1 pack')).toBe('count')
    expect(unitType('1 tub')).toBe('count')
  })

  it('returns null for null', () => {
    expect(unitType(null)).toBeNull()
  })

  it("maps 'set' to count — it is in UNIT_TYPE_MAP", () => {
    expect(unitType('set')).toBe('count')
  })

  it("suffix-matches \"1100's\" to count via 's'", () => {
    expect(unitType("1100's")).toBe('count')
  })

  it('suffix-scan order matches Python: "1 bag" hits g → weight', () => {
    // haqita's suffix loop checks 'g' before 'bag', so "bag" types as weight.
    // Ported faithfully — this pins the (subtle) original behavior.
    expect(unitType('1 bag')).toBe('weight')
  })
})

// ---------------------------------------------------------------------------
// unitsTypeCompatible
// ---------------------------------------------------------------------------

describe('unitsTypeCompatible', () => {
  it('passes same types', () => {
    expect(unitsTypeCompatible('100 g', '500 g')).toBe(true)
  })

  it('rejects different types', () => {
    expect(unitsTypeCompatible('100 g', '500 ml')).toBe(false)
  })

  it('allows unknown units', () => {
    expect(unitsTypeCompatible('100 g', 'unknown')).toBe(true)
    expect(unitsTypeCompatible(null, '500 ml')).toBe(true)
  })

  it('allows both null', () => {
    expect(unitsTypeCompatible(null, null)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// parseUnitToBase
// ---------------------------------------------------------------------------

describe('parseUnitToBase', () => {
  it.each([
    ['85 g', { value: 85, type: 'weight' }],
    ['1 kg', { value: 1000, type: 'weight' }],
    ['1.5 L', { value: 1500, type: 'volume' }],
    ['2 x 800 ml', { value: 1600, type: 'volume' }],
    ['6 x 45 ml', { value: 270, type: 'volume' }],
    ['3 pcs', { value: 3, type: 'count' }],
  ])('parses %s', (input, expected) => {
    expect(parseUnitToBase(input)).toEqual(expected)
  })

  it('returns null for null', () => {
    expect(parseUnitToBase(null)).toBeNull()
  })

  it('returns null when only a bare word remains ("set")', () => {
    expect(parseUnitToBase('set')).toBeNull()
  })

  // haqita's docstring claims "1100's" → (1100, 'count'), but the real
  // Python returns None (the regex needs [a-z]+ before the apostrophe) —
  // verified against the original before porting. unit_type("1100's") is
  // what actually reads it as count (suffix scan).
  it('matches the real Python for "1100\'s" (docstring there is wrong)', () => {
    expect(parseUnitToBase("1100's")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// unitsValueCompatible
// ---------------------------------------------------------------------------

describe('unitsValueCompatible', () => {
  it('passes identical values', () => {
    expect(unitsValueCompatible('100 g', '100 g')).toBe(true)
  })

  it('passes within ±15% tolerance', () => {
    expect(unitsValueCompatible('100 g', '110 g')).toBe(true)
  })

  it('rejects outside tolerance (85 vs 250 g)', () => {
    expect(unitsValueCompatible('85 g', '250 g')).toBe(false)
  })

  it('rejects different types', () => {
    expect(unitsValueCompatible('100 g', '100 ml')).toBe(false)
  })

  it('allows unknown units', () => {
    expect(unitsValueCompatible('100 g', 'unknown')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// normalizeName
// ---------------------------------------------------------------------------

describe('normalizeName', () => {
  it('lowercases', () => {
    expect(normalizeName('Indomie Goreng')).toBe('indomie goreng')
  })

  it('strips unit-like tokens', () => {
    expect(normalizeName('Indomie Goreng 85 g')).not.toContain('85')
  })

  it('collapses whitespace', () => {
    expect(normalizeName('Hello   World')).toBe('hello world')
  })

  it('is memoized (same result object)', () => {
    const r1 = normalizeName('Test Product')
    const r2 = normalizeName('Test Product')
    expect(r1).toBe(r2)
  })
})

// ---------------------------------------------------------------------------
// canonicalTokens
// ---------------------------------------------------------------------------

describe('canonicalTokens', () => {
  it('is order-independent', () => {
    expect(canonicalTokens('Indomie Goreng')).toEqual(canonicalTokens('Goreng Indomie'))
  })

  it('tokenizes the empty string to an empty set', () => {
    expect(canonicalTokens('')).toEqual(new Set())
  })

  it('removes special characters', () => {
    const tokens = canonicalTokens('Hello, World!')
    expect(tokens.has('hello')).toBe(true)
    expect(tokens.has('world')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// tokenOverlap (Jaccard)
// ---------------------------------------------------------------------------

describe('tokenOverlap', () => {
  it('identical names score 1.0', () => {
    expect(tokenOverlap('Indomie Goreng', 'Indomie Goreng')).toBe(1.0)
  })

  it('disjoint names score 0.0', () => {
    expect(tokenOverlap('Indomie Goreng', 'Ultra Milk')).toBe(0.0)
  })

  it('partial overlap lands strictly between 0 and 1', () => {
    const score = tokenOverlap('Indomie Goreng', 'Indomie Kuah')
    expect(score).toBeGreaterThan(0.0)
    expect(score).toBeLessThan(1.0)
  })

  it('word-order swap scores 1.0', () => {
    expect(tokenOverlap('Indomie Goreng', 'Goreng Indomie')).toBe(1.0)
  })

  it('both empty score 1.0', () => {
    expect(tokenOverlap('', '')).toBe(1.0)
  })

  it('one empty scores 0.0', () => {
    expect(tokenOverlap('Indomie', '')).toBe(0.0)
  })
})
