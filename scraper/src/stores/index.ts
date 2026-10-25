// Store registry — plugins are keyed by slug from config.

import type { ScraperConfig, StoreConfig } from '../config.js'
import { createSuperindoPlugin } from './superindo.js'
import type { StorePlugin } from './types.js'

export function createPlugin(config: StoreConfig): StorePlugin {
  switch (config.slug) {
    case 'superindo':
      return createSuperindoPlugin(config)
    case 'lotte-mart':
      // PR3: Playwright Tier-2 strategy + lotte plugin.
      throw new Error(`Store plugin "${config.slug}" lands in PR3 (Tier-2 fetch).`)
    default:
      throw new Error(`No plugin registered for store "${config.slug}".`)
  }
}

export function activePlugins(config: ScraperConfig): StorePlugin[] {
  // PR2 runs the Superindo pipeline only.
  return config.stores.filter((s) => s.slug === 'superindo').map(createPlugin)
}
