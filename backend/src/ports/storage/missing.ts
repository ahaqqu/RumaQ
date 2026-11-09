// The missing-binding StorageAdapter (V1-A1, PR #473 review — moved here from
// plugins/registry.ts by #503, which gave the receipts domain the same port
// composition and needed this adapter without importing the plugin registry).
// It is what a port consumer gets when its backing binding is absent from the
// deployment's env wiring: the compose-time wiring mistake surfacing at call
// time.
//
// Compose time is the WRONG place to throw: for the vault, matchPlugin runs
// BEFORE the apiApp fallthrough on every request, so a compose-time throw
// would take down every route in the Worker — core domains included — the
// moment one binding is mis-wired. The receipts composition owns the same
// tradeoff (its adapter is built inside the purchase routes, but the typed
// refusal still beats an opaque "cannot read properties of undefined" one
// level deep in the R2 SDK). The failure surfaces at the first call that
// would have touched the binding — loud, actionable, scoped to the consumer's
// own routes — never as a silently-broken adapter. Exported so tests pin every
// method's refusal against the exact adapter, not a transcription.
import type { StorageAdapter } from './index.js'

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
 * there (V1-A1, PR #473 review): an adapter whose EVERY method throws the
 * typed error above, naming the binding. The port's contract is
 * promise-based ("errors propagate as rejections", ports/storage/index.ts),
 * so the refusal surfaces as a rejected promise — the shape every `await`
 * caller already handles.
 */
export function missingBindingAdapter(binding: string): StorageAdapter {
  const refuse = (): never => {
    throw new PluginBindingMissingError(binding)
  }
  return {
    put: async () => refuse(),
    get: async () => refuse(),
    delete: async () => refuse(),
  }
}
