// The AI gateway's shared vocabulary (ahaqqu/RumaQ#523, plan §2.1–§2.2).
// These are the nouns every layer of the door agrees on — a capability, the
// wire protocol of a provider, the thinking knob, and the call dimensions a
// usage row is stamped with. Nothing here knows about a vendor, an endpoint,
// or a key.

import type { Env } from '../../types.js'

/**
 * The three things the product asks a provider to do. The enum is closed by
 * design: a new capability is an additive CHECK value plus a migration, never a
 * per-feature meaning (`embedding` is deliberately not here yet — plan §7.2).
 */
export type Capability = 'decision' | 'reasoning' | 'vision'

export const CAPABILITIES: readonly Capability[] = ['decision', 'reasoning', 'vision']

export type ThinkingLevel = 'low' | 'medium' | 'high'

export const THINKING_LEVELS: readonly ThinkingLevel[] = ['low', 'medium', 'high']

/**
 * The WIRE protocol of a provider row, not the vendor. 'openai-compatible'
 * serves OpenAI, OpenCode, Ollama and any custom base URL; 'gemini' is separate
 * because its wire is genuinely different; 'questions' is a typed choice/answer
 * wire. The vendor a row came from is `preset` (presets.ts), never a fifth kind.
 */
export type ProviderKind = 'openai-compatible' | 'anthropic' | 'gemini' | 'questions'

/**
 * Who pays for this call. Reserved by D9: v1 has exactly one value, so every
 * branch on it is a no-op today and a single line the day RumaQ funds a call.
 */
export type Funding = 'household' | 'platform'

/** What a provider call costs / is attributed to. Carried on success AND failure. */
export type AiCall = {
  capability: Capability
  /** The household that owns the provider (D1) — never re-derived at the call. */
  householdId: string
  providerKind: ProviderKind
  /** Always a household-owned row; there is no server fallback (D8). */
  providerId: string
  /**
   * The resolved model: `ai_capabilities.model ?? ai_providers.default_model`.
   * `resolveAccess` refuses a row with neither, so a handle always carries one;
   * the type stays nullable for future typed/`questions` call paths.
   */
  model: string | null
  funding: Funding
}

/**
 * The resolved household the request acts in — the same value
 * `propsAuthMiddleware` sets via ACTIVE_HOUSEHOLD_SQL (auth.ts), never
 * re-derived here. `userId` only attributes a usage row; it resolves nothing.
 */
export type AiCtx = { env: Env['Bindings']; userId: string; householdId: string }

/**
 * A pre-resolved capability access: resolve ONCE per request/run, reuse it.
 *
 * P1 NOTE — the plaintext key, preset, endpoint and thinking level ride on the
 * handle because the legacy dispatcher (lib/ai.ts) still takes them as
 * arguments; `resolveAccess` is the only reader of `credentials.ts`. P2 moves
 * all of it behind the door and narrows this type to `{ capability, call }`.
 */
export type AiAccessHandle = {
  readonly capability: Capability
  readonly call: AiCall
  /** Decrypted provider key. NEVER serialized, logged, or returned. */
  readonly apiKey: string
  /** The endpoint the row resolves to (row base_url, else the preset's). */
  readonly baseUrl: string | null
  /** The row's preset id, for the P1 bridge's kind→legacy-dispatcher mapping. */
  readonly preset: string | null
  readonly thinkingLevel: ThinkingLevel | null
}
