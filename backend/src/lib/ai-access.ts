// AI access — the P1 BRIDGE between the legacy single-provider call sites and
// the household-scoped AI gateway (ahaqqu/RumaQ#523, plan §3.4, §5.1).
//
// WHAT CHANGED IN P1
// - Resolution reads the NEW tables (`ai_providers` / `ai_capabilities`) through
//   `lib/ai/capabilities.ts`, keyed by the household the request acts in — the
//   same value `propsAuthMiddleware` resolves. The user's `user_settings.ai_*`
//   columns are no longer read by the resolver (they stay until P3, where they
//   are dropped with the Settings screen).
// - The server fallback is GONE (D8): there is no `RUMAQ_SERVER_AI_*` branch, no
//   shared key, no platform default. An unconfigured household resolves null and
//   its routes answer the normal 402.
//
// WHAT THIS FILE IS UNTIL P4
// The export shape (`UserAiSettings`, `USER_AI_SETTINGS_COLUMNS`,
// `loadUserAiSettings`, `AiAccess`, `resolveAiAccess`) is kept ON PURPOSE so no
// provider call site is edited in P1. The legacy dispatcher takes ONE provider
// for everything, so the bridge resolves a primary access (reasoning →
// decision → vision) plus the vision assignment's model. P2 moves that
// resolution INSIDE the door (`lib/ai/legacy.ts`) because it reads decrypted key
// material, leaving this file a thin deprecated shape; P4 deletes it and the
// routes resolve per capability.
//
// `keySource` survives as `'user'` (the only value now possible) because
// `GET /api/ai/usage` still reports it; P3 removes the field with the rest of
// the legacy surface. Usage rows no longer write `key_source` at all — they
// carry `capability` / `household_id` / `funding` (lib/ai/usage.ts).

import type { Env } from '../types.js'
import { resolveLegacyAccess } from './ai/legacy.js'
import type { AiCall, ThinkingLevel } from './ai/types.js'

export type UserAiSettings = {
  ai_provider: string | null
  ai_base_url: string | null
  ai_model: string | null
  // Explicit vision model (0033, issue #433) — the vault's document OCR used
  // it INSTEAD of ai_model. Legacy history until P3.
  ai_vision_model: string | null
  ai_thinking_level: string | null
  encrypted_ai_key: string | null
  /**
   * P1: the household the request acts in, resolved with the SAME rule as the
   * auth middleware (ACTIVE_HOUSEHOLD_SQL in auth.ts). It rides the projection
   * so `resolveAiAccess` needs no extra D1 read and no call site has to pass a
   * context it does not have. The column expression is part of
   * USER_AI_SETTINGS_COLUMNS, so every inline SELECT gets it too.
   */
  household_id: string | null
}

// The AI-settings projection, owned HERE (review T4-B3): every hand-written
// user_settings SELECT that feeds resolveAiAccess builds its column list from
// this constant, so the next AI settings column touches this file — not the
// six-plus call sites that previously each repeated the projection.
//
// The household subqueries mirror auth.ts's ACTIVE_HOUSEHOLD_SQL verbatim in
// semantics (active pointer while it is still a membership, else the oldest
// membership). Correlated form, so it needs no binds and every existing
// `SELECT ... = ?` keeps its one parameter. Deleted with this file in P3.
export const USER_AI_SETTINGS_COLUMNS = [
  'ai_provider',
  'ai_base_url',
  'ai_model',
  'ai_vision_model',
  'ai_thinking_level',
  'encrypted_ai_key',
  `COALESCE(
     (SELECT m.household_id
        FROM household_members m
        JOIN user_settings a ON a.user_id = m.user_id
                             AND a.active_household_id = m.household_id
       WHERE m.user_id = user_settings.user_id
       LIMIT 1),
     (SELECT m.household_id
        FROM household_members m
       WHERE m.user_id = user_settings.user_id
       ORDER BY m.joined_at, m.household_id
       LIMIT 1)
   ) AS household_id`,
].join(', ')

/**
 * The one loader for the caller's AI settings (review T4-B3). The projection is
 * `USER_AI_SETTINGS_COLUMNS`; the household it returns is what the resolver
 * keys on. Kept in P1 as the seam the P4 call sites use.
 */
export async function loadUserAiSettings(
  db: D1Database,
  userId: string
): Promise<UserAiSettings | null> {
  return db
    .prepare(`SELECT ${USER_AI_SETTINGS_COLUMNS} FROM user_settings WHERE user_id = ?`)
    .bind(userId)
    .first<UserAiSettings>()
}

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
  // 'server' is retired by D8; the field survives only because GET /api/ai/usage
  // still reports it (removed in P3 with the rest of the legacy surface).
  keySource: 'user' | 'server'
  /**
   * P1: the resolved dimensions the usage writer stamps (capability,
   * household_id, funding). P4 turns the call sites into capability-specific
   * handles; until then this is the primary assignment's call.
   */
  call: AiCall
}

/**
 * Resolve the provider credentials that serve this request. The household's
 * rows are the only source (D8); the caller's legacy `user_settings.ai_*` are
 * ignored. Returns null when the household has no usable assignment, and the
 * routes map that to 402.
 *
 * P2: the resolution itself (primary-capability ladder, kind→legacy-provider
 * mapping, vision precedence) moved INSIDE the door (`lib/ai/legacy.ts`),
 * because it reads decrypted key material. This function is now only the
 * legacy shape the call sites still consume; P4 deletes it together with the
 * `lib/ai.ts` shim, and the routes call `resolveAccess` per capability.
 */
export async function resolveAiAccess(
  env: Env['Bindings'],
  settings: UserAiSettings | null
): Promise<AiAccess | null> {
  const householdId = settings?.household_id
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
    keySource: 'user',
    call: access.call,
  }
}
