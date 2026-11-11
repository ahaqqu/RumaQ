// The storage cutover selector (ahaqqu/RumaQ#442 — plugin architecture T8).
// BOTH port-composition sites (plugins/registry.ts for the vault's DOCUMENTS
// binding, lib/receipts.ts for RECEIPTS) build their adapter through this one
// function, so the R2 → DokumenQ swap is decided in exactly one place:
//
//   1. DOKUMENQ_APP_SECRET set (+ DOKUMENQ_BASE_URL) → Mode A adapter
//      (ports/storage/dokumenq.ts) — the cutover state. The SECRET is the
//      cutover switch: it is out-of-band provisioned (`cf workers secrets
//      update`, api Worker only), so its mere existence IS the deliberate
//      operator act, and branch/preview Workers (no secret) never cut over
//      by accident.
//   2. DOKUMENQ_BASE_URL alone → the R2 adapter — inert config, not a
//      half-miswire: the base URL is baked into every deployment by
//      backend/cloudflare.config.ts (it is a public hostname, not a secret),
//      so "URL without secret" is the NORMAL pre-cutover state everywhere.
//   3. No secret + a bound R2 bucket → the R2 adapter (ports/storage/r2.ts).
//   4. No secret and NO binding → the missing-binding failover
//      (ports/storage/missing.ts) — the mis-wire surfacing at call time
//      (V1-A1), never at compose time.
//
// The one impossible-but-defended state: the secret set WITHOUT a base URL
// (a deployment that stripped the config binding but kept the credential).
// That must not fall back to R2 — bytes would land in the wrong store while
// the operator believes the cutover is live — so it refuses at call time,
// like the missing binding. Compose time stays throw-free: matchPlugin runs
// before the apiApp fallthrough on every request, so a compose-time throw
// would take down every route in the Worker.
import type { Env } from '../../types.js'
import type { StorageAdapter } from './index.js'
import { createDokumenQStorageAdapter } from './dokumenq.js'
import { createR2StorageAdapter } from './r2.js'
import { missingBindingAdapter } from './missing.js'

/**
 * Raised by the failover below — DOKUMENQ_APP_SECRET is set but
 * DOKUMENQ_BASE_URL is not, so a live credential exists and no service to
 * point it at. Call-time, like the missing binding's refusal (V1-A1).
 */
export class DokumenQConfigError extends Error {
  constructor() {
    super(
      'DokumenQ storage is half-configured: DOKUMENQ_APP_SECRET is set but DOKUMENQ_BASE_URL is unset — declare the base URL in backend/cloudflare.config.ts (or .dev.vars locally), or remove the secret to stay on R2'
    )
    this.name = 'DokumenQConfigError'
  }
}

function halfConfiguredAdapter(): StorageAdapter {
  const refuse = (): never => {
    throw new DokumenQConfigError()
  }
  return {
    put: async () => refuse(),
    get: async () => refuse(),
    delete: async () => refuse(),
  }
}

/**
 * The one adapter-selection decision for both port consumers. `binding` is
 * the caller's R2 binding value (DOCUMENTS / RECEIPTS — passed in, never
 * read from env here, so the binding-touch pins in plugin-boundary.test.ts
 * keep seeing exactly one runtime reader per binding).
 */
export function selectStorageAdapter(
  env: Env['Bindings'],
  binding: R2Bucket | undefined,
  bindingName: 'DOCUMENTS' | 'RECEIPTS'
): StorageAdapter {
  const baseUrl = env.DOKUMENQ_BASE_URL
  const appSecret = env.DOKUMENQ_APP_SECRET
  if (appSecret) {
    if (!baseUrl) return halfConfiguredAdapter()
    return createDokumenQStorageAdapter({ baseUrl, appSecret })
  }
  if (binding) return createR2StorageAdapter(binding)
  return missingBindingAdapter(bindingName)
}
