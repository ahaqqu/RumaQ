// Provider keys at rest (ahaqqu/RumaQ#523, plan §3.6). NO module outside
// `backend/src/lib/ai/**` may import this file: the decrypted key must never
// exist in a route, a feature library, or a response.
//
// P1 reads only the `v1:` envelope (no AAD). P2 adds the `v2:` form bound to the
// provider row id and the lazy v1→v2 rewrite; the migration already accepts
// both prefixes so that change needs no schema work.

import type { Env } from '../../types.js'
import { decryptAiKey } from '../crypto.js'

export type ProviderKeyRow = {
  /** The ai_providers row id — the AAD context from P2 onward. */
  id: string
  encrypted_key: string | null
}

/**
 * Decrypt one household provider's stored key.
 *
 * Returns null for a row without a key (unassignable until re-keyed). Throws
 * only for an undecryptable envelope — the caller (`capabilities.ts`) maps that
 * to "not configured", never to a 500.
 */
export async function decryptProviderKey(
  env: Env['Bindings'],
  row: ProviderKeyRow
): Promise<string | null> {
  if (!row.encrypted_key) return null
  return decryptAiKey(row.encrypted_key, env.WORKER_ENCRYPTION_KEY)
}
