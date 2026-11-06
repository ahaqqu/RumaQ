// The plugin registry (ahaqqu/RumaQ#435 — plugin architecture phase A,
// docs/plan/plugin-architecture.md §4.3). The ONE core→plugin composition
// surface: core knows which plugins exist (it must, to dispatch) but has
// zero feature logic for any of them (§2).
//
// Since ticket 4 (#438) construction is the factory contract: the registry
// builds each plugin's ports from the deployment wiring (the env bindings)
// and calls createDocumentsPlugin({ ports }) — §4.1 "Registry builds
// adapters from wiring and passes them into createApp({ ports }); plugins
// read no binding except env.DB". workerd passes the SAME env object to
// every request an isolate serves, so the composed registrations memoize in
// a WeakMap keyed on the env object (the gateway's own secrets-check
// precedent) — one factory call per isolate, never per request.
import { createDocumentsPlugin } from './documents/app.js'
import { createR2StorageAdapter } from '../ports/storage/r2.js'
import type { StorageAdapter } from '../ports/storage/index.js'
import type { Env } from '../types.js'
import type { PluginRegistration } from './types.js'

/**
 * Raised by the missing-binding adapter below — the compose-time wiring
 * mistake surfacing at call time (V1-A1, PR #473 review).
 */
export class PluginBindingMissingError extends Error {
  constructor(binding: string) {
    super(
      `plugin port is unwired: the '${binding}' binding is missing from this deployment's env — declare it in wrangler.toml (or .dev.vars locally) and redeploy`
    )
    this.name = 'PluginBindingMissingError'
  }
}

/**
 * A missing port binding is DETECTED at compose time but does NOT throw
 * there (V1-A1, PR #473 review): matchPlugin runs BEFORE the apiApp
 * fallthrough on every request, so a compose-time throw would take down
 * every route in the Worker — core domains included — the moment one
 * binding is mis-wired. That blast radius buys the call-time tradeoff
 * instead: an adapter whose EVERY method throws the typed error above,
 * naming the binding. The failure surfaces at the first call that would
 * have touched the binding — loud, actionable, scoped to the mis-wired
 * plugin's own routes — never as a silently-broken adapter dying with an
 * opaque "cannot read properties of undefined" one level deep in the R2
 * SDK. (The plugin factory's own absent-port guard keeps covering the
 * OTHER failure shape: a factory called with no adapter at all.) Exported
 * so tests pin every method's refusal against the exact adapter, not a
 * transcription.
 */
export function missingBindingAdapter(binding: string): StorageAdapter {
  const refuse = (): never => {
    throw new PluginBindingMissingError(binding)
  }
  // Async wrappers — the port's contract is promise-based ("errors propagate
  // as rejections", ports/storage/index.ts), so the refusal surfaces as a
  // rejected promise, the shape every `await` caller already handles.
  return {
    put: async () => refuse(),
    get: async () => refuse(),
    delete: async () => refuse(),
  }
}

function composeRegistrations(env: Env['Bindings']): readonly PluginRegistration[] {
  return [
    // Registered FIRST: the vault is plugin #1 (§0). Core domains (auth,
    // households/members) are NOT plugins — they stay hand-wired in the
    // gateway ahead of this loop.
    createDocumentsPlugin({
      ports: {
        storage: env.DOCUMENTS
          ? createR2StorageAdapter(env.DOCUMENTS)
          : missingBindingAdapter('DOCUMENTS'),
      },
    }),
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
