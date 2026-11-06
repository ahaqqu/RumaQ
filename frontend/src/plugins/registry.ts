// Frontend plugin catalog registry (ahaqqu/RumaQ#436 — plugin architecture
// phase B, docs/plan/plugin-architecture.md §4.3/§4.5). Core composes every
// plugin's static catalog entry into one list; plugins never edit AppShell.jsx
// — the shell renders what this catalog contributes, filtered by enablement
// in context.jsx. This module is manifest DATA only (like the server's
// manifests.ts): it must never import a page or a route, and the provider
// (context.jsx) reads entries from here so the composition stays one place.
import { documentsCatalog } from './documents/catalog.js'
import type { PluginCatalogEntry, PluginNavGroup } from './types.js'

/** Registration order IS render order within a nav group — the documents
 * plugin is plugin #1, mirroring the server's PLUGIN_MANIFESTS ordering. */
export const PLUGIN_CATALOG = [documentsCatalog] as const satisfies readonly PluginCatalogEntry[]

/** Compile-time plugin ids derived from the list — a catalog id that no
 * server manifest declares fails registry.test.js's parity check. */
export type CatalogPluginId = (typeof PLUGIN_CATALOG)[number]['id']

// §8.3 UI naming decision (recorded here for ticket 3's settings catalog,
// which renders the section): en "Features" / id "Fitur". "Plugins" is
// developer vocabulary; "Add-ons"/"Modul" either imply paid extras or stay
// technical for a household app whose plugins are first-party built-ins.

/** The nav groups the shell actually renders plugin entries into (AppShell's
 * NAV / HOUSEHOLD_NAV / ADMIN_NAV groups). A catalog entry outside this set
 * would silently never render, so the provider folds on this list and
 * registry.test.js pins every entry's navGroup against it. `satisfies` ties
 * the list to the PluginNavGroup union it mirrors — the two fail tsc instead
 * of drifting apart silently. */
export const PLUGIN_NAV_GROUPS = [
  'main',
  'household',
  'admin',
] as const satisfies readonly PluginNavGroup[]

const catalogById = new Map<string, PluginCatalogEntry>(
  PLUGIN_CATALOG.map((entry) => [entry.id, entry])
)

/** Lookup for the route gate (PluginGate.jsx) and future settings panels —
 * never imports a plugin page, so no cycle. */
export function catalogEntryById(id: string): PluginCatalogEntry | undefined {
  return catalogById.get(id)
}
