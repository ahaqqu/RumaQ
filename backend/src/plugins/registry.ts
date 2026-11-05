// The plugin registry (ahaqqu/RumaQ#435 — plugin architecture phase A,
// docs/plan/plugin-architecture.md §4.3). The ONE core→plugin composition
// surface: core knows which plugins exist (it must, to dispatch) but has
// zero feature logic for any of them (§2). Construction is a factory
// (PluginFactory in types.ts) — phase A registers the existing module-level
// documentsApp as-is; ticket 4 re-homes the app under plugins/documents/ and
// replaces this composition with createDocumentsPlugin({ ports }) so the
// registry can inject ports.storage.
import { documentsApp } from '../apps/documents.js'
import { documentsManifest } from './documents/manifest.js'
import type { PluginRegistration } from './types.js'

export const pluginRegistry: readonly PluginRegistration[] = [
  // Registered FIRST: the vault is plugin #1 (§0). Core domains (auth,
  // households/members) are NOT plugins — they stay hand-wired in the
  // gateway ahead of this loop.
  { manifest: documentsManifest, app: documentsApp },
]

// Boundary-aware prefix match — the exact semantics the gateway's hand-wired
// documents check had (`path === p || path.startsWith(p + '/')`). Without the
// boundary guard, '/api/documents-x' would dispatch into the vault (§4.3).
export function matchPlugin(path: string): PluginRegistration | undefined {
  return pluginRegistry.find(({ manifest }) => {
    const prefix = manifest.routePrefix
    return path === prefix || path.startsWith(`${prefix}/`)
  })
}
