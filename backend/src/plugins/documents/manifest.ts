// The documents plugin manifest (ahaqqu/RumaQ#435 — plugin architecture phase
// A, docs/plan/plugin-architecture.md §4.3). Phase A DECLARES the vault
// without moving anything: the app still lives at apps/documents.ts (ticket 4
// re-homes it as createDocumentsPlugin), every URL and table is unchanged,
// and behavior is bit-for-bit identical (§3.5 phase A row).
import type { PluginManifest } from '../types.js'

// `as const satisfies` keeps the literal types (`id: 'documents'`, not
// `id: string`) while still checking every field against PluginManifest —
// the annotation form would widen the id and with it PluginId (manifests.ts).
export const documentsManifest = {
  id: 'documents',
  name: 'Documents',
  version: '0.1.0',
  routePrefix: '/api/documents',
  // §8.1: enabled by default. The mechanism no longer depends on the answer —
  // flipping this field changes only households that never expressed a
  // choice (no household_plugins rows exist yet), so decide with the phase-B
  // metrics rather than before them.
  defaultEnabled: true,
  // Lifecycle capabilities (§3.4): purge (ticket 5) and export (ticket 6)
  // surface in the settings catalog (ticket 3). Nothing consumes these in
  // phase A; they are declared because the manifest is the catalog's source.
  capabilities: ['purge', 'export'],
  // StorageAdapter (ports/storage) is the vault's adapter seam — port #1.
  // Declared here even though the app still constructs its R2 adapter inline
  // (three createR2StorageAdapter sites, ticket 4 removes them via
  // PluginPorts injection).
  ports: ['storage'],
  // Declared ownership (§4.1 forbidden-2): disjointness across plugins is
  // tested, never inferred from the <plugin>_ prefix — document_audit
  // deliberately does not share the documents_ prefix.
  ownedTables: ['documents', 'document_files', 'document_audit'],
} as const satisfies PluginManifest
