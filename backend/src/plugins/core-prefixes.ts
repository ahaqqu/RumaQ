// Core-reserved API prefixes (ahaqqu/RumaQ#437 — S1-A2, PR #470 review). The
// gateway hand-wires these domains AHEAD of plugin dispatch (gateway.ts):
// auth (exact-match routes), households, tasks, calendar, and the plugin
// settings catalog itself. A plugin manifest claiming any of them as its
// routePrefix would be silently shadowed — every request would answer from
// the core app first and the plugin's routes would 404 forever while
// build-time validation stayed green.
//
// validatePluginManifests (manifests.ts) rejects claims on this list at
// build time. KEEP THIS LIST IN LOCKSTEP with the gateway's dispatch blocks:
// adding a core domain app in gateway.ts must add its prefix here, or the
// validator will happily let a future plugin claim it. (Pure data — no
// imports — so the manifest module graph stays frontend-loadable.)
export const CORE_GATEWAY_PREFIXES = [
  '/api/auth',
  '/api/households',
  '/api/tasks',
  '/api/calendar',
  '/api/plugins',
] as const
