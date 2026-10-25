// StorePlugin interface — every store is pluggable (docs/plan/haqita-integration.md §1).
// Two capabilities, matching how a store publishes promos:
// - brochure: image pages that need OCR (Superindo, Lotte)
// - catalog:  structured items fetched directly (Astro, Alfamart/Indomaret — future)
//
// All plugin entry points are Effects: failures surface as typed tagged
// errors (FetchError from the strategy ladder) instead of exceptions.

import type { StoreConfig } from '../config.js'
import type { FetchError } from '../fetch/strategy.js'
import type { Effect } from 'effect'

/** A single brochure page image to download and OCR. */
export interface BrochurePage {
  /** Absolute image URL to download. */
  imageUrl: string
  /** Deep-link back to the store's original brochure page (stored on observations). */
  brochureUrl: string
}

export interface FetchContext {
  /** Fetch a document through the store's strategy ladder (§2). */
  fetchHtml(url: string): Effect.Effect<string, FetchError>
  /** RFC-3331 timestamp of the current run (shared by all stages). */
  runStartedAt: string
}

export interface BrochureStorePlugin {
  config: StoreConfig
  listBrochurePages(ctx: FetchContext): Effect.Effect<BrochurePage[], FetchError>
}

export interface CatalogStorePlugin {
  config: StoreConfig
  listItems(ctx: FetchContext): Effect.Effect<CatalogItem[], FetchError>
}

/** Structured item from a catalog-style source — already OCR-free. */
export interface CatalogItem {
  name: string
  brand?: string | null
  unit?: string | null
  price: number
  promoLabel?: string | null
  validFrom?: string | null
  validUntil?: string | null
  pageUrl?: string | null
}

export type StorePlugin = BrochureStorePlugin | CatalogStorePlugin

export function isBrochurePlugin(plugin: StorePlugin): plugin is BrochureStorePlugin {
  return plugin.config.kind === 'brochure'
}
