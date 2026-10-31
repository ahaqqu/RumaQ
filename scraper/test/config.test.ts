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

  it('ships the full ordered 5-rung vision chain on both surfaces (issue #347)', () => {
    // Assert the shipped defaults, not the ambient shell: the GEMINI_* model
    // vars are documented override knobs — the guard must stay meaningful
    // (and quiet) when they are set.
    const overrideVars = [
      'GEMINI_MODEL',
      'GEMINI_MODEL_CHAIN',
      'GEMINI_VERIFIER_MODEL',
      'GEMINI_VERIFIER_MODEL_CHAIN',
      'GEMINI_EMBEDDING_MODEL',
    ]
    const previous = overrideVars.map((name) => process.env[name])
    try {
      for (const name of overrideVars) delete process.env[name]
      const config = loadConfig()
      // The owner's binding chain (issue #347), IN ORDER — order is
      // load-bearing: the head is the quality pin (gemini-3.8-flash, the
      // successor Google's deprecation error named in issue #306), the rungs
      // behind it are capacity, the lite tail carries the 500/day budget.
      // Dead rungs skip on 404, so a cohort-absent id is harmless.
      expect(config.ocr.modelChain).toEqual([
        'gemini-3.8-flash',
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'gemini-3.5-flash-lite',
      ])
      expect(config.ocr.verifierModelChain).toEqual([
        'gemini-3.8-flash',
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'gemini-3.5-flash-lite',
      ])
      expect(config.consolidation.embeddingModel).toBe('gemini-embedding-001')
    } finally {
      overrideVars.forEach((name, i) => {
        if (previous[i] !== undefined) process.env[name] = previous[i]!
        else delete process.env[name]
      })
    }
  })

  it('parses a GEMINI_MODEL_CHAIN override as a trimmed, ordered, wholesale replacement', () => {
    const previous = {
      chain: process.env.GEMINI_MODEL_CHAIN,
      scalar: process.env.GEMINI_MODEL,
    }
    try {
      delete process.env.GEMINI_MODEL
      process.env.GEMINI_MODEL_CHAIN = 'model-a, model-b'
      expect(loadConfig().ocr.modelChain).toEqual(['model-a', 'model-b'])
    } finally {
      if (previous.chain !== undefined) process.env.GEMINI_MODEL_CHAIN = previous.chain
      else delete process.env.GEMINI_MODEL_CHAIN
      if (previous.scalar !== undefined) process.env.GEMINI_MODEL = previous.scalar
      else delete process.env.GEMINI_MODEL
    }
  })

  it('collapses the chain to one rung on a scalar pin — failover off (pin means pin)', () => {
    const previous = process.env.GEMINI_MODEL
    try {
      delete process.env.GEMINI_MODEL_CHAIN
      process.env.GEMINI_MODEL = '  gemini-x  '
      expect(loadConfig().ocr.modelChain).toEqual(['gemini-x'])
    } finally {
      if (previous !== undefined) process.env.GEMINI_MODEL = previous
      else delete process.env.GEMINI_MODEL
    }
  })

  it('chain env beats scalar env; a comma-only chain counts as unset', () => {
    const previous = {
      chain: process.env.GEMINI_MODEL_CHAIN,
      scalar: process.env.GEMINI_MODEL,
    }
    try {
      process.env.GEMINI_MODEL_CHAIN = 'chain-a,chain-b'
      process.env.GEMINI_MODEL = 'scalar-x'
      expect(loadConfig().ocr.modelChain).toEqual(['chain-a', 'chain-b'])
      // A comma-only CHAIN parses to zero models = unset — the precedence
      // falls through to the still-set scalar (chain-of-one), never an
      // error and never a zero-rung chain.
      process.env.GEMINI_MODEL_CHAIN = ','
      expect(loadConfig().ocr.modelChain).toEqual(['scalar-x'])
      // With no scalar either, the unset chain lands on the default.
      delete process.env.GEMINI_MODEL
      expect(loadConfig().ocr.modelChain).toEqual([
        'gemini-3.8-flash',
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'gemini-3.5-flash-lite',
      ])
    } finally {
      if (previous.chain !== undefined) process.env.GEMINI_MODEL_CHAIN = previous.chain
      else delete process.env.GEMINI_MODEL_CHAIN
      if (previous.scalar !== undefined) process.env.GEMINI_MODEL = previous.scalar
      else delete process.env.GEMINI_MODEL
    }
  })

  it('the verifier chain overrides independently of the OCR chain', () => {
    const previous = {
      verifierChain: process.env.GEMINI_VERIFIER_MODEL_CHAIN,
      chain: process.env.GEMINI_MODEL_CHAIN,
    }
    try {
      delete process.env.GEMINI_MODEL_CHAIN
      process.env.GEMINI_VERIFIER_MODEL_CHAIN = 'verify-a'
      const config = loadConfig()
      expect(config.ocr.verifierModelChain).toEqual(['verify-a'])
      expect(config.ocr.modelChain[0]).toBe('gemini-3.8-flash')
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value !== undefined) process.env[name] = value
        else delete process.env[name]
      }
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
