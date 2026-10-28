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

/**
 * One flagged candidate pair for the admin review queue (issue #294): A = the
 * incoming item being matched, B = the catalog entry's last sighting. Values
 * are frozen at flag time — entries mutate mid-sweep (attach() rewrites the
 * last* fields per sighting), so the record is what the gate actually judged,
 * not a stable fact. The report envelope owns runStartedAt; pairs carry none.
 */
export interface ReviewItemRecord {
  itemProductKey: string
  itemName: string
  itemBrand: string | null
  itemUnit: string | null
  itemPrice: number
  itemEffectiveUnitPrice: number
  itemStore: string
  entryProductKey: string
  entryName: string
  entryBrand: string | null
  entryUnit: string | null
  entryPrice: number
  entryEffectiveUnitPrice: number
  entryStore: string
  matchMethod: 'exact' | 'embedding' | 'ai'
  /** best.score (exact = 1.0). */
  confidence: number
  reason: 'price_ratio' | 'verifier_unresolved'
}

/** The B-side evidence fields a review record needs — CatalogEntry and the
 * held-pair snapshot both satisfy it structurally. */
interface ReviewEntryEvidence {
  productKey: string
  name: string
  brand: string | null
  unit: string | null
  lastPrice: number
  lastEffectiveUnitPrice: number
  lastStoreSlug: string
}

function reviewRecord(
  item: MatchInputItem,
  itemEffective: number,
  entry: ReviewEntryEvidence,
  matchMethod: ReviewItemRecord['matchMethod'],
  confidence: number,
  reason: ReviewItemRecord['reason']
): ReviewItemRecord {
  const { product } = item
  return {
    itemProductKey: makeProductKey(product.name, product.brand, product.unit),
    itemName: product.name,
    itemBrand: product.brand,
    itemUnit: product.unit,
    itemPrice: product.price,
    itemEffectiveUnitPrice: itemEffective,
    itemStore: item.storeSlug,
    entryProductKey: entry.productKey,
    entryName: entry.name,
    entryBrand: entry.brand,
    entryUnit: entry.unit,
    entryPrice: entry.lastPrice,
    entryEffectiveUnitPrice: entry.lastEffectiveUnitPrice,
    entryStore: entry.lastStoreSlug,
    matchMethod,
    confidence: round4(confidence),
    reason,
  }
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
  /** The item's effective unit price at sweep time (gate 5's A-side input). */
  itemEffective: number
  /** B-side evidence frozen at hold time — the entry may be mutated by other
   * sightings before this pair resolves (issue #294 honesty rule). */
  entrySnapshot: ReviewEntryEvidence
  /** Gate 5 flagged this pair at hold time: it emits price_ratio when the
   * match stands (verifier YES or disabled gate 6); a null verdict emits
   * verifier_unresolved instead. A NO verdict emits nothing — the pair was
   * split, so there is nothing left to review. */
  gate5Flagged: boolean
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
  reviewItems: ReviewItemRecord[]
  stats: MatchStats
}> {
  const log = deps.log ?? (() => {})
  // Running counters; reviewItems is deliberately absent — it is derived
  // from the emitted records at return time, so counter and records can
  // never diverge (issue #294 double-count fix).
  const counters: Omit<MatchStats, 'reviewItems'> = {
    exact: 0,
    embedding: 0,
    ai: 0,
    solo: 0,
    verifierPairs: 0,
    embeddingsDegraded: false,
    verifierQuotaExhausted: false,
  }
  const reviewItems: ReviewItemRecord[] = []

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
          counters.embeddingsDegraded = true
          log(`[match] Embeddings unavailable — degrading to exact-only: ${error.message}`)
          return Effect.succeed(undefined)
        }),
        Effect.catchTag('QuotaExhausted', (error) => {
          counters.embeddingsDegraded = true
          log(`[match] Embedding quota exhausted — degrading to exact-only: ${error.message}`)
          return Effect.succeed(undefined)
        })
      )
      if (embedded) vectors = embedded
    }

    // --- Gate sweep ---------------------------------------------------------
    const outcomes: MatchOutcome[] = []
    const held: HeldForVerify[] = []

    // Found a new canonical entry — unless an entry with the same product
    // key already exists (two items with identical name/brand/unit in one
    // sweep, e.g. the same product on both stores): replacing it would reset
    // its accumulated history (appearanceCount/storesFound/firstSeenAt), so
    // the sighting attaches to the existing entry instead.
    const foundOrAttach = (item: MatchInputItem): { productKey: string; isNew: boolean } => {
      const entry = foundEntry(item, now)
      const existing = catalog.entries[entry.productKey]
      if (existing) {
        attach(existing, item, now)
        return { productKey: existing.productKey, isNew: false }
      }
      catalog.entries[entry.productKey] = entry
      return { productKey: entry.productKey, isNew: true }
    }

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
        const founded = foundOrAttach(item)
        counters.solo++
        return {
          productKey: founded.productKey,
          matchMethod: 'solo',
          matchConfidence: 1.0,
          isNew: founded.isNew,
        }
      }

      // Gate 5 — price plausibility on the best candidate. REVIEW never
      // revokes a match (haqita behavior): it flags for review. The flag
      // emits a review record immediately for exact/embedding pairs (the
      // entry evidence below is still pre-attach); an AI-method pair defers
      // to its gate-6 resolution so every pair is emitted at most once, and
      // only when it actually stayed matched (issue #294).
      const gate5Flagged =
        gate5PricePlausibility(deps.cfg, itemEffective, best.entry.lastEffectiveUnitPrice) ===
        'review'
      if (gate5Flagged) {
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
          itemEffective,
          entrySnapshot: {
            productKey: best.entry.productKey,
            name: best.entry.name,
            brand: best.entry.brand,
            unit: best.entry.unit,
            lastPrice: best.entry.lastPrice,
            lastEffectiveUnitPrice: best.entry.lastEffectiveUnitPrice,
            lastStoreSlug: best.entry.lastStoreSlug,
          },
          gate5Flagged,
        })
        return {
          productKey: best.entry.productKey,
          matchMethod: 'ai',
          matchConfidence: round4(best.score),
          isNew: false,
        }
      }

      if (gate5Flagged) {
        reviewItems.push(
          reviewRecord(item, itemEffective, best.entry, best.method, best.score, 'price_ratio')
        )
      }

      attach(best.entry, item, now)
      counters[best.method]++
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
      counters.verifierPairs = held.length
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
      counters.verifierQuotaExhausted = verdict.quotaExhausted
      held.forEach(
        ({ item, candidate, outcomeIndex, itemEffective, entrySnapshot, gate5Flagged }, i) => {
          const answer = verdict.answers[i]
          const outcome = outcomes[outcomeIndex]!
          if (answer === 'NO') {
            // Not the same product: this sighting founds its own entry (or, if
            // a same-key entry was already founded in this sweep, attaches to
            // it — never resets an existing entry's history). Nothing stays
            // matched, so no review record is emitted (issue #294: the old
            // counter kept verifier-rejected pairs; that inflates the queue
            // with pairs nobody can act on).
            const founded = foundOrAttach(item)
            counters.solo++
            outcome.productKey = founded.productKey
            outcome.matchMethod = 'solo'
            outcome.matchConfidence = 1.0
            outcome.isNew = founded.isNew
            return
          }
          // YES, or unparseable/quota null: keep the match (haqita kept
          // unverifiable pairs and listed them for review). Exactly one record
          // per pair: a null verdict is the more specific reason
          // (verifier_unresolved) and wins over a gate-5 price_ratio flag.
          if (answer === null) {
            reviewItems.push(
              reviewRecord(
                item,
                itemEffective,
                entrySnapshot,
                'ai',
                candidate.score,
                'verifier_unresolved'
              )
            )
            log(`[match] verifier unresolved: "${item.product.name}" vs "${candidate.entry.name}"`)
          } else if (gate5Flagged) {
            reviewItems.push(
              reviewRecord(item, itemEffective, entrySnapshot, 'ai', candidate.score, 'price_ratio')
            )
          }
          attach(candidate.entry, item, now)
          counters.ai++
          outcome.matchMethod = 'ai'
          outcome.matchConfidence = round4(candidate.score)
        }
      )
    } else if (held.length > 0) {
      // Gate 6 disabled: ambiguous candidates keep their embedding-scored
      // match without verification. A gate-5-flagged pair stands unverified —
      // the flag is exactly what the review queue is for.
      for (const { item, candidate, itemEffective, entrySnapshot, gate5Flagged } of held) {
        if (gate5Flagged) {
          reviewItems.push(
            reviewRecord(item, itemEffective, entrySnapshot, 'ai', candidate.score, 'price_ratio')
          )
        }
        attach(candidate.entry, item, now)
        counters.ai++
      }
    }

    return {
      outcomes,
      catalog,
      cache,
      reviewItems,
      stats: { ...counters, reviewItems: reviewItems.length },
    }
  })
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}
