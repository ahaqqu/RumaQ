// Plugin manifest list + validation (ahaqqu/RumaQ#435 — plugin architecture
// phase A, docs/plan/plugin-architecture.md §4.3). Core must know WHICH
// plugins exist (it must, to dispatch) but carries zero feature logic for
// any of them (§2). This module is manifest DATA only — it must never import
// a plugin app; the registry (registry.ts) is the single composition point
// that binds manifests to apps, and the gate (gate.ts) reads manifests from
// here so it never pulls the apps in.
import { documentsManifest } from './documents/manifest.js'
import { KNOWN_PORT_IDS, type PluginManifest } from './types.js'

/** Registration order IS dispatch order — the documents plugin is plugin #1.
 * `as const satisfies` keeps each manifest's `id` a literal (the annotation
 * form would widen it to string), so the derived union below is real. */
export const PLUGIN_MANIFESTS = [documentsManifest] as const satisfies readonly PluginManifest[]

/** Compile-time plugin ids (derived from the list — adding a plugin extends
 * the union automatically, and a typo'd id in pluginGate(...) or a manifest
 * reference fails `tsc`). */
export type PluginId = (typeof PLUGIN_MANIFESTS)[number]['id']

const manifestsById = new Map<string, PluginManifest>(
  PLUGIN_MANIFESTS.map((manifest) => [manifest.id, manifest])
)

/** Request-time manifest lookup for the gate (gate.ts must not import
 * registry.ts — registry imports the apps, and the apps import the gate;
 * this lookup keeps that cycle impossible). */
export function pluginManifestById(id: string): PluginManifest | undefined {
  return manifestsById.get(id)
}

/** One rule the validation found, ready to fail the build/test with. */
export type ManifestViolation = string

const ID_PATTERN = /^[a-z][a-z0-9_]*$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const CAPABILITY_PATTERN = /^[a-z0-9_]+$/

// Pure manifest validation (§1.1 adopt-4: startup manifest validation moved
// to build time — a malformed plugin must fail the build, never the runtime).
// Returns every violation; an empty list is the only passing state. Exercised
// per-rule by plugin-registry.test.ts.
export function validatePluginManifests(manifests: readonly PluginManifest[]): ManifestViolation[] {
  const violations: ManifestViolation[] = []
  const seenIds = new Set<string>()
  const seenPrefixes = new Set<string>()
  const tableOwners = new Map<string, string>()

  for (const manifest of manifests) {
    const label = `manifest ${manifest.id || '<missing id>'}`

    if (!manifest.id || !ID_PATTERN.test(manifest.id)) {
      violations.push(`${label}: id must be a lowercase slug (got ${JSON.stringify(manifest.id)})`)
    }
    if (seenIds.has(manifest.id)) {
      violations.push(`${label}: duplicate id`)
    }
    seenIds.add(manifest.id)

    if (!VERSION_PATTERN.test(manifest.version)) {
      violations.push(`${label}: version must be semver (got ${JSON.stringify(manifest.version)})`)
    }

    if (!manifest.routePrefix.startsWith('/api/') || manifest.routePrefix.endsWith('/')) {
      violations.push(
        `${label}: routePrefix must start with '/api/' and have no trailing slash (got ${JSON.stringify(manifest.routePrefix)})`
      )
    }
    if (/[*?]/.test(manifest.routePrefix)) {
      violations.push(`${label}: routePrefix must not contain wildcards`)
    }
    if (seenPrefixes.has(manifest.routePrefix)) {
      violations.push(`${label}: duplicate routePrefix`)
    }
    seenPrefixes.add(manifest.routePrefix)

    if (typeof manifest.defaultEnabled !== 'boolean') {
      violations.push(`${label}: defaultEnabled must be a boolean`)
    }

    const seenCapabilities = new Set<string>()
    for (const capability of manifest.capabilities) {
      if (!CAPABILITY_PATTERN.test(capability)) {
        violations.push(`${label}: capability ${JSON.stringify(capability)} must be snake_case`)
      }
      if (seenCapabilities.has(capability)) {
        violations.push(`${label}: duplicate capability ${JSON.stringify(capability)}`)
      }
      seenCapabilities.add(capability)
    }

    const seenPorts = new Set<string>()
    for (const port of manifest.ports) {
      if (!(KNOWN_PORT_IDS as readonly string[]).includes(port)) {
        violations.push(
          `${label}: port ${JSON.stringify(port)} is not a known port (known: ${KNOWN_PORT_IDS.join(', ')})`
        )
      }
      if (seenPorts.has(port)) {
        violations.push(`${label}: duplicate port ${JSON.stringify(port)}`)
      }
      seenPorts.add(port)
    }

    if (manifest.ownedTables.length === 0) {
      violations.push(`${label}: ownedTables must be declared explicitly (never inferred)`)
    }
    for (const table of manifest.ownedTables) {
      const owner = tableOwners.get(table)
      if (owner && owner !== manifest.id) {
        violations.push(`${label}: table ${JSON.stringify(table)} is also owned by ${owner}`)
      } else {
        tableOwners.set(table, manifest.id)
      }
    }

    for (const task of manifest.cronTasks ?? []) {
      if (task.scope !== 'global' && task.scope !== 'household') {
        violations.push(`${label}: cron task scope must be 'global' or 'household'`)
      }
    }
  }

  return violations
}
