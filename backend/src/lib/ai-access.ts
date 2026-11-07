// AI access — the bridge between the legacy single-provider call sites and the
// household-scoped AI gateway (ahaqqu/RumaQ#523, plan §3.4, §5.1).
//
// WHAT CHANGED IN P3
// - `USER_AI_SETTINGS_COLUMNS` and `loadUserAiSettings` are GONE, together with
//   the six `user_settings.ai_*` columns migration 0042 drops and the Settings
//   fields that used to write them (plan §4.3). The household the request acts
//   in — `c.get('householdId')`, the value `propsAuthMiddleware` resolves — is
//   now the ONLY input to resolution, exactly as plan §5.1 describes. No call
//   site reads a settings row to find AI configuration any more.
// - `keySource` is gone too: every call is household-funded (D9), and the usage
//   row carries `funding` instead of `key_source`.
//
// WHAT THIS FILE IS UNTIL P4
// The remaining export shape (`AiAccess`, `resolveAiAccess`) is kept ON PURPOSE
// so no provider call site is edited in P3. The legacy dispatcher takes ONE
// provider for everything, so the bridge resolves a primary access (reasoning →
// decision → vision) plus the vision assignment's model. P4 routes each call site
// by capability and deletes this file and its `lib/ai/legacy.ts` bridge.

import type { Env } from '../types.js'
import { resolveLegacyAccess } from './ai/legacy.js'
import type { AiCall, ThinkingLevel } from './ai/types.js'

export type AiAccess = {
  /** The legacy dispatcher's provider id ('openai', 'gemini', 'custom', …). */
  provider: string
  apiKey: string
  baseUrl: string | null
  model: string | null
  // The resolved vision model for vision work (document OCR): the vision
  // assignment's model when it shares the primary provider, else the primary
  // model. null = the provider default applies.
  visionModel: string | null
  thinkingLevel: ThinkingLevel | null
  /**
   * The resolved dimensions the usage writer stamps (capability,
   * household_id, funding). P4 turns the call sites into capability-specific
   * handles; until then this is the primary assignment's call.
   */
  call: AiCall
}

/**
 * Resolve the provider credentials that serve this request, for the acting
 * household. The household's rows are the only source (D8); returns null when
 * the household has no usable assignment, and the routes map that to 402.
 *
 * `householdId` is the middleware's resolved household — never re-derived here
 * from a user id (the P1–P2 projection that carried it is deleted in P3).
 *
 * P2: the resolution itself (primary-capability ladder, kind→legacy-provider
 * mapping, vision precedence) lives INSIDE the door (`lib/ai/legacy.ts`),
 * because it reads decrypted key material. This function is now only the legacy
 * shape the call sites still consume; P4 deletes it together with the
 * `lib/ai.ts` shim, and the routes call `resolveAccess` per capability.
 */
export async function resolveAiAccess(
  env: Env['Bindings'],
  householdId: string | null
): Promise<AiAccess | null> {
  if (!householdId) return null

  const access = await resolveLegacyAccess(env, householdId)
  if (!access) return null

  return {
    provider: access.provider,
    apiKey: access.apiKey,
    baseUrl: access.baseUrl,
    model: access.model,
    visionModel: access.visionModel,
    thinkingLevel: access.thinkingLevel,
    call: access.call,
  }
}
