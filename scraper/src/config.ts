// Port of haqita config.yaml + per-store strategy table
// (docs/plan/haqita-integration.md §6). Thresholds and gate flags are
// consumed by the matcher (match/); the strategy table drives the fetch
// ladder.

import { allGates, type GateFlags } from './match/gates.js'
import { parseModelChain } from './util/model-chain.js'

export type FetchStrategy = 'plain' | 'browser'
export type StoreKind = 'brochure' | 'catalog'

export interface StoreConfig {
  slug: string
  name: string
  kind: StoreKind
  /** Which rung of the fetch ladder this store needs (§2). */
  strategy: FetchStrategy
  region: string
  website?: string
  /** Hard cap on pages fetched per run — Gemini quota guard (§9). */
  maxPages: number
  /** Optional per-store proxy (Tier 3), read from this env var when set. */
  proxyEnv?: string
  /**
   * Per-store header overrides merged over DEFAULT_HEADERS on the plain
   * tier (haqita's per-store HEADERS dicts). Accept stays per-request
   * (html vs image) and always wins.
   */
  headerOverrides?: Record<string, string>
}

export interface ScraperConfig {
  ocr: {
    modelChain: string[]
    verifierModelChain: string[]
    maxRetries: number
  }
  consolidation: {
    tokenJaccardMin: number
    embeddingAutoMatch: number
    embeddingAmbiguousLow: number
    unitTolerancePct: number
    priceRatioMax: number
    /** Gemini embedding model replacing haqita's sentence-transformers (§6). */
    embeddingModel: string
    /** AI-verifier retries (config.yaml ai_verifier.max_retries). */
    verifierRetries: number
    /** Per-gate feature flags — port of config.yaml `consolidation.gates`. */
    gates: GateFlags
  }
  novelty: {
    minImageSizeKb: number
    minDimensionPx: number
  }
  stores: StoreConfig[]
}

const env = (name: string, fallback: string): string => process.env[name] ?? fallback

/**
 * The vision failover chain (issue #347), in order. The head is the quality
 * pin — gemini-3.8-flash, the successor Google's own deprecation error named
 * (issue #306). The rungs behind it are capacity: 3.7/3.5 exist per the
 * owner's AI Studio cohort 2026-10-31 though absent from Google's public docs
 * page — a dead rung costs one call and is skipped on 404 — and the lite tail
 * carries the free tier's big 500/day budget. Embeddings keep their own
 * scalar (GEMINI_EMBEDDING_MODEL): separate quota pool, out of scope.
 */
export const DEFAULT_VISION_MODEL_CHAIN = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
] as const

export function loadConfig(): ScraperConfig {
  return {
    ocr: {
      // Chain precedence (parseModelChain): GEMINI_MODEL_CHAIN /
      // GEMINI_VERIFIER_MODEL_CHAIN are the wholesale ordered override; an
      // explicit scalar GEMINI_MODEL / GEMINI_VERIFIER_MODEL pins the chain
      // to one rung — failover off, exactly the pre-#347 override behavior.
      modelChain: parseModelChain(
        process.env.GEMINI_MODEL_CHAIN,
        process.env.GEMINI_MODEL,
        DEFAULT_VISION_MODEL_CHAIN
      ),
      verifierModelChain: parseModelChain(
        process.env.GEMINI_VERIFIER_MODEL_CHAIN,
        process.env.GEMINI_VERIFIER_MODEL,
        DEFAULT_VISION_MODEL_CHAIN
      ),
      maxRetries: 2,
    },
    consolidation: {
      tokenJaccardMin: 0.3,
      embeddingAutoMatch: 0.85,
      embeddingAmbiguousLow: 0.55,
      unitTolerancePct: 15,
      priceRatioMax: 3.0,
      embeddingModel: env('GEMINI_EMBEDDING_MODEL', 'gemini-embedding-001'),
      verifierRetries: 3,
      // allGates() is the single all-on source — a new gate flag must never
      // be remembered here AND in gates.ts separately.
      gates: allGates(),
    },
    novelty: {
      minImageSizeKb: 50,
      minDimensionPx: 300,
    },
    stores: [
      {
        slug: 'superindo',
        name: 'Superindo',
        kind: 'brochure',
        strategy: 'plain',
        region: 'jakarta',
        website: 'https://www.superindo.co.id/',
        maxPages: 40,
        proxyEnv: 'SUPERINDO_PROXY_URL',
      },
      {
        // Lotte sits behind Imperva Incapsula → Tier-2 browser strategy.
        // Plugin lands in PR3; registered now for the reachability gate.
        // haqita's lotte.py overrode Accept-Language to en-US for every
        // plain-tier request (listing + images) — kept verbatim, though the
        // 2026-10-28 probe (see ARCHITECTURE.md) showed even the exact haqita
        // client+headers receives the Incapsula challenge from a Jakarta
        // residential IP today: the override is fidelity, not a bypass.
        slug: 'lotte-mart',
        name: 'Lotte Mart',
        kind: 'brochure',
        strategy: 'browser',
        region: 'jakarta',
        website: 'https://www.lottemart.co.id/',
        maxPages: 40,
        proxyEnv: 'LOTTE_PROXY_URL',
        headerOverrides: { 'Accept-Language': 'en-US,en;q=0.5' },
      },
      {
        // Astro (astronauts.id) — the first catalog store: category pages
        // server-render the inventory JSON, so Tier-1 plain fetch needs no
        // OCR and no API headers. maxPages caps category pages, not images.
        slug: 'astro',
        name: 'Astro',
        kind: 'catalog',
        strategy: 'plain',
        region: 'jakarta',
        website: 'https://www.astronauts.id/',
        maxPages: 10,
      },
      {
        // Hypermart promo-koran — plain WordPress/Elementor page; the weekly
        // koran is ~11 full-page JPGs directly in the static HTML (superindo
        // shape, no PDF step). Zero anti-bot observed 2026-10-30. Filenames
        // (JAWA-N.jpg) are refreshed in place weekly → novelty keys on the
        // content MD5 (fetch/state.ts), never on the URL (cache-control
        // max-age=604800).
        slug: 'hypermart',
        name: 'Hypermart',
        kind: 'brochure',
        strategy: 'plain',
        region: 'jakarta',
        website: 'https://www.hypermart.co.id/',
        maxPages: 40,
        proxyEnv: 'HYPERMART_PROXY_URL',
      },
      {
        // Indomaret promosi — server-rendered WordPress hub; ~10 weekly
        // brochure PDFs behind per-brochure static pages (pdfUrl in the
        // Real3D-Flipbook config). Pages render to 150 DPI PNGs via poppler's
        // pdftoppm (util/pdf.ts) and feed the unchanged OCR flow; maxPages
        // clamps at render time in hub document order (design-arch §1.2).
        // Cloudflare-fronted but unchallenged 2026-10-30; EU-DC IP untested →
        // proxyEnv ready (by-design skip until configured).
        slug: 'indomaret',
        name: 'Indomaret',
        kind: 'brochure',
        strategy: 'plain',
        region: 'jakarta',
        website: 'https://www.indomaret.co.id/',
        maxPages: 40,
        proxyEnv: 'INDOMARET_PROXY_URL',
      },
      {
        // Alfamart (alfagift.id) — Nuxt shell + fingerprint-gated gateway;
        // nothing serves to plain fetch, but an anonymous headless browser
        // renders structured promo product cards (catalog semantics: no
        // OCR, no R2, no novelty state). First catalog+browser combination —
        // maxPages caps campaign detail-page visits (Chromium budget =
        // 1 + maxPages navigations/cycle, design-arch §5). Gateway API out
        // of scope (FingerprintJS).
        slug: 'alfamart',
        name: 'Alfamart',
        kind: 'catalog',
        strategy: 'browser',
        region: 'jakarta',
        website: 'https://alfagift.id/',
        maxPages: 40,
        proxyEnv: 'ALFAMART_PROXY_URL',
      },
    ],
  }
}

export function storeBySlug(config: ScraperConfig, slug: string): StoreConfig | undefined {
  return config.stores.find((store) => store.slug === slug)
}

/**
 * The store's Tier-3 proxy URL, read from its configured env var (§2).
 * An empty or whitespace-only value counts as not configured — the
 * pipeline's by-design needs-proxy skip keys off this, so `LOTTE_PROXY_URL=`
 * must never be treated as a working proxy.
 */
export function storeProxyUrl(store: StoreConfig): string | undefined {
  const url = store.proxyEnv ? process.env[store.proxyEnv]?.trim() : undefined
  return url || undefined
}
