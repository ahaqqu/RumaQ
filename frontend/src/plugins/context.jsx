import { createContext, useContext, useMemo } from 'react'
import { useMe } from '../lib/queries/me.js'
import { PLUGIN_CATALOG, PLUGIN_NAV_GROUPS } from './registry.js'

const PluginCatalogContext = createContext(null)

// The context value is derived straight from the /api/me payload, which is
// keyed to the ACTIVE household (auth resolves it server-side). Household
// switches need no wiring here: useActivateHousehold's settle hook
// invalidates the whole query cache ("every household-scoped view just
// changed"), the ['me'] query is always mounted under AuthGate, so it
// refetches and the derivation below recomputes from the new household's
// enabledPlugins. No stale catalog survives the settle.
function buildCatalogState(me) {
  // The advertisement contract (#435, plan §4.5): /api/me's enabledPlugins
  // is additive and optional — ABSENT means every catalog plugin is enabled.
  // A legacy payload, a stale PWA bundle, a rolled-back API deploy or a
  // failed enablement read (the resolver omits the field) must never hide a
  // surface: enforcement lives in the backend plugin gate (404 fail-closed),
  // so failing open here can never grant access the server would deny. The
  // same contract covers malformed array ELEMENTS ([123], [null]) — they are
  // dropped before the Set, because a Set built from them would miss every
  // string id and fail closed instead. An empty array stays an empty Set:
  // disable-everything is a real enablement state.
  const ids = Array.isArray(me?.enabledPlugins)
    ? me.enabledPlugins.filter((id) => typeof id === 'string')
    : null
  const enabled = ids === null ? null : new Set(ids)

  // Filter ONCE here and feed every render site — the sidebar and the mobile
  // drawer render the filtered nav (filtering per site instead would let
  // mobile keep showing a disabled surface, plan §4.5), while AppShell's
  // page-title lookup reads the unfiltered navAll: a disabled plugin's route
  // stays reachable by deep link, and the header must show the real page
  // name over the gate's turned-off empty state, not the "Home" fallback.
  const nav = {}
  const navAll = {}
  for (const group of PLUGIN_NAV_GROUPS) {
    nav[group] = []
    navAll[group] = []
  }
  for (const entry of PLUGIN_CATALOG) {
    const group = navAll[entry.navGroup]
    // Unreachable while registry.test.js pins every entry's navGroup to
    // PLUGIN_NAV_GROUPS; skipped rather than thrown so one bad entry cannot
    // blank the whole shell.
    if (!group) continue
    // Same shape AppShell's own nav lists use ({ id, key, Icon, to }) so the
    // shell renders core and plugin entries with one renderer.
    const item = { id: entry.id, key: entry.labelKey, Icon: entry.icon, to: entry.routePath }
    group.push(item)
    if (!enabled || enabled.has(entry.id)) nav[entry.navGroup].push(item)
  }

  return {
    nav,
    navAll,
    isEnabled: (pluginId) => !enabled || enabled.has(pluginId),
  }
}

export function PluginCatalogProvider({ children }) {
  const { data: me } = useMe()
  const value = useMemo(() => buildCatalogState(me), [me])
  return <PluginCatalogContext.Provider value={value}>{children}</PluginCatalogContext.Provider>
}

export function usePluginCatalog() {
  const ctx = useContext(PluginCatalogContext)
  if (!ctx) throw new Error('usePluginCatalog must be used within PluginCatalogProvider')
  return ctx
}
