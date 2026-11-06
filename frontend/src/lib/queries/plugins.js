import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getPluginCatalog,
  setPluginEnablement,
  requestPluginPurge,
  cancelPluginPurge,
} from '../api'
import { PLUGIN_CATALOG } from '../../plugins/registry.js'

// The plugin settings catalog (ahaqqu/RumaQ#437 — plugin architecture ticket
// 3, plan §4.5). Keyed to the ACTIVE household server-side; household
// switches need no wiring here — useActivateHousehold's settle hook
// invalidates the whole cache, so this query refetches with the new
// household's posture exactly like ['me'] does.

const PLUGINS_KEY = ['plugin-catalog']

export function usePluginCatalog() {
  return useQuery({
    queryKey: PLUGINS_KEY,
    queryFn: ({ signal }) => getPluginCatalog(signal),
    staleTime: 1000 * 30,
  })
}

// The next /api/me enabledPlugins set after a toggle: the household layer of
// every catalog plugin (the deployment/plan layers never enter the
// advertisement — resolveEnabledPluginIds reads household_plugins only), with
// the toggled plugin forced to its new state. Registry order keeps the list
// stable, and the §4.5 fallbacks apply when a cache is cold: an absent
// enabledPlugins means "all catalog plugins enabled".
function nextEnabledPluginIds(me, catalog, pluginId, status) {
  const base = catalog?.plugins
    ? catalog.plugins.map((p) => (p.enabled ? p.id : null))
    : Array.isArray(me?.enabledPlugins)
      ? me.enabledPlugins.filter((id) => typeof id === 'string')
      : PLUGIN_CATALOG.map((entry) => entry.id)
  const set = new Set(base)
  if (status === 'enabled') set.add(pluginId)
  else set.delete(pluginId)
  return PLUGIN_CATALOG.map((entry) => entry.id).filter((id) => set.has(id))
}

export function useSetPluginEnablement() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ pluginId, status }) => setPluginEnablement(pluginId, status),
    onMutate: async ({ pluginId, status }) => {
      // Optimistic like the household mutations: the toggle reacts at once,
      // in BOTH places the state renders — the catalog rows and the /api/me
      // payload the nav gating derives from (context.jsx). Server response
      // and the settle invalidation reconcile the rest.
      const catalogKey = PLUGINS_KEY
      const meKey = ['me']
      await queryClient.cancelQueries({ queryKey: catalogKey })
      await queryClient.cancelQueries({ queryKey: meKey })
      const previousCatalog = queryClient.getQueryData(catalogKey)
      const previousMe = queryClient.getQueryData(meKey)

      queryClient.setQueryData(catalogKey, (old) =>
        old
          ? {
              plugins: old.plugins.map((p) =>
                p.id === pluginId
                  ? {
                      ...p,
                      enabled: status === 'enabled',
                      source: 'household',
                      available: p.deployment_available && p.plan_entitled && status === 'enabled',
                    }
                  : p
              ),
            }
          : old
      )
      queryClient.setQueryData(meKey, (old) =>
        old
          ? {
              ...old,
              enabledPlugins: nextEnabledPluginIds(old, previousCatalog, pluginId, status),
            }
          : old
      )
      return { previousCatalog, previousMe }
    },
    onError: (_err, _vars, context) => {
      if (context?.previousCatalog !== undefined) {
        queryClient.setQueryData(PLUGINS_KEY, context.previousCatalog)
      }
      if (context?.previousMe !== undefined) {
        queryClient.setQueryData(['me'], context.previousMe)
      }
    },
    onSettled: () => {
      // The toggle is a household fact (it changes nav gating and the gate's
      // 404s for every member) — re-read both caches from the server.
      queryClient.invalidateQueries({ queryKey: PLUGINS_KEY })
      queryClient.invalidateQueries({ queryKey: ['me'] })
    },
  })
}

// The purge initiation (ticket 5, #439): owner-only, typed-confirmation.
// Deliberately NOT optimistic — this marks a destructive job (bytes start
// disappearing over the coming nights), so the UI must never show a purge
// state the server has not confirmed. The settle invalidation re-reads the
// catalog, which carries the purge slice (state + timestamps).
export function useRequestPluginPurge() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ pluginId, confirm }) => requestPluginPurge(pluginId, confirm),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: PLUGINS_KEY })
    },
  })
}

// The purge cancel (P1-A3 fix round, PR #474 review): the owner's release
// lever for a drain that can never complete. NOT optimistic — like the
// initiation, the UI must never show a purge state the server has not
// confirmed; the settle invalidation re-reads the catalog (the drain
// disappears and uploads resume).
export function useCancelPluginPurge() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ pluginId }) => cancelPluginPurge(pluginId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: PLUGINS_KEY })
    },
  })
}
