// Catalog-matcher behavior tests — the orchestrator is NEW vs haqita
// (canonical catalog instead of lotte×superindo pairwise), so these pin the
// redesign's contract: same-run cross-store matching, held-pair verification,
// degradation postures, and catalog bookkeeping.

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import { allGates, type MatchGateConfig } from '../../src/match/gates.js'
import { cosineSimilarity, emptyCache, type EmbeddingClient } from '../../src/match/embedding.js'
import {
  emptyCatalog,
  runMatch,
  type MatchDeps,
  type MatchInputItem,
} from '../../src/match/matcher.js'
import type { GeminiClient } from '../../src/ocr/gemini.js'
import type { ValidatedProduct } from '../../src/ocr/parse.js'

function product(over: Partial<ValidatedProduct> = {}): ValidatedProduct {
  return {
    name: 'Indomie Goreng',
    brand: 'Indomie',
    unit: '85 g',
    price: 3500,
    promo: null,
    period: null,
    ocrRawPrice: '3500',
    imageSource: 'page-001.jpg',
    ...over,
  }
}

const CFG: MatchGateConfig = {
  tokenJaccardMin: 0.3,
  embeddingAutoMatch: 0.85,
  embeddingAmbiguousLow: 0.55,
  unitTolerancePct: 15,
  priceRatioMax: 3.0,
  gates: allGates(),
}

/** Deterministic 2-D embedding client: name → vector by lookup table. */
function embedClient(vectors: Record<string, number[]>): EmbeddingClient {
  return {
    models: {
      embedContent: async ({ contents }: { contents: string[] }) => ({
        embeddings: contents.map((text) => ({ values: vectors[text] ?? [1, 0] })),
      }),
    },
  }
}

function verifyClient(replies: string[]): GeminiClient & { calls: number } {
  const client = {
    calls: 0,
    models: {
      generateContent: async () => {
        const reply = replies[Math.min(client.calls, replies.length - 1)]
        client.calls++
        return { text: reply }
      },
    },
  }
  return client
}

function deps(over: Partial<MatchDeps> = {}): MatchDeps {
  return {
    cfg: CFG,
    embeddingModel: 'test-embedding',
    verifierModel: 'test-verifier',
    verifierRetries: 2,
    storeNames: { superindo: 'Superindo', 'lotte-mart': 'Lotte' },
    log: () => {},
    ...over,
  }
}

function run(items: MatchInputItem[], d: MatchDeps, catalog = emptyCatalog()) {
  return Effect.runPromise(
    runMatch(items, catalog, emptyCache('test-embedding'), d, '2026-10-25T23:00:00Z')
  )
}

describe('runMatch — catalog founding and same-run cross-store matching', () => {
  it('first sightings found entries; an identical later item matches exact', async () => {
    const first: MatchInputItem = { storeSlug: 'superindo', product: product() }
    const second: MatchInputItem = { storeSlug: 'lotte-mart', product: product() }
    const { outcomes, catalog, stats } = await run([first, second], deps())

    expect(outcomes[0]).toMatchObject({ matchMethod: 'solo', isNew: true })
    expect(outcomes[1]).toMatchObject({ matchMethod: 'exact', isNew: false })
    expect(outcomes[1]!.productKey).toBe(outcomes[0]!.productKey)
    expect(stats.exact).toBe(1)
    expect(stats.solo).toBe(1)
    const entry = catalog.entries[outcomes[0]!.productKey]!
    expect(entry.storesFound).toEqual(['superindo', 'lotte-mart'])
    expect(entry.appearanceCount).toBe(2)
  })

  it('different brands never match (gate 1) and found separate entries', async () => {
    const a: MatchInputItem = { storeSlug: 'superindo', product: product() }
    const b: MatchInputItem = {
      storeSlug: 'lotte-mart',
      product: product({ name: 'Indomie Goreng', brand: 'Supermi' }),
    }
    const { outcomes } = await run([a, b], deps())
    expect(outcomes[0]!.matchMethod).toBe('solo')
    expect(outcomes[1]!.matchMethod).toBe('solo')
    expect(outcomes[1]!.productKey).not.toBe(outcomes[0]!.productKey)
  })
})

describe('runMatch — embedding tier', () => {
  it('auto-matches above the threshold via embeddings', async () => {
    const vectors = {
      'Indomie Goreng': [1, 0],
      'Indomie Goreng Spesial': [1, 0],
    }
    // Seed the catalog with one sighting, then match a name that only the
    // embedding tier can bridge (tokens differ → gate 2 needs a shared token).
    const seeded = emptyCatalog()
    const seed: MatchInputItem = {
      storeSlug: 'superindo',
      product: product({ name: 'Indomie Goreng Spesial' }),
    }
    await run([seed], deps({ embedClient: embedClient(vectors) }), seeded)

    const fresh: MatchInputItem = { storeSlug: 'lotte-mart', product: product() }
    const { outcomes, stats } = await run(
      [fresh],
      deps({ embedClient: embedClient(vectors) }),
      seeded
    )
    expect(outcomes[0]!.matchMethod).toBe('embedding')
    expect(outcomes[0]!.matchConfidence).toBeCloseTo(1.0, 4)
    expect(stats.embedding).toBe(1)
  })

  it('degrades to exact-only when embeddings are unavailable', async () => {
    const embedFails: EmbeddingClient = {
      models: {
        embedContent: async () => {
          throw new Error('no network')
        },
      },
    }
    const seeded = emptyCatalog()
    const seed: MatchInputItem = {
      storeSlug: 'superindo',
      product: product({ name: 'Indomie Goreng Spesial' }),
    }
    await run([seed], deps({ embedClient: embedFails }), seeded)

    const fresh: MatchInputItem = { storeSlug: 'lotte-mart', product: product() }
    const { outcomes, stats } = await run([fresh], deps({ embedClient: embedFails }), seeded)
    expect(stats.embeddingsDegraded).toBe(true)
    expect(outcomes[0]!.matchMethod).toBe('solo')
  })
})

describe('runMatch — AI verifier (gate 6)', () => {
  const vectors = {
    'Indomie Goreng': [1, 0],
    'Indomie Goreng Kuah': [1, 1], // cos = 0.707 → ambiguous band
    'Indomie Goreng Sedap': [1, 1],
  }

  function seedCatalog() {
    const seeded = emptyCatalog()
    const seed: MatchInputItem = { storeSlug: 'superindo', product: product() }
    return run([seed], deps({ embedClient: embedClient(vectors) }), seeded).then(() => seeded)
  }

  it('YES keeps the ambiguous match as ai', async () => {
    const seeded = await seedCatalog()
    const verifier = verifyClient(['YES'])
    const item: MatchInputItem = {
      storeSlug: 'lotte-mart',
      product: product({ name: 'Indomie Goreng Kuah' }),
    }
    const { outcomes, stats } = await run(
      [item],
      deps({ embedClient: embedClient(vectors), verifyClient: verifier }),
      seeded
    )
    expect(outcomes[0]!.matchMethod).toBe('ai')
    expect(stats.ai).toBe(1)
    expect(verifier.calls).toBe(1)
  })

  it('NO rejects the pair — the sighting founds its own entry', async () => {
    const seeded = await seedCatalog()
    const verifier = verifyClient(['NO'])
    const item: MatchInputItem = {
      storeSlug: 'lotte-mart',
      product: product({ name: 'Indomie Goreng Kuah' }),
    }
    const { outcomes, stats, catalog } = await run(
      [item],
      deps({ embedClient: embedClient(vectors), verifyClient: verifier }),
      seeded
    )
    expect(outcomes[0]!.matchMethod).toBe('solo')
    expect(outcomes[0]!.isNew).toBe(true)
    expect(stats.ai).toBe(0)
    expect(Object.keys(catalog.entries)).toHaveLength(2)
  })

  it('two identical NO-verdict sightings share one entry — the second attaches, never resets history', async () => {
    const seeded = await seedCatalog()
    const verifier = verifyClient(['NO', 'NO'])
    const a: MatchInputItem = {
      storeSlug: 'superindo',
      product: product({ name: 'Indomie Goreng Kuah' }),
    }
    const b: MatchInputItem = {
      storeSlug: 'lotte-mart',
      product: product({ name: 'Indomie Goreng Kuah' }),
    }
    const { outcomes, catalog } = await run(
      [a, b],
      deps({ embedClient: embedClient(vectors), verifyClient: verifier }),
      seeded
    )
    expect(verifier.calls).toBe(2)
    // Both sightings solo-resolve onto the SAME canonical entry (same
    // name/brand/unit → same product key). The second must attach to the
    // entry the first founded — overwriting it would reset appearanceCount
    // back to 1 and drop the first sighting's store.
    expect(outcomes[0]).toMatchObject({ matchMethod: 'solo', isNew: true })
    expect(outcomes[1]).toMatchObject({ matchMethod: 'solo', isNew: false })
    expect(outcomes[1]!.productKey).toBe(outcomes[0]!.productKey)
    const founded = catalog.entries[outcomes[0]!.productKey]!
    expect(founded.appearanceCount).toBe(2)
    expect(founded.storesFound).toEqual(['superindo', 'lotte-mart'])
    // The seeded entry plus the one founded entry — nothing duplicated.
    expect(Object.keys(catalog.entries)).toHaveLength(2)
  })

  it('an unparseable verdict keeps the match and flags review (haqita behavior)', async () => {
    const seeded = await seedCatalog()
    const verifier = verifyClient(['MAYBE'])
    const item: MatchInputItem = {
      storeSlug: 'lotte-mart',
      product: product({ name: 'Indomie Goreng Kuah' }),
    }
    const { outcomes, stats } = await run(
      [item],
      deps({ embedClient: embedClient(vectors), verifyClient: verifier }),
      seeded
    )
    expect(outcomes[0]!.matchMethod).toBe('ai')
    expect(stats.reviewItems).toBe(1)
  })

  it('quota exhaustion stops the sweep and keeps pairs matched', async () => {
    const seeded = await seedCatalog()
    const verifier = verifyClient([])
    verifier.models.generateContent = async () => {
      throw new Error(
        '429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric GenerateRequests per day'
      )
    }
    const items: MatchInputItem[] = [
      { storeSlug: 'lotte-mart', product: product({ name: 'Indomie Goreng Kuah' }) },
      { storeSlug: 'lotte-mart', product: product({ name: 'Indomie Goreng Sedap' }) },
    ]
    const { outcomes, stats } = await run(
      items,
      deps({ embedClient: embedClient(vectors), verifyClient: verifier }),
      seeded
    )
    expect(stats.verifierQuotaExhausted).toBe(true)
    for (const outcome of outcomes) expect(outcome.matchMethod).toBe('ai')
  })
})

describe('runMatch — price plausibility (gate 5)', () => {
  it('flags an implausible ratio for review but keeps the match', async () => {
    const seeded = emptyCatalog()
    const seed: MatchInputItem = {
      storeSlug: 'superindo',
      product: product({ price: 3500, promo: null }),
    }
    await run([seed], deps(), seeded)

    const expensive: MatchInputItem = {
      storeSlug: 'lotte-mart',
      product: product({ price: 35000 }),
    }
    const { outcomes, stats, reviewItems } = await run([expensive], deps(), seeded)
    expect(outcomes[0]!.matchMethod).toBe('exact')
    expect(stats.reviewItems).toBe(1)
    // Issue #294: the flag now carries the pair data (A = incoming item,
    // B = the catalog entry's pre-attach last sighting).
    expect(reviewItems).toHaveLength(1)
    expect(reviewItems[0]).toMatchObject({
      itemProductKey: 'indomie-goreng--indomie--85-g',
      itemName: 'Indomie Goreng',
      itemBrand: 'Indomie',
      itemUnit: '85 g',
      itemPrice: 35000,
      itemEffectiveUnitPrice: 35000,
      itemStore: 'lotte-mart',
      entryProductKey: 'indomie-goreng--indomie--85-g',
      entryName: 'Indomie Goreng',
      entryPrice: 3500,
      entryStore: 'superindo',
      matchMethod: 'exact',
      confidence: 1.0,
      reason: 'price_ratio',
    })
  })

  it('freezes the B-side evidence at flag time — a later attach in the same sweep does not leak in', async () => {
    const vectors = {
      'Indomie Goreng': [1, 0],
      'Indomie Goreng Kuah': [1, 1], // cos = 0.707 → ambiguous band
    }
    const seeded = emptyCatalog()
    const seed: MatchInputItem = {
      storeSlug: 'superindo',
      product: product({ price: 3500, promo: null }),
    }
    await run([seed], deps(), seeded)

    // The flagged item holds for the verifier (snapshot taken at hold time),
    // THEN an exact sighting attaches and rewrites the entry's lastPrice —
    // by resolution time the entry says 2000, but the record must still show
    // the 3500 the gate actually judged.
    const flagged: MatchInputItem = {
      storeSlug: 'lotte-mart',
      product: product({ name: 'Indomie Goreng Kuah', price: 35000 }),
    }
    const cheaper: MatchInputItem = {
      storeSlug: 'lotte-mart',
      product: product({ price: 2000 }),
    }
    const { reviewItems } = await run(
      [flagged, cheaper],
      deps({ embedClient: embedClient(vectors), verifyClient: verifyClient(['YES']) }),
      seeded
    )
    expect(reviewItems).toHaveLength(1)
    expect(reviewItems[0]).toMatchObject({ entryPrice: 3500, itemPrice: 35000 })
  })

  it('emits an embedding-method flag with its score', async () => {
    const vectors = {
      'Indomie Goreng': [1, 0],
      'Indomie Goreng Spesial': [1, 0],
    }
    const seeded = emptyCatalog()
    const seed: MatchInputItem = {
      storeSlug: 'superindo',
      product: product({ name: 'Indomie Goreng Spesial', price: 3500 }),
    }
    await run([seed], deps({ embedClient: embedClient(vectors) }), seeded)

    const fresh: MatchInputItem = {
      storeSlug: 'lotte-mart',
      product: product({ price: 35000 }),
    }
    const { reviewItems, stats } = await run(
      [fresh],
      deps({ embedClient: embedClient(vectors) }),
      seeded
    )
    expect(stats.reviewItems).toBe(1)
    expect(reviewItems[0]).toMatchObject({
      matchMethod: 'embedding',
      reason: 'price_ratio',
      entryProductKey: 'indomie-goreng-spesial--indomie--85-g',
    })
  })
})

describe('runMatch — review emission (issue #294)', () => {
  const vectors = {
    'Indomie Goreng': [1, 0],
    'Indomie Goreng Kuah': [1, 1], // cos = 0.707 → ambiguous band
  }

  function seedCatalog() {
    const seeded = emptyCatalog()
    const seed: MatchInputItem = { storeSlug: 'superindo', product: product() }
    return run([seed], deps({ embedClient: embedClient(vectors) }), seeded).then(() => seeded)
  }

  it('a gate-5 AI flag resolved YES emits one price_ratio record', async () => {
    const seeded = await seedCatalog()
    const item: MatchInputItem = {
      storeSlug: 'lotte-mart',
      product: product({ name: 'Indomie Goreng Kuah', price: 35000 }),
    }
    const { reviewItems, stats } = await run(
      [item],
      deps({ embedClient: embedClient(vectors), verifyClient: verifyClient(['YES']) }),
      seeded
    )
    expect(stats.reviewItems).toBe(1)
    expect(reviewItems).toHaveLength(1)
    expect(reviewItems[0]).toMatchObject({
      matchMethod: 'ai',
      reason: 'price_ratio',
      itemPrice: 35000,
      entryName: 'Indomie Goreng',
      entryPrice: 3500,
    })
  })

  it('a gate-5 AI flag resolved NO emits nothing — the pair was split', async () => {
    const seeded = await seedCatalog()
    const item: MatchInputItem = {
      storeSlug: 'lotte-mart',
      product: product({ name: 'Indomie Goreng Kuah', price: 35000 }),
    }
    const { reviewItems, stats } = await run(
      [item],
      deps({ embedClient: embedClient(vectors), verifyClient: verifyClient(['NO']) }),
      seeded
    )
    expect(stats.reviewItems).toBe(0)
    expect(reviewItems).toHaveLength(0)
  })

  it('a verifier-null verdict on a gate-5-flagged pair counts ONCE as verifier_unresolved', async () => {
    // Pins the double-count fix: the old code incremented reviewItems at the
    // gate-5 site AND at the null resolution — one pair, two counts.
    const seeded = await seedCatalog()
    const item: MatchInputItem = {
      storeSlug: 'lotte-mart',
      product: product({ name: 'Indomie Goreng Kuah', price: 35000 }),
    }
    const { reviewItems, stats } = await run(
      [item],
      deps({ embedClient: embedClient(vectors), verifyClient: verifyClient(['MAYBE']) }),
      seeded
    )
    expect(stats.reviewItems).toBe(1)
    expect(reviewItems).toHaveLength(1)
    expect(reviewItems[0]).toMatchObject({ matchMethod: 'ai', reason: 'verifier_unresolved' })
  })

  it('a verifier-null verdict without a gate-5 flag emits verifier_unresolved', async () => {
    const seeded = await seedCatalog()
    const item: MatchInputItem = {
      storeSlug: 'lotte-mart',
      product: product({ name: 'Indomie Goreng Kuah' }),
    }
    const { reviewItems, stats } = await run(
      [item],
      deps({ embedClient: embedClient(vectors), verifyClient: verifyClient(['MAYBE']) }),
      seeded
    )
    expect(stats.reviewItems).toBe(1)
    expect(reviewItems[0]).toMatchObject({ reason: 'verifier_unresolved' })
  })

  it('a gate-5 AI flag with gate 6 disabled emits price_ratio (the match stands unverified)', async () => {
    const seeded = await seedCatalog()
    const item: MatchInputItem = {
      storeSlug: 'lotte-mart',
      product: product({ name: 'Indomie Goreng Kuah', price: 35000 }),
    }
    const cfg: MatchGateConfig = { ...CFG, gates: allGates({ gate6AiVerifier: false }) }
    const { reviewItems, stats } = await run(
      [item],
      deps({ cfg, embedClient: embedClient(vectors) }),
      seeded
    )
    expect(stats.reviewItems).toBe(1)
    expect(reviewItems[0]).toMatchObject({ matchMethod: 'ai', reason: 'price_ratio' })
  })

  it('the derived count invariant holds across a mixed sweep', async () => {
    const seeded = await seedCatalog()
    const items: MatchInputItem[] = [
      // Gate-5 exact flag (matched, attaches → entry price becomes 35000).
      { storeSlug: 'lotte-mart', product: product({ price: 35000 }) },
      // Ambiguous pair, gate-5-flagged against the mutated entry price,
      // resolved null by the verifier (matched, unresolved).
      { storeSlug: 'lotte-mart', product: product({ name: 'Indomie Goreng Kuah', price: 3500 }) },
      // Ambiguous pair at a plausible price, rejected by the verifier
      // (split — never emitted).
      {
        storeSlug: 'lotte-mart',
        product: product({ name: 'Indomie Goreng Sedap', price: 3500 }),
      },
    ]
    const { reviewItems, stats } = await run(
      items,
      deps({
        embedClient: embedClient({
          ...vectors,
          'Indomie Goreng Sedap': [1, 1],
        }),
        verifyClient: verifyClient(['MAYBE', 'NO']),
      }),
      seeded
    )
    expect(reviewItems).toHaveLength(2)
    expect(stats.reviewItems).toBe(reviewItems.length)
    expect(reviewItems.map((record) => record.reason).sort()).toEqual([
      'price_ratio',
      'verifier_unresolved',
    ])
  })
})

describe('cosineSimilarity', () => {
  it('is 1 for parallel, 0 for orthogonal, in between otherwise', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1.0)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0)
    expect(cosineSimilarity([1, 0], [1, 1])).toBeCloseTo(Math.SQRT1_2)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})
