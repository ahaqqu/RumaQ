// Port of haqita tests/matching/test_matcher.py — gate 0–5 cases verbatim,
// adapted to the typed gate signatures (cfg object instead of dict).

import { describe, expect, it } from 'vite-plus/test'

import {
  allGates,
  gate0UnitType,
  gate1Brand,
  gate2TokenJaccard,
  gate3ExactMatch,
  gate4Embedding,
  gate5PricePlausibility,
  type MatchGateConfig,
} from '../../src/match/gates.js'

function cfg(overrides: Partial<MatchGateConfig> = {}): MatchGateConfig {
  return {
    tokenJaccardMin: 0.3,
    embeddingAutoMatch: 0.85,
    embeddingAmbiguousLow: 0.55,
    unitTolerancePct: 15,
    priceRatioMax: 3.0,
    gates: allGates(),
    ...overrides,
  }
}

function gatesOff(key: keyof MatchGateConfig['gates']): MatchGateConfig {
  return cfg({ gates: allGates({ [key]: false }) })
}

// ---------------------------------------------------------------------------
// Gate 0 — Unit type pre-filter
// ---------------------------------------------------------------------------

describe('gate0UnitType', () => {
  it('passes compatible units', () => {
    expect(gate0UnitType({ unit: '100 g' }, { unit: '500 g' }, cfg())).toBe('pass')
  })

  it('skips incompatible units', () => {
    expect(gate0UnitType({ unit: '100 g' }, { unit: '500 ml' }, cfg())).toBe('skip')
  })

  it('passes unknown units', () => {
    expect(gate0UnitType({ unit: '100 g' }, { unit: 'unknown_unit' }, cfg())).toBe('pass')
  })

  it('passes everything when disabled', () => {
    const c = gatesOff('gate0UnitType')
    expect(gate0UnitType({ unit: '100 g' }, { unit: '500 ml' }, c)).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// Gate 1 — Brand pre-filter
// ---------------------------------------------------------------------------

describe('gate1Brand', () => {
  it('passes same brand', () => {
    expect(gate1Brand({ brand: 'Indomie' }, { brand: 'Indomie' }, cfg())).toBe('pass')
  })

  it('skips different brands', () => {
    expect(gate1Brand({ brand: 'Indomie' }, { brand: 'Supermi' }, cfg())).toBe('skip')
  })

  it('resolves OCR aliases', () => {
    expect(gate1Brand({ brand: 'lndomie' }, { brand: 'Indomie' }, cfg())).toBe('pass')
  })

  it('passes when one side has no brand', () => {
    expect(gate1Brand({ brand: null }, { brand: 'Indomie' }, cfg())).toBe('pass')
  })

  it('passes everything when disabled', () => {
    const c = gatesOff('gate1Brand')
    expect(gate1Brand({ brand: 'Indomie' }, { brand: 'Supermi' }, c)).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// Gate 2 — Token Jaccard pre-filter
// ---------------------------------------------------------------------------

describe('gate2TokenJaccard', () => {
  it('passes high overlap', () => {
    const a = { name: 'Indomie Goreng Ayam Geprek' }
    const b = { name: 'Indomie Goreng' }
    expect(gate2TokenJaccard(a, b, cfg())).toBe('pass')
  })

  it('skips low overlap', () => {
    const a = { name: 'Indomie Goreng' }
    const b = { name: 'Ultra Milk Chocolate' }
    expect(gate2TokenJaccard(a, b, cfg())).toBe('skip')
  })

  it('passes everything when disabled', () => {
    const c = gatesOff('gate2TokenJaccard')
    const a = { name: 'Indomie Goreng' }
    const b = { name: 'Ultra Milk Chocolate' }
    expect(gate2TokenJaccard(a, b, c)).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// Gate 3 — Exact token-set match
// ---------------------------------------------------------------------------

describe('gate3ExactMatch', () => {
  it('matches identical names with compatible units', () => {
    const a = { name: 'Indomie Goreng', unit: '85 g' }
    const b = { name: 'Indomie Goreng', unit: '85 g' }
    expect(gate3ExactMatch(a, b, cfg())).toBe('match')
  })

  it('matches across word order', () => {
    const a = { name: 'Indomie Goreng', unit: '85 g' }
    const b = { name: 'Goreng Indomie', unit: '85 g' }
    expect(gate3ExactMatch(a, b, cfg())).toBe('match')
  })

  it('passes (no match) for different names', () => {
    const a = { name: 'Indomie Goreng', unit: '85 g' }
    const b = { name: 'Indomie Kuah', unit: '85 g' }
    expect(gate3ExactMatch(a, b, cfg())).toBe('pass')
  })

  it('passes when unit values are incompatible', () => {
    const a = { name: 'Indomie Goreng', unit: '85 g' }
    const b = { name: 'Indomie Goreng', unit: '100 ml' }
    expect(gate3ExactMatch(a, b, cfg())).toBe('pass')
  })

  it('passes everything when disabled', () => {
    const c = gatesOff('gate3ExactMatch')
    const a = { name: 'Indomie Goreng', unit: '85 g' }
    const b = { name: 'Indomie Goreng', unit: '85 g' }
    expect(gate3ExactMatch(a, b, c)).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// Gate 4 — Embedding similarity (score injected, no model)
// ---------------------------------------------------------------------------

describe('gate4Embedding', () => {
  const a = { name: 'Indomie Goreng', unit: '85 g' }
  const b = { name: 'Indomie Goreng', unit: '85 g' }

  it('passes when disabled', () => {
    const c = gatesOff('gate4Embedding')
    expect(gate4Embedding(a, b, c, 0.99)).toBe('pass')
  })

  it('passes when no score is available (model=None in haqita)', () => {
    expect(gate4Embedding(a, b, cfg(), null)).toBe('pass')
  })

  it('matches high similarity with compatible units', () => {
    expect(gate4Embedding(a, b, cfg(), 1.0)).toBe('match')
  })

  it('high similarity with incompatible units is no_match', () => {
    const c = cfg()
    expect(gate4Embedding({ name: 'A', unit: '100 g' }, { name: 'B', unit: '1 L' }, c, 0.99)).toBe(
      'no_match'
    )
  })

  it('no_match below the ambiguous floor', () => {
    const low = { name: 'Indomie Goreng', unit: '85 g' }
    const other = { name: 'Ultra Milk', unit: '1 L' }
    expect(gate4Embedding(low, other, cfg(), 0.3)).toBe('no_match')
  })

  it('ambiguous between floor and auto-match', () => {
    expect(gate4Embedding(a, b, cfg(), 0.7)).toBe('ambiguous')
  })
})

// ---------------------------------------------------------------------------
// Gate 5 — Price plausibility
// ---------------------------------------------------------------------------

describe('gate5PricePlausibility', () => {
  it('passes similar prices', () => {
    expect(gate5PricePlausibility(cfg(), 10000, 12000)).toBe('pass')
  })

  it('reviews a 5x ratio', () => {
    expect(gate5PricePlausibility(cfg(), 10000, 50000)).toBe('review')
  })

  it('passes zero prices', () => {
    expect(gate5PricePlausibility(cfg(), 0, 50000)).toBe('pass')
  })

  it('passes everything when disabled', () => {
    const c = gatesOff('gate5PricePlausibility')
    expect(gate5PricePlausibility(c, 10000, 50000)).toBe('pass')
  })
})
