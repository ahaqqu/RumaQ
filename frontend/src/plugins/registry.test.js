import { describe, it, expect } from 'vite-plus/test'
import { PLUGIN_CATALOG, PLUGIN_NAV_GROUPS, catalogEntryById } from './registry.js'
// The bundles share no module graph, so the parity check reaches into the
// backend's manifest list directly (plan §4.3): manifests.ts is pure data —
// no hono runtime, no React — which keeps this a build-time test, not a
// runtime dependency.
import { PLUGIN_MANIFESTS } from '../../../backend/src/plugins/manifests.js'
import en from '../i18n/locales/en.json'
import id from '../i18n/locales/id.json'

function resolveKey(key, messages) {
  return key.split('.').reduce((node, part) => (node == null ? node : node[part]), messages)
}

describe('frontend plugin catalog parity (plan §4.3)', () => {
  it('has exactly one catalog entry per server manifest id, both ways', () => {
    const catalogIds = PLUGIN_CATALOG.map((entry) => entry.id)
    const serverIds = PLUGIN_MANIFESTS.map((manifest) => manifest.id)
    expect(new Set(catalogIds).size).toBe(catalogIds.length)
    expect([...catalogIds].sort()).toEqual([...serverIds].sort())
  })

  it("keeps every catalog route under its plugin's server route prefix", () => {
    for (const entry of PLUGIN_CATALOG) {
      const manifest = PLUGIN_MANIFESTS.find((m) => m.id === entry.id)
      // The app routes live without the /api prefix the backend dispatches on.
      const apiPath = `/api${entry.routePath}`
      expect(
        apiPath === manifest.routePrefix || apiPath.startsWith(`${manifest.routePrefix}/`)
      ).toBe(true)
    }
  })

  it('declares the same capabilities as the server manifest', () => {
    for (const entry of PLUGIN_CATALOG) {
      const manifest = PLUGIN_MANIFESTS.find((m) => m.id === entry.id)
      expect([...entry.capabilities].sort()).toEqual([...manifest.capabilities].sort())
    }
  })

  it('resolves every label in BOTH locales (en + id are mandatory, §4.6)', () => {
    for (const entry of PLUGIN_CATALOG) {
      expect(typeof resolveKey(entry.labelKey, en)).toBe('string')
      expect(typeof resolveKey(entry.labelKey, id)).toBe('string')
    }
  })

  it('renders every entry into a nav group the shell actually wires', () => {
    for (const entry of PLUGIN_CATALOG) {
      expect(PLUGIN_NAV_GROUPS).toContain(entry.navGroup)
      expect(entry.routePath.startsWith('/')).toBe(true)
      expect(entry.routePath.endsWith('/')).toBe(false)
    }
  })

  it('resolves entries by id for the route gate', () => {
    expect(catalogEntryById('documents')?.routePath).toBe('/documents')
    expect(catalogEntryById('not-a-plugin')).toBeUndefined()
  })
})
