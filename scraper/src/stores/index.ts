// Store registry — plugins are keyed by slug from config.

import type { ScraperConfig, StoreConfig } from '../config.js'
import { createLottePlugin } from './lotte.js'
import { createSuperindoPlugin } from './superindo.js'
import type { StorePlugin } from './types.js'

export function createPlugin(config: StoreConfig): StorePlugin {
  if (config.slug === 'superindo') return createSuperindoPlugin(config)
  if (config.slug === 'lotte-mart') return createLottePlugin(config)
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
