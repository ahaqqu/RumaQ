// Store registry — plugins are keyed by slug from config.

import type { ScraperConfig, StoreConfig } from '../config.js'
import { createAstroPlugin } from './astro.js'
import { createHypermartPlugin } from './hypermart.js'
import { createIndomaretPlugin } from './indomaret.js'
import { createLottePlugin } from './lotte.js'
import { createSuperindoPlugin } from './superindo.js'
import type { StorePlugin } from './types.js'

export function createPlugin(config: StoreConfig): StorePlugin {
  if (config.slug === 'superindo') return createSuperindoPlugin(config)
  if (config.slug === 'lotte-mart') return createLottePlugin(config)
  if (config.slug === 'astro') return createAstroPlugin(config)
  if (config.slug === 'hypermart') return createHypermartPlugin(config)
  if (config.slug === 'indomaret') return createIndomaretPlugin(config)
  // A config/registry mismatch — one guard for both.
  throw new Error(`No plugin registered for store "${config.slug}".`)
}

/**
 * Single source of truth for which stores a run processes: the pipeline
 * derives both its work list and its status map from this list.
 */
export function activePlugins(config: ScraperConfig): StorePlugin[] {
  return config.stores.map(createPlugin)
}

/**
 * Store scope for on-demand runs (docs/plan/scrape-now.md §2): an explicit
 * --stores list narrows the nightly work list. Unknown slugs simply filter
 * out — the pipeline turns an empty result into a typed error, so the run
 * can never "succeed" doing nothing.
 */
export function scopedPlugins(config: ScraperConfig, stores?: string[]): StorePlugin[] {
  if (!stores || stores.length === 0) return activePlugins(config)
  const requested = new Set(stores)
  return activePlugins(config).filter((plugin) => requested.has(plugin.config.slug))
}
