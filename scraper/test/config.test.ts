// Config port tests — haqita thresholds and the per-store strategy table.

import { describe, expect, it } from 'vite-plus/test'

import { loadConfig, storeBySlug, storeProxyUrl } from '../src/config.js'

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

  it('pins live Gemini model ids — bumping one must be a conscious change', () => {
    const config = loadConfig()
    // gemini-2.5-flash 404'd for new key cohorts (issue #306 live run:
    // NOT_FOUND "no longer available to new users"); Google's error names
    // gemini-3.8-flash as the successor.
    expect(config.ocr.verifierModel).toBe('gemini-3.8-flash')
    expect(config.ocr.model).toBe('gemini-3.5-flash')
    expect(config.consolidation.embeddingModel).toBe('gemini-embedding-001')
    // Sweep guard: no default pin may regress to the deprecated id.
    for (const pinned of [
      config.ocr.model,
      config.ocr.verifierModel,
      config.consolidation.embeddingModel,
    ]) {
      expect(pinned).not.toBe('gemini-2.5-flash')
    }
  })

  it('pins superindo to the plain strategy and lotte to the browser tier', () => {
    const config = loadConfig()
    expect(storeBySlug(config, 'superindo')!.strategy).toBe('plain')
    expect(storeBySlug(config, 'lotte-mart')!.strategy).toBe('browser')
  })

  it('keeps haqita lotte.py en-US Accept-Language override verbatim', () => {
    const config = loadConfig()
    expect(storeBySlug(config, 'lotte-mart')!.headerOverrides).toEqual({
      'Accept-Language': 'en-US,en;q=0.5',
    })
    expect(storeBySlug(config, 'superindo')!.headerOverrides).toBeUndefined()
  })

  it('caps pages per store as a Gemini quota guard', () => {
    for (const store of loadConfig().stores) {
      expect(store.maxPages).toBeGreaterThan(0)
      expect(store.maxPages).toBeLessThanOrEqual(50)
    }
  })

  it('reads the Tier-3 proxy from the store env var, empty counting as unset', () => {
    const lotte = storeBySlug(loadConfig(), 'lotte-mart')!
    const previous = process.env.LOTTE_PROXY_URL
    try {
      delete process.env.LOTTE_PROXY_URL
      expect(storeProxyUrl(lotte)).toBeUndefined()
      // An empty value means "no credentials configured" — the by-design
      // needs-proxy skip must see it as unset, never as a working proxy.
      process.env.LOTTE_PROXY_URL = ''
      expect(storeProxyUrl(lotte)).toBeUndefined()
      // Whitespace-only is equally unconfigured (env-file edit leftovers).
      process.env.LOTTE_PROXY_URL = '  '
      expect(storeProxyUrl(lotte)).toBeUndefined()
      process.env.LOTTE_PROXY_URL = 'http://residential-proxy.example:8080'
      expect(storeProxyUrl(lotte)).toBe('http://residential-proxy.example:8080')
    } finally {
      if (previous !== undefined) process.env.LOTTE_PROXY_URL = previous
      else delete process.env.LOTTE_PROXY_URL
    }
  })
})
