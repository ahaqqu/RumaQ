// Config port tests — haqita thresholds and the per-store strategy table.

import { describe, expect, it } from 'vite-plus/test'

import { SCRAPE_STORE_SLUGS } from '@rumaq/contract'

import { loadConfig, storeBySlug, storeProxyUrl } from '../src/config.js'
import { createPlugin } from '../src/stores/index.js'

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
    // Assert the shipped defaults, not the ambient shell: GEMINI_MODEL /
    // GEMINI_VERIFIER_MODEL / GEMINI_EMBEDDING_MODEL are documented override
    // knobs — the guard must stay meaningful (and quiet) when they are set.
    const overrideVars = ['GEMINI_MODEL', 'GEMINI_VERIFIER_MODEL', 'GEMINI_EMBEDDING_MODEL']
    const previous = overrideVars.map((name) => process.env[name])
    try {
      for (const name of overrideVars) delete process.env[name]
      const config = loadConfig()
      // gemini-2.5-flash 404'd for new key cohorts (issue #306 live run:
      // NOT_FOUND "no longer available to new users") and plain
      // gemini-3.5-flash has since dropped off Google's current model list —
      // Google's error names gemini-3.8-flash as the successor. Both vision
      // surfaces pin it; the exact pins below double as the no-dead-model
      // guard over every shipped default.
      expect(config.ocr.model).toBe('gemini-3.8-flash')
      expect(config.ocr.verifierModel).toBe('gemini-3.8-flash')
      expect(config.consolidation.embeddingModel).toBe('gemini-embedding-001')
    } finally {
      overrideVars.forEach((name, i) => {
        if (previous[i] !== undefined) process.env[name] = previous[i]!
        else delete process.env[name]
      })
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

// Registration parity guards (issue #322, design-arch §4): a store must
// never be triggerable before it can produce. createPlugin throws for a
// config slug with no branch and activePlugins maps it over EVERY store
// before scope filtering, so a config entry whose plugin was forgotten is a
// whole-nightly crash — caught here, at PR time, on both axes.
describe('registration parity (issue #322)', () => {
  it('config ⇔ registry: every configured store builds a plugin', () => {
    for (const store of loadConfig().stores) {
      expect(() => createPlugin(store)).not.toThrow()
    }
  })

  it('contract ⇔ config: SCRAPE_STORE_SLUGS equals the config slug set', () => {
    // Array equality (not set equality) is deliberate: it also pins the two
    // lists to one shared order, so a drift is visible in the diff, not just
    // detectable. A slug in the contract without a producing store is
    // triggerable-but-unimplemented; a store missing from the contract is
    // untriggerable (its Scrape-Now and brochure keys would 404). Both fail.
    expect([...SCRAPE_STORE_SLUGS]).toEqual(loadConfig().stores.map((store) => store.slug))
  })
})
