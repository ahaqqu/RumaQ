// Config port tests — haqita thresholds and the per-store strategy table.

import { describe, expect, it } from 'vite-plus/test'

import { loadConfig, storeBySlug } from '../src/config.js'

describe('loadConfig', () => {
  it('carries the haqita consolidation thresholds verbatim', () => {
    const config = loadConfig()
    expect(config.consolidation).toEqual({
      tokenJaccardMin: 0.3,
      embeddingAutoMatch: 0.85,
      embeddingAmbiguousLow: 0.55,
      unitTolerancePct: 15,
      priceRatioMax: 3.0,
      embeddingModel: 'gemini-embedding-001',
      verifierRetries: 3,
      gates: {
        gate0UnitType: true,
        gate1Brand: true,
        gate2TokenJaccard: true,
        gate3ExactMatch: true,
        gate4Embedding: true,
        gate5PricePlausibility: true,
        gate6AiVerifier: true,
      },
    })
  })

  it('keeps the novelty gates from haqita base_scraper defaults', () => {
    expect(loadConfig().novelty).toEqual({ minImageSizeKb: 50, minDimensionPx: 300 })
  })

  it('pins superindo to the plain strategy and lotte to the browser tier', () => {
    const config = loadConfig()
    expect(storeBySlug(config, 'superindo')!.strategy).toBe('plain')
    expect(storeBySlug(config, 'lotte-mart')!.strategy).toBe('browser')
  })

  it('caps pages per store as a Gemini quota guard', () => {
    for (const store of loadConfig().stores) {
      expect(store.maxPages).toBeGreaterThan(0)
      expect(store.maxPages).toBeLessThanOrEqual(50)
    }
  })
})
