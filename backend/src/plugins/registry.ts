// The plugin registry (ahaqqu/RumaQ#435 — plugin architecture phase A,
// docs/plan/plugin-architecture.md §4.3). The ONE core→plugin composition
// surface: core knows which plugins exist (it must, to dispatch) but has
// zero feature logic for any of them (§2).
//
// Since ticket 4 (#438) construction is the factory contract: the registry
// builds each plugin's ports from the deployment wiring (the env bindings)
// and calls createDocumentsPlugin({ ports }) — §4.1 "Registry builds
// adapters from wiring and passes them into createApp({ ports }); plugins
// read no binding except env.DB". Env arrives per request but bindings are
// stable per isolate, so the composed registrations memoize in a WeakMap
// keyed on the env object (the gateway's own secrets-check precedent) — one
// factory call per env, never per request.
import { createDocumentsPlugin } from './documents/app.js'
import { createR2StorageAdapter } from '../ports/storage/r2.js'
import type { Env } from '../types.js'
import type { PluginRegistration } from './types.js'

function composeRegistrations(env: Env['Bindings']): readonly PluginRegistration[] {
  return [
    // Registered FIRST: the vault is plugin #1 (§0). Core domains (auth,
    // households/members) are NOT plugins — they stay hand-wired in the
    // gateway ahead of this loop.
    createDocumentsPlugin({ ports: { storage: createR2StorageAdapter(env.DOCUMENTS) } }),
  ]
}

const composed = new WeakMap<Env['Bindings'], readonly PluginRegistration[]>()

/** The composed plugin registrations for this deployment's wiring. */
export function pluginRegistrations(env: Env['Bindings']): readonly PluginRegistration[] {
  let registrations = composed.get(env)
  if (!registrations) {
    registrations = composeRegistrations(env)
    composed.set(env, registrations)
  }
  return registrations
}

// Boundary-aware prefix match — the exact semantics the gateway's hand-wired
// documents check had (`path === p || path.startsWith(p + '/')`). Without the
// boundary guard, '/api/documents-x' would dispatch into the vault (§4.3).
export function matchPlugin(path: string, env: Env['Bindings']): PluginRegistration | undefined {
  return pluginRegistrations(env).find(({ manifest }) => {
    const prefix = manifest.routePrefix
    return path === prefix || path.startsWith(`${prefix}/`)
  })
}
