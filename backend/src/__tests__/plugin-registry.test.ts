import { describe, it, expect } from 'vite-plus/test'
// @ts-expect-error — no node types in this tsconfig
import { readdirSync } from 'node:fs'
// @ts-expect-error — no node types in this tsconfig
import { join, dirname } from 'node:path'
// @ts-expect-error — no node types in this tsconfig
import { fileURLToPath } from 'node:url'
import {
  PLUGIN_MANIFESTS,
  pluginManifestById,
  validatePluginManifests,
  type ManifestViolation,
} from '../plugins/manifests.js'
import { CORE_GATEWAY_PREFIXES } from '../plugins/core-prefixes.js'
import { pluginRegistry, matchPlugin } from '../plugins/registry.js'
import type { PluginManifest, PortId } from '../plugins/types.js'

const PLUGINS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../plugins')

function baseManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'tester',
    name: 'Tester',
    version: '0.1.0',
    routePrefix: '/api/tester',
    defaultEnabled: true,
    capabilities: ['purge'],
    ports: [],
    ownedTables: ['tester_rows'],
    ...overrides,
  }
}

// Violations must be attributable: each rule reports the offending manifest.
function violationsOf(...manifests: PluginManifest[]): ManifestViolation[] {
  return validatePluginManifests(manifests)
}

// §1.1 adopt-4: startup manifest validation moved to build time — a
// malformed plugin must fail THIS test, never the runtime. The shipped
// registry must validate clean, and every rule below is exercised through
// synthetic manifests so the validation cannot rot into a no-op.
describe('plugin manifest validation (#435)', () => {
  it('the shipped registry validates clean', () => {
    expect(validatePluginManifests(PLUGIN_MANIFESTS)).toEqual([])
  })

  it('ids are lowercase slugs and unique', () => {
    expect(violationsOf(baseManifest({ id: 'Documents' }))).toHaveLength(1)
    expect(violationsOf(baseManifest({ id: '' }))).toHaveLength(1)
    expect(violationsOf(baseManifest(), baseManifest({ routePrefix: '/api/other' }))).toContain(
      'manifest tester: duplicate id'
    )
  })

  it('versions are semver', () => {
    expect(violationsOf(baseManifest({ version: 'one' }))).toHaveLength(1)
    expect(violationsOf(baseManifest({ version: '0.1.0-beta' }))).toHaveLength(1)
    expect(violationsOf(baseManifest({ version: '10.0.3' }))).toEqual([])
  })

  it('routePrefixes are /api/-rooted, wildcard-free, slash-tidy, and unique', () => {
    expect(violationsOf(baseManifest({ routePrefix: 'api/tester' }))).toHaveLength(1)
    expect(violationsOf(baseManifest({ routePrefix: '/api/tester/' }))).toHaveLength(1)
    expect(violationsOf(baseManifest({ routePrefix: '/api/tester/*' }))).toHaveLength(1)
    expect(
      violationsOf(baseManifest(), baseManifest({ id: 'tester2', routePrefix: '/api/tester' }))
    ).toContain('manifest tester2: duplicate routePrefix')
  })

  it('routePrefixes never claim a core-reserved gateway prefix (#437 S1-A2)', () => {
    // The gateway dispatches the core domains ahead of matchPlugin — a
    // manifest claiming one of their prefixes would be silently shadowed
    // (its routes 404 into the core app forever). The exact prefix, and any
    // subpath of it, are build-time violations; a boundary-neighbor
    // ('/api/plugins-x') is not a collision and stays legal.
    expect(violationsOf(baseManifest({ id: 'catalog', routePrefix: '/api/plugins' }))).toContain(
      'manifest catalog: routePrefix "/api/plugins" collides with the core-reserved prefix /api/plugins (the gateway dispatches core ahead of plugins)'
    )
    expect(
      violationsOf(baseManifest({ id: 'catalog', routePrefix: '/api/plugins/sub' }))
    ).toHaveLength(1)
    expect(
      violationsOf(baseManifest({ id: 'authed', routePrefix: '/api/auth/login' }))
    ).toHaveLength(1)
    for (const corePrefix of CORE_GATEWAY_PREFIXES) {
      expect(violationsOf(baseManifest({ routePrefix: corePrefix }))).toHaveLength(1)
    }
    expect(violationsOf(baseManifest({ routePrefix: '/api/plugins-x' }))).toEqual([])
  })

  it('defaultEnabled is a boolean, capabilities are snake_case and unique', () => {
    expect(violationsOf(baseManifest({ defaultEnabled: 1 as unknown as boolean }))).toHaveLength(1)
    expect(violationsOf(baseManifest({ capabilities: ['Purge'] }))).toHaveLength(1)
    expect(violationsOf(baseManifest({ capabilities: ['purge', 'purge'] }))).toHaveLength(1)
  })

  it('ports reference known ports and never duplicate', () => {
    // An unknown port id is a manifest error the validator must catch even
    // though the PortId union keeps honest manifests honest at compile time.
    expect(
      violationsOf(baseManifest({ ports: ['filesystem'] as unknown as PortId[] }))
    ).toHaveLength(1)
    expect(violationsOf(baseManifest({ ports: ['storage', 'storage'] }))).toHaveLength(1)
    expect(violationsOf(baseManifest({ ports: ['storage'] }))).toEqual([])
  })

  it('ownedTables are declared explicitly and disjoint across plugins', () => {
    // Ownership is the explicit list, never a prefix inference (§4.1) — an
    // empty list is a violation because it silently owns nothing.
    expect(violationsOf(baseManifest({ ownedTables: [] }))).toHaveLength(1)
    expect(
      violationsOf(
        baseManifest(),
        baseManifest({ id: 'tester2', routePrefix: '/api/two', ownedTables: ['tester_rows'] })
      )
    ).toContain('manifest tester2: table "tester_rows" is also owned by tester')
    // Same-table within one manifest is fine (documents owns documents +
    // document_audit, which do not share a prefix on purpose).
    expect(violationsOf(baseManifest({ ownedTables: ['t', 't'] }))).toEqual([])
  })

  it('cron tasks carry a scope (the field exists now so ticket 7 needs no breaking change)', () => {
    expect(violationsOf(baseManifest({ cronTasks: [{ scope: 'household' }] }))).toEqual([])
    expect(
      violationsOf(baseManifest({ cronTasks: [{ scope: 'whenever' as never }] }))
    ).toHaveLength(1)
  })
})

// §4.3: the registry list. Registration order IS dispatch order; the
// prefix match is boundary-aware (the exact semantics the gateway's
// hand-wired documents check had).
describe('plugin registry (#435)', () => {
  it('registers the documents plugin FIRST — it is plugin #1', () => {
    expect(pluginRegistry.length).toBeGreaterThanOrEqual(1)
    expect(pluginRegistry[0].manifest.id).toBe('documents')
  })

  it('every registered manifest is the canonical object (no copies)', () => {
    for (const registration of pluginRegistry) {
      expect(PLUGIN_MANIFESTS).toContain(registration.manifest)
    }
  })

  it('dispatch matches boundary-aware: /api/documents-x never reaches the vault', () => {
    expect(matchPlugin('/api/documents')?.manifest.id).toBe('documents')
    expect(matchPlugin('/api/documents/doc-1/files/f-1/content')?.manifest.id).toBe('documents')
    expect(matchPlugin('/api/documents-x')).toBeUndefined()
    expect(matchPlugin('/api/documentsx')).toBeUndefined()
    // Core domains are not plugins — they stay hand-wired in the gateway.
    expect(matchPlugin('/api/households')).toBeUndefined()
    expect(matchPlugin('/api/me')).toBeUndefined()
    expect(matchPlugin('/api/')).toBeUndefined()
  })

  it('the gate resolves manifests by id and unknown ids answer nothing', () => {
    expect(pluginManifestById('documents')?.routePrefix).toBe('/api/documents')
    expect(pluginManifestById('nope')).toBeUndefined()
  })

  it('every plugins/<id>/ directory is registered exactly once (and vice versa)', () => {
    // T4's re-home is policed here: moving apps/documents.ts under
    // plugins/documents/ keeps this parity; a directory without a
    // registration (or the reverse) fails the build-time check.
    const directories = readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((entry: { isDirectory: () => boolean; name: string }) => entry.isDirectory())
      .map((entry: { name: string }) => entry.name)
    const registeredIds = PLUGIN_MANIFESTS.map((manifest) => manifest.id)
    expect(directories).toEqual(registeredIds)
  })
})
