// Provider keys at rest (ahaqqu/RumaQ#523, plan §3.6 / D10). NO module outside
// `backend/src/lib/ai/**` may import this file: the decrypted key must never
// exist in a route, a feature library, or a response.
//
// Two envelopes are READ here:
//
//   v2:  AES-GCM bound to `ai_provider:<row id>` (the additional authenticated
//        data). A ciphertext transplanted onto another row (a backup restore,
//        a support export, a hand-rolled INSERT) fails the tag. Every write
//        from P2 on uses this form (`encryptProviderKey`).
//   v1:  AES-GCM with no AAD — everything written before P2, including the P1
//        backfill, which copied the legacy `user_settings.encrypted_ai_key`
//        verbatim. It still authenticates its own ciphertext, just not the
//        row, so it is readable but transplantable.
//
// The read path is the migration: a `v1:` row is decrypted without AAD, then
// re-sealed as `v2:` with a compare-and-set UPDATE (`WHERE encrypted_key =
// <the v1 we read>`), so two concurrent readers cannot fight and both would
// write the same v2 value. The rewrite happens ONCE per legacy row, not per
// call, and is best-effort: the decrypted key is already in memory, so a
// failed UPDATE is logged, the key is still returned, and the next read tries
// again (plan §3.6).

import type { Env } from '../../types.js'
import { decryptAiKey, encryptAiKey } from '../crypto.js'

export type ProviderKeyRow = {
  /** The ai_providers row id — the AAD context (D10). */
  id: string
  encrypted_key: string | null
}

/** The additional authenticated data that binds a key to its provider row. */
export function providerKeyAad(providerId: string): string {
  return `ai_provider:${providerId}`
}

/**
 * The only WRITER of `ai_providers.encrypted_key` (P3's create/key-change
 * paths call this; nothing else may). Always seals the `v2:` envelope, so the
 * transplant window closes on the next key edit even for rows never read.
 */
export async function encryptProviderKey(
  env: Env['Bindings'],
  providerId: string,
  plainText: string
): Promise<string> {
  return encryptAiKey(plainText, env.WORKER_ENCRYPTION_KEY, providerKeyAad(providerId))
}

export type DecryptProviderKeyOptions = {
  /**
   * Re-seal a `v1:` row to `v2:` as a side effect of the read (default true).
   * The settings read model passes false: `GET /api/settings` must not write,
   * so migration happens on the next real provider call instead.
   */
  reseal?: boolean
}

/**
 * Decrypt one household provider's stored key.
 *
 * Returns null for a row without a key (unassignable until re-keyed). Throws
 * for an undecryptable envelope — the caller (`capabilities.ts`) maps that to
 * "not configured", never to a 500.
 */
export async function decryptProviderKey(
  env: Env['Bindings'],
  row: ProviderKeyRow,
  options: DecryptProviderKeyOptions = {}
): Promise<string | null> {
  const envelope = row.encrypted_key
  if (!envelope) return null
  const key = env.WORKER_ENCRYPTION_KEY

  if (!envelope.startsWith('v1:')) {
    // v2: one attempt, no fallback — a tag mismatch is final. This also
    // rejects an unknown prefix (crypto.ts's "Unsupported encryption
    // version"), which is row-unusable too, never a 500.
    return decryptAiKey(envelope, key, providerKeyAad(row.id))
  }

  // v1: no AAD was sealed, so none is applied. A tag failure here is final.
  const plainText = await decryptAiKey(envelope, key)
  if (options.reseal !== false) {
    await resealProviderKey(env, row.id, envelope, plainText)
  }
  return plainText
}

/**
 * Best-effort v1 → v2 rewrite with a compare-and-set. Never throws: a failed
 * UPDATE must not fail the call (the key is already decrypted) and is retried
 * on the next read.
 */
async function resealProviderKey(
  env: Env['Bindings'],
  providerId: string,
  currentEnvelope: string,
  plainText: string
): Promise<void> {
  try {
    const sealed = await encryptProviderKey(env, providerId, plainText)
    await env.DB.prepare(
      'UPDATE ai_providers SET encrypted_key = ? WHERE id = ? AND encrypted_key = ?'
    )
      .bind(sealed, providerId, currentEnvelope)
      .run()
  } catch (err) {
    // The envelope is never logged (it is ciphertext, but it is still the
    // household's secret material); the row id is enough to find the row.
    console.warn(
      `[ai] legacy key re-seal failed provider=${providerId}: ${err instanceof Error ? err.message : 'unknown error'}`
    )
  }
}
