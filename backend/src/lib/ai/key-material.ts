// KEY MATERIAL — door-internal (ahaqqu/RumaQ#523 P2, plan §2.2/§2.3).
//
// NO module outside `backend/src/lib/ai/**` may import this file, and
// `ai-boundary.test.ts` rule 2 fails the build if one does. That is not
// ceremony: this module hands out the DECRYPTED provider key for a resolved
// handle, which is precisely what the boundary rule forbids a feature to hold.
// Keeping it beside the resolver was not enough — `capabilities.ts` is legitimately
// importable from outside the door (the settings read model), so an outside
// module could reach `accessMaterial(handle)?.apiKey` (or destructure it, which
// the `.apiKey` text rule cannot see) and the boundary test would stay green.
//
// The store is a WeakMap keyed by the handle object itself: a handle the door
// did not issue (a forged one) has no entry and fails closed, and nothing is
// ever written onto the handle — no getter, no enumerable field, no
// serialisation surface.

import type { AiAccessHandle, ThinkingLevel } from './types.js'

/**
 * Everything a provider call needs that must never leave the door: the
 * decrypted key, the resolved endpoint, the row's preset and the assignment's
 * thinking level. Stored beside the public handle, never on it.
 */
export type AccessMaterial = {
  apiKey: string
  baseUrl: string | null
  preset: string | null
  thinkingLevel: ThinkingLevel | null
}

const ACCESS_MATERIAL = new WeakMap<AiAccessHandle, AccessMaterial>()

/** Attach the material to a handle the resolver just issued. Door-internal. */
export function holdMaterial(handle: AiAccessHandle, material: AccessMaterial): void {
  ACCESS_MATERIAL.set(handle, material)
}

/** The door-internal reader for a resolved handle. Null = not issued here. */
export function accessMaterial(handle: AiAccessHandle): AccessMaterial | null {
  return ACCESS_MATERIAL.get(handle) ?? null
}
