// Shadow-OCR extraction audit (issue #367, phase 1): an env-gated second
// ("shadow") one-shot model call per sampled fresh page, diffed field-by-field
// against the primary extraction to measure per-store agreement. Everything
// here is measurement only — shadow results NEVER enter products, matching,
// or publishing — and every failure is swallowed (sample skipped, log line,
// store never fails). The gate defaults OFF: an unset RUMAQ_OCR_AUDIT makes
// zero shadow calls, byte-for-byte the pre-audit behavior.

import { Effect } from 'effect'

import {
  AUDIT_DISAGREEMENTS_LIMIT,
  AUDIT_DISAGREEMENT_LIMITS,
  type AuditDisagreement,
  type RunAudit,
} from '@rumaq/contract'

import { tokenOverlap } from '../match/normalize.js'
import { createOcr, type GeminiClient, type Ocr } from './gemini.js'
import { normalizePromo, parseIdrValue, type RawOcrItem, type ValidatedProduct } from './parse.js'

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * RUMAQ_OCR_AUDIT (issue #367): `off` (default — zero behavior change, zero
 * cost) | `all` (every fresh page) | `sample:N` (1-in-N fresh pages).
 */
export type AuditGate = { mode: 'off' } | { mode: 'all' } | { mode: 'sample'; every: number }

/**
 * Parse the gate env value. Unset/blank/`off` → off; `all` → all;
 * `sample:N` (N ≥ 1) → sample. Anything else falls back to off — the audit
 * must never turn itself on by accident.
 */
export function parseAuditGate(raw: string | undefined): AuditGate {
  const value = raw?.trim().toLowerCase()
  if (!value || value === 'off') return { mode: 'off' }
  if (value === 'all') return { mode: 'all' }
  const sample = /^sample:(\d+)$/.exec(value)
  if (sample && Number(sample[1]) >= 1) return { mode: 'sample', every: Number(sample[1]) }
  return { mode: 'off' }
}

/**
 * Whether the fresh page at `freshPageIndex` (0-based, per store run) gets a
 * shadow call. Deterministic positional sampling (first page, then every
 * Nth) so a run is reproducible and testable without a clock.
 */
export function shouldSamplePage(gate: AuditGate, freshPageIndex: number): boolean {
  if (gate.mode === 'off') return false
  if (gate.mode === 'all') return true
  return freshPageIndex % gate.every === 0
}

/** The shadow model for a run: RUMAQ_OCR_AUDIT_MODEL override, else the OCR
 * chain's second rung (a different model is the point — the diff then
 * measures cross-model agreement, not run-to-run variance). A one-rung chain
 * (an explicit pin) falls back to its only rung. */
export function resolveShadowModel(
  ocrChain: readonly string[],
  override: string | undefined
): string {
  return override?.trim() || ocrChain[1] || ocrChain[0]!
}

/** What processStore needs to run the audit for one store. */
export interface AuditPlan {
  gate: AuditGate
  shadowModel: string
}

// ---------------------------------------------------------------------------
// Shadow call
// ---------------------------------------------------------------------------

export interface ShadowOcrOptions {
  model: string
  storeSlug: string
  client?: GeminiClient
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

/**
 * The shadow OCR is a one-shot by construction: a pinned single model string
 * (never a ModelChainState — no rung can advance) and zero retries (no
 * aggressive ladder). It reuses createOcr's machinery so the prompt, client
 * resolution, and error typing have exactly one definition (issue #367).
 */
export function createShadowOcr(options: ShadowOcrOptions): Ocr {
  return createOcr({
    model: options.model,
    storeSlug: options.storeSlug,
    retries: 0,
    client: options.client,
    sleep: options.sleep,
    log: options.log,
  })
}

/**
 * Run one shadow call, swallowing EVERY failure into a null sample (a 429,
 * a 503, an unparseable response — the audit is observability and must never
 * fail the store, issue #367). The skip carries a ctx-style log line.
 */
export function runShadowAudit(
  shadow: Ocr,
  storeSlug: string,
  imageBytes: Uint8Array,
  mimeType?: string,
  log?: (message: string) => void
): Effect.Effect<RawOcrItem[] | null> {
  return shadow.ocrImage(imageBytes, mimeType).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        log?.(
          `[audit] ${storeSlug}: shadow OCR failed — sample skipped: ` +
            `${error instanceof Error ? error.message : String(error)}`
        )
        return null
      })
    )
  )
}

// ---------------------------------------------------------------------------
// Diff + accumulation
// ---------------------------------------------------------------------------

/** Fallback name-match floor (issue #367): token Jaccard ≥ 0.6. */
export const NAME_MATCH_JACCARD_MIN = 0.6

/** Per-store running audit state across one run's sampled pages. */
export interface AuditAccumulator {
  sampledPages: number
  /** Primary items seen on sampled pages — the name denominator. */
  primaryItems: number
  /** Primary items that matched a shadow item — name agreement. */
  nameAgree: number
  /** Matched pairs — the price/originalPrice/promo denominator. */
  matchedPairs: number
  priceAgree: number
  originalAgree: number
  promoAgree: number
  disagreements: AuditDisagreement[]
}

export function newAuditAccumulator(): AuditAccumulator {
  return {
    sampledPages: 0,
    primaryItems: 0,
    nameAgree: 0,
    matchedPairs: 0,
    priceAgree: 0,
    originalAgree: 0,
    promoAgree: 0,
    disagreements: [],
  }
}

/** The shadow item's comparable shape — prices parsed, promo to presence. */
interface ShadowItem {
  name: string
  price: number | null
  originalPrice: number | null
  promo: string[] | null
}

function toShadowItem(raw: RawOcrItem): ShadowItem {
  const price = parseIdrValue(raw.price)
  const originalPrice = parseIdrValue(raw.originalPrice ?? null)
  return {
    name: String(raw.name ?? '').trim(),
    price: price !== null && price >= 0 ? price : null,
    originalPrice: originalPrice !== null && originalPrice >= 0 ? originalPrice : null,
    promo: normalizePromo(raw.promo),
  }
}

function renderValue(value: number | null): string {
  return value === null ? 'none' : String(value)
}

function renderPromo(promo: string[] | null): string {
  return promo ? promo.join('; ') : 'none'
}

function truncate(disagreement: AuditDisagreement): AuditDisagreement {
  return {
    imageFilename: disagreement.imageFilename.slice(0, AUDIT_DISAGREEMENT_LIMITS.imageFilename),
    field: disagreement.field.slice(0, AUDIT_DISAGREEMENT_LIMITS.field),
    primary: disagreement.primary.slice(0, AUDIT_DISAGREEMENT_LIMITS.primary),
    shadow: disagreement.shadow.slice(0, AUDIT_DISAGREEMENT_LIMITS.shadow),
  }
}

/**
 * Diff one sampled page's primary items against the shadow items, mutating
 * the accumulator. Matching: lower-cased exact name first, then the best
 * token-Jaccard ≥ 0.6 partner among the leftovers (issue #367). Matched
 * pairs compare price (parsed equality), originalPrice (null-safe equality),
 * and promo PRESENCE (wording differs too freely to diff); unmatched primary
 * items are name disagreements. Promo disagreement lines render the present
 * side's text so the line is actionable.
 */
export function diffOcrItems(
  primary: readonly ValidatedProduct[],
  shadowRaw: readonly RawOcrItem[],
  imageFilename: string,
  acc: AuditAccumulator
): void {
  acc.sampledPages += 1
  const shadow = shadowRaw.map(toShadowItem)
  const taken = new Set<number>()
  const partner = new Map<number, number>()

  // Pass 1 — lower-cased exact name (first unmatched partner wins).
  for (let i = 0; i < primary.length; i++) {
    const name = primary[i]!.name.toLowerCase()
    for (let j = 0; j < shadow.length; j++) {
      if (taken.has(j)) continue
      if (shadow[j]!.name.toLowerCase() === name) {
        partner.set(i, j)
        taken.add(j)
        break
      }
    }
  }
  // Pass 2 — best token-Jaccard ≥ 0.6 among the leftovers (first-best on tie).
  for (let i = 0; i < primary.length; i++) {
    if (partner.has(i)) continue
    let best = -1
    let bestScore = NAME_MATCH_JACCARD_MIN
    for (let j = 0; j < shadow.length; j++) {
      if (taken.has(j)) continue
      const score = tokenOverlap(primary[i]!.name, shadow[j]!.name)
      if (score >= NAME_MATCH_JACCARD_MIN && (best === -1 || score > bestScore)) {
        best = j
        bestScore = score
      }
    }
    if (best !== -1) {
      partner.set(i, best)
      taken.add(best)
    }
  }

  acc.primaryItems += primary.length
  for (let i = 0; i < primary.length; i++) {
    const j = partner.get(i)
    if (j === undefined) {
      acc.disagreements.push(
        truncate({
          imageFilename,
          field: 'name',
          primary: primary[i]!.name,
          shadow: '(no match)',
        })
      )
      continue
    }
    acc.matchedPairs += 1
    acc.nameAgree += 1
    const s = shadow[j]!
    if (primary[i]!.price !== s.price) {
      acc.disagreements.push(
        truncate({
          imageFilename,
          field: 'price',
          primary: String(primary[i]!.price),
          shadow: renderValue(s.price),
        })
      )
    } else {
      acc.priceAgree += 1
    }
    if (primary[i]!.originalPrice !== s.originalPrice) {
      acc.disagreements.push(
        truncate({
          imageFilename,
          field: 'originalPrice',
          primary: renderValue(primary[i]!.originalPrice),
          shadow: renderValue(s.originalPrice),
        })
      )
    } else {
      acc.originalAgree += 1
    }
    if ((primary[i]!.promo !== null) !== (s.promo !== null)) {
      acc.disagreements.push(
        truncate({
          imageFilename,
          field: 'promo',
          primary: renderPromo(primary[i]!.promo),
          shadow: renderPromo(s.promo),
        })
      )
    } else {
      acc.promoAgree += 1
    }
  }
  // The contract caps the report copy (maxItems) — keep the accumulator
  // bounded so a catastrophic page can only crowd out later ones, never
  // blow the schema.
  if (acc.disagreements.length > AUDIT_DISAGREEMENTS_LIMIT) {
    acc.disagreements.length = AUDIT_DISAGREEMENTS_LIMIT
  }
}

/**
 * Fold the accumulator into the report's audit object. A zero denominator
 * (nothing sampled / nothing matched) reports 100 — vacuous agreement, no
 * observed disagreement — with sampledPages carrying the real sample size.
 */
export function summarizeAudit(acc: AuditAccumulator): RunAudit {
  const pct = (agree: number, total: number): number =>
    total === 0 ? 100 : Math.round((agree / total) * 100)
  return {
    sampledPages: acc.sampledPages,
    nameAgreePct: pct(acc.nameAgree, acc.primaryItems),
    priceAgreePct: pct(acc.priceAgree, acc.matchedPairs),
    originalAgreePct: pct(acc.originalAgree, acc.matchedPairs),
    promoAgreePct: pct(acc.promoAgree, acc.matchedPairs),
    disagreements: acc.disagreements.slice(0, AUDIT_DISAGREEMENTS_LIMIT),
  }
}
