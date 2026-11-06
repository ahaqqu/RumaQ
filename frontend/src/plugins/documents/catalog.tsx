// The documents plugin's frontend catalog contribution (ahaqqu/RumaQ#436 —
// plugin architecture phase B, docs/plan/plugin-architecture.md §4.3/§4.5).
// The server manifest (backend/src/plugins/documents/manifest.ts) cannot
// carry React, so the nav entry's icon and route live here; the bundles
// share no module graph and the contract between them is plugin IDS only
// (/api/me's enabledPlugins), never objects. registry.test.js pins this
// entry to the server manifest (ids both ways, route under prefix, i18n in
// both locales).
import { IconFolderLock } from '../../components/icons.jsx'
import type { PluginCatalogEntry } from '../types.js'

// `as const satisfies` mirrors the server manifest form — literal types for
// id/navGroup so a typo fails the parity test instead of silently dropping
// the entry from a nav group.
export const documentsCatalog = {
  id: 'documents',
  labelKey: 'nav.documents',
  routePath: '/documents',
  navGroup: 'household',
  icon: IconFolderLock,
  // Mirrors documentsManifest.capabilities — declared for the settings
  // catalog's lifecycle copy (ticket 3); nothing renders them yet.
  capabilities: ['purge', 'export'],
} as const satisfies PluginCatalogEntry
