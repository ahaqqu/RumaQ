// Port of haqita scripts/matching/matcher.py gates 0–5 — each gate is an
// isolated pure function; the orchestrator (matcher.ts) checks the config
// flags before calling. The AI verifier (gate 6) lives in ocr/verify.ts
// because it shares the Gemini client plumbing with the OCR stage.

import {
  canonicalTokens,
  normalizeBrand,
  tokenOverlap,
  unitsTypeCompatible,
  unitsValueCompatible,
} from './normalize.js'

export type GateResult = 'skip' | 'pass' | 'match' | 'no_match' | 'ambiguous' | 'review'

/** Structural slice both OCR items and catalog entries satisfy. */
export interface MatchableItem {
  name?: string | null
  brand?: string | null
  unit?: string | null
}

/** Per-gate feature flags — port of haqita config.yaml `consolidation.gates`. */
export interface GateFlags {
  gate0UnitType: boolean
  gate1Brand: boolean
  gate2TokenJaccard: boolean
  gate3ExactMatch: boolean
  gate4Embedding: boolean
  gate5PricePlausibility: boolean
  gate6AiVerifier: boolean
}

/** The consolidation thresholds the gates read (config.ts consolidation). */
export interface MatchThresholds {
  tokenJaccardMin: number
  embeddingAutoMatch: number
  embeddingAmbiguousLow: number
  unitTolerancePct: number
  priceRatioMax: number
}

export interface MatchGateConfig extends MatchThresholds {
  gates: GateFlags
}

const ENABLED_GATES: GateFlags = {
  gate0UnitType: true,
  gate1Brand: true,
  gate2TokenJaccard: true,
  gate3ExactMatch: true,
  gate4Embedding: true,
  gate5PricePlausibility: true,
  gate6AiVerifier: true,
}

/** All gates on — the shape tests build partial overrides from. */
export function allGates(overrides: Partial<GateFlags> = {}): GateFlags {
  return { ...ENABLED_GATES, ...overrides }
}

// ---------------------------------------------------------------------------
// Gate 0 — Unit type pre-filter
// ---------------------------------------------------------------------------

/** Gate 0: Skip if unit types are incompatible (weight vs count). */
export function gate0UnitType(
  a: MatchableItem,
  b: MatchableItem,
  cfg: MatchGateConfig
): GateResult {
  if (!cfg.gates.gate0UnitType) return 'pass'
  if (!unitsTypeCompatible(a.unit, b.unit)) return 'skip'
  return 'pass'
}

// ---------------------------------------------------------------------------
// Gate 1 — Brand pre-filter
// ---------------------------------------------------------------------------

/** Gate 1: Skip if normalized brands are known and different. */
export function gate1Brand(a: MatchableItem, b: MatchableItem, cfg: MatchGateConfig): GateResult {
  if (!cfg.gates.gate1Brand) return 'pass'
  const b1 = normalizeBrand(a.brand)
  const b2 = normalizeBrand(b.brand)
  if (b1 && b2 && b1 !== b2) return 'skip'
  return 'pass'
}

// ---------------------------------------------------------------------------
// Gate 2 — Token Jaccard pre-filter
// ---------------------------------------------------------------------------

/** Gate 2: Skip if token Jaccard overlap is below the threshold. */
export function gate2TokenJaccard(
  a: MatchableItem,
  b: MatchableItem,
  cfg: MatchGateConfig
): GateResult {
  if (!cfg.gates.gate2TokenJaccard) return 'pass'
  const score = tokenOverlap(a.name ?? '', b.name ?? '')
  if (score < cfg.tokenJaccardMin) return 'skip'
  return 'pass'
}

// ---------------------------------------------------------------------------
// Gate 3 — Exact token-set match
// ---------------------------------------------------------------------------

/** Gate 3: Match if canonical tokens are equal AND unit values compatible. */
export function gate3ExactMatch(
  a: MatchableItem,
  b: MatchableItem,
  cfg: MatchGateConfig
): GateResult {
  if (!cfg.gates.gate3ExactMatch) return 'pass'
  if (setsEqual(canonicalTokens(a.name ?? ''), canonicalTokens(b.name ?? ''))) {
    if (unitsValueCompatible(a.unit, b.unit, cfg.unitTolerancePct / 100)) return 'match'
  }
  return 'pass'
}

// ---------------------------------------------------------------------------
// Gate 4 — Embedding similarity
// ---------------------------------------------------------------------------

/**
 * Gate 4: Embedding similarity. A null score (embeddings unavailable — the
 * whole stage failed, or gate disabled) is a PASS so only exact matches
 * survive, mirroring haqita's model-is-None behavior.
 */
export function gate4Embedding(
  a: MatchableItem,
  b: MatchableItem,
  cfg: MatchGateConfig,
  score: number | null
): GateResult {
  if (!cfg.gates.gate4Embedding) return 'pass'
  if (score === null) return 'pass'

  if (score >= cfg.embeddingAutoMatch) {
    if (unitsValueCompatible(a.unit, b.unit, cfg.unitTolerancePct / 100)) return 'match'
    return 'no_match'
  }
  if (score < cfg.embeddingAmbiguousLow) return 'no_match'
  return 'ambiguous'
}

// ---------------------------------------------------------------------------
// Gate 5 — Price plausibility check
// ---------------------------------------------------------------------------

/** Gate 5: Flag for review if the per-unit price ratio exceeds the max. */
export function gate5PricePlausibility(
  cfg: MatchGateConfig,
  effectivePriceA: number,
  effectivePriceB: number
): GateResult {
  if (!cfg.gates.gate5PricePlausibility) return 'pass'
  if (effectivePriceA <= 0 || effectivePriceB <= 0) return 'pass'
  const ratio =
    Math.max(effectivePriceA, effectivePriceB) / Math.min(effectivePriceA, effectivePriceB)
  if (ratio > cfg.priceRatioMax) return 'review'
  return 'pass'
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const token of a) if (!b.has(token)) return false
  return true
}
