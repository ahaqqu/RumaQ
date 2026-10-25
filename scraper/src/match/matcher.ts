// Canonical-catalog matcher — the ★ key change vs haqita
// (docs/plan/haqita-integration.md §6): every incoming item is matched
// against the GROWING canonical catalog instead of a fixed lotte×superindo
// pairwise pass, so the pipeline scales to N stores. Gates 0–5 and the AI
// verifier (gate 6) are the ported haqita logic; the orchestration around
// them is new:
//
//   1. scan each item's gates over all catalog entries; exact/embedding
//      matches attach immediately (and new items found entries immediately,
//      so later items in the SAME run cross-store match against them);
//   2. ambiguous bests are held back and verified as a batch;
//   3. verifier YES/unparseable attaches (haqita kept unverifiable pairs
//      matched too), NO founds a new entry.
//
// Failure posture: embedding or verifier trouble (including quota) degrades
// the run to fewer matches — never fails it — because the OCR that produced
// these items is already paid for. Quota aborts (exit 2) stay an OCR-stage
// behavior.

import { Effect } from 'effect'

import { makeProductKey } from '../publish/payload.js'
import type { ValidatedProduct } from '../ocr/parse.js'
import type { GeminiClient } from '../ocr/gemini.js'
import { verifyPairs, type VerifyOutcome, type VerifyPair } from '../ocr/verify.js'
import {
  cosineSimilarity,
  embedNames,
  type EmbeddingCache,
  type EmbeddingClient,
} from './embedding.js'
import {
  gate0UnitType,
  gate1Brand,
  gate2TokenJaccard,
  gate3ExactMatch,
  gate4Embedding,
  gate5PricePlausibility,
  type GateResult,
  type MatchGateConfig,
} from './gates.js'
import { parsePromo } from './promo.js'

const MAX_NAME_VARIANTS = 10

/** One canonical product. Keys are haqita-convention product keys. */
export interface CatalogEntry {
  productKey: string
  name: string
  brand: string | null
  unit: string | null
  firstSeenAt: string
  lastSeenAt: string
  appearanceCount: number
  storesFound: string[]
  nameVariants: string[]
  /** Slug of the store that last sighted the entry — gate 5's price anchor. */
  lastStoreSlug: string
  lastPrice: number
  lastEffectiveUnitPrice: number
}

export interface Catalog {
  entries: Record<string, CatalogEntry>
}

export function emptyCatalog(): Catalog {
  return { entries: {} }
}

export interface MatchInputItem {
  storeSlug: string
  product: ValidatedProduct
}

export type MatchMethod = 'exact' | 'embedding' | 'ai' | 'solo'

/** How one input item resolved against the catalog. */
export interface MatchOutcome {
  /** Catalog key when matched; the item's own key when it founded an entry. */
  productKey: string
  matchMethod: MatchMethod
  matchConfidence: number
  /** True when this sighting founded a new catalog entry. */
  isNew: boolean
}

export interface MatchStats {
  exact: number
  embedding: number
  ai: number
  solo: number
  reviewItems: number
  verifierPairs: number
  embeddingsDegraded: boolean
  verifierQuotaExhausted: boolean
}

export interface MatchDeps {
  cfg: MatchGateConfig
  embeddingModel: string
  verifierModel: string
  verifierRetries: number
  /** slug → display name (for the verifier prompt's store labels). */
  storeNames: Record<string, string>
  apiKey?: string
  embedClient?: EmbeddingClient
  verifyClient?: GeminiClient
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

interface Candidate {
  entry: CatalogEntry
  method: 'exact' | 'embedding' | 'ai'
  score: number
}

interface HeldForVerify {
  item: MatchInputItem
  candidate: Candidate
  /** Index into the outcomes array this held pair resolves into. */
  outcomeIndex: number
}

function foundEntry(item: MatchInputItem, now: string): CatalogEntry {
  const { product } = item
  return {
    productKey: makeProductKey(product.name, product.brand, product.unit),
    name: product.name,
    brand: product.brand,
    unit: product.unit,
    firstSeenAt: now,
    lastSeenAt: now,
    appearanceCount: 1,
    storesFound: [item.storeSlug],
    nameVariants: [product.name],
    lastStoreSlug: item.storeSlug,
    lastPrice: product.price,
    lastEffectiveUnitPrice: parsePromo(product.promo, product.price).effectiveUnitPrice,
  }
}

function attach(entry: CatalogEntry, item: MatchInputItem, now: string): void {
  const { product } = item
  entry.lastSeenAt = now
  entry.appearanceCount += 1
  if (!entry.storesFound.includes(item.storeSlug)) entry.storesFound.push(item.storeSlug)
  if (!entry.nameVariants.includes(product.name)) {
    entry.nameVariants.push(product.name)
    if (entry.nameVariants.length > MAX_NAME_VARIANTS) entry.nameVariants.shift()
  }
  entry.lastStoreSlug = item.storeSlug
  entry.lastPrice = product.price
  entry.lastEffectiveUnitPrice = parsePromo(product.promo, product.price).effectiveUnitPrice
}

/**
 * Match all items against the catalog, mutating it as the sweep proceeds.
 * Never fails: embedding/verifier outages degrade matching (logged) so a
 * run's paid-for OCR always publishes.
 */
export function runMatch(
  items: MatchInputItem[],
  catalog: Catalog,
  cache: EmbeddingCache,
  deps: MatchDeps,
  now: string
): Effect.Effect<{
  outcomes: MatchOutcome[]
  catalog: Catalog
  cache: EmbeddingCache
  stats: MatchStats
}> {
  const log = deps.log ?? (() => {})
  const stats: MatchStats = {
    exact: 0,
    embedding: 0,
    ai: 0,
    solo: 0,
    reviewItems: 0,
    verifierPairs: 0,
    embeddingsDegraded: false,
    verifierQuotaExhausted: false,
  }

  return Effect.gen(function* () {
    // --- Embedding pass (gate 4 fuel) --------------------------------------
    // Raw names, like haqita's model.encode(names). Any failure — no key,
    // network, quota — degrades the whole run to exact-only matching.
    let vectors: Record<string, number[]> | undefined
    if (deps.cfg.gates.gate4Embedding && items.length > 0) {
      const names = [
        ...items.map((i) => i.product.name),
        ...Object.values(catalog.entries).map((e) => e.name),
      ]
      const embedded = yield* embedNames(names, cache, {
        apiKey: deps.apiKey,
        model: deps.embeddingModel,
        client: deps.embedClient,
        sleep: deps.sleep,
        log,
      }).pipe(
        // Matching must never fail the run — the OCR that produced these
        // items is already paid for. Any embedding trouble degrades the
        // sweep to exact-only matching.
        Effect.catchTag('EmbeddingError', (error) => {
          stats.embeddingsDegraded = true
          log(`[match] Embeddings unavailable — degrading to exact-only: ${error.message}`)
          return Effect.succeed(undefined)
        }),
        Effect.catchTag('QuotaExhausted', (error) => {
          stats.embeddingsDegraded = true
          log(`[match] Embedding quota exhausted — degrading to exact-only: ${error.message}`)
          return Effect.succeed(undefined)
        })
      )
      if (embedded) vectors = embedded
    }

    // --- Gate sweep ---------------------------------------------------------
    const outcomes: MatchOutcome[] = []
    const held: HeldForVerify[] = []

    const sweep = (item: MatchInputItem): MatchOutcome => {
      const { product } = item
      const itemEffective = parsePromo(product.promo, product.price).effectiveUnitPrice
      let best: Candidate | null = null

      for (const entry of Object.values(catalog.entries)) {
        const r0: GateResult = gate0UnitType(product, entry, deps.cfg)
        if (r0 === 'skip') continue

        const r1: GateResult = gate1Brand(product, entry, deps.cfg)
        if (r1 === 'skip') continue

        const r2: GateResult = gate2TokenJaccard(product, entry, deps.cfg)
        if (r2 === 'skip') continue

        const r3: GateResult = gate3ExactMatch(product, entry, deps.cfg)
        if (r3 === 'match') {
          best = { entry, method: 'exact', score: 1.0 }
          break
        }

        const score =
          vectors && vectors[product.name] && vectors[entry.name]
            ? cosineSimilarity(vectors[product.name]!, vectors[entry.name]!)
            : null
        const r4: GateResult = gate4Embedding(product, entry, deps.cfg, score)
        if (r4 === 'match' && score !== null) {
          if (!best || score > best.score) best = { entry, method: 'embedding', score }
          continue
        }
        if (r4 === 'ambiguous' && score !== null) {
          if (!best || score > best.score) best = { entry, method: 'ai', score }
          continue
        }
      }

      if (!best) {
        // No candidate: this sighting founds a new canonical entry, visible
        // to later items in the same run (that is how first-day cross-store
        // matching happens — mirrors haqita's single pairwise pass).
        const entry = foundEntry(item, now)
        catalog.entries[entry.productKey] = entry
        stats.solo++
        return {
          productKey: entry.productKey,
          matchMethod: 'solo',
          matchConfidence: 1.0,
          isNew: true,
        }
      }

      // Gate 5 — price plausibility on the best candidate. REVIEW never
      // revokes a match (haqita behavior): it flags for review.
      const r5 = gate5PricePlausibility(deps.cfg, itemEffective, best.entry.lastEffectiveUnitPrice)
      if (r5 === 'review') {
        stats.reviewItems++
        log(
          `[match] price_ratio flag: "${product.name}" (${itemEffective}) vs ` +
            `"${best.entry.name}" (${best.entry.lastEffectiveUnitPrice})`
        )
      }

      if (best.method === 'ai') {
        // Held: the verifier decides. No attach yet — a NO must find a new
        // entry cleanly (see the gate-6 block below).
        held.push({
          item,
          candidate: { entry: best.entry, method: 'ai', score: best.score },
          outcomeIndex: outcomes.length,
        })
        return {
          productKey: best.entry.productKey,
          matchMethod: 'ai',
          matchConfidence: round4(best.score),
          isNew: false,
        }
      }

      attach(best.entry, item, now)
      stats[best.method]++
      return {
        productKey: best.entry.productKey,
        matchMethod: best.method,
        matchConfidence: best.method === 'exact' ? 1.0 : round4(best.score),
        isNew: false,
      }
    }

    for (const item of items) {
      outcomes.push(sweep(item))
    }

    // --- Gate 6 — AI verifier for held pairs --------------------------------
    if (held.length > 0 && deps.cfg.gates.gate6AiVerifier) {
      stats.verifierPairs = held.length
      const pairs: VerifyPair[] = held.map(({ item, candidate }) => ({
        storeA: deps.storeNames[item.storeSlug] ?? item.storeSlug,
        nameA: item.product.name,
        unitA: item.product.unit,
        priceA: item.product.price,
        storeB: deps.storeNames[candidate.entry.lastStoreSlug] ?? candidate.entry.lastStoreSlug,
        nameB: candidate.entry.name,
        unitB: candidate.entry.unit,
        priceB: candidate.entry.lastPrice,
      }))
      const verdict = yield* verifyPairs(pairs, {
        apiKey: deps.apiKey,
        model: deps.verifierModel,
        retries: deps.verifierRetries,
        client: deps.verifyClient,
        sleep: deps.sleep,
        log,
      }).pipe(
        // No API key / client bootstrap failure: every pair stays matched
        // unverified and flagged, like haqita's no-key path.
        Effect.catchTag('VerifierError', (error) => {
          log(`[match] verifier unavailable: ${error.message}`)
          return Effect.succeed({
            answers: Array<'YES' | 'NO' | null>(pairs.length).fill(null),
            quotaExhausted: false,
          } satisfies VerifyOutcome)
        })
      )
      stats.verifierQuotaExhausted = verdict.quotaExhausted
      held.forEach(({ item, candidate, outcomeIndex }, i) => {
        const answer = verdict.answers[i]
        const outcome = outcomes[outcomeIndex]!
        if (answer === 'NO') {
          // Not the same product: this sighting founds its own entry.
          const entry = foundEntry(item, now)
          catalog.entries[entry.productKey] = entry
          stats.solo++
          outcome.productKey = entry.productKey
          outcome.matchMethod = 'solo'
          outcome.matchConfidence = 1.0
          outcome.isNew = true
          return
        }
        // YES, or unparseable/quota null: keep the match (haqita kept
        // unverifiable pairs and listed them for review).
        if (answer === null) {
          stats.reviewItems++
          log(`[match] verifier unresolved: "${item.product.name}" vs "${candidate.entry.name}"`)
        }
        attach(candidate.entry, item, now)
        stats.ai++
        outcome.matchMethod = 'ai'
        outcome.matchConfidence = round4(candidate.score)
      })
    } else if (held.length > 0) {
      // Gate 6 disabled: ambiguous candidates keep their embedding-scored
      // match without verification.
      for (const { item, candidate } of held) {
        attach(candidate.entry, item, now)
        stats.ai++
      }
    }

    return { outcomes, catalog, cache, stats }
  })
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}
