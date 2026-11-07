// The AI gateway's shared vocabulary (ahaqqu/RumaQ#523, plan §2.1–§2.2).
// These are the nouns every layer of the door agrees on — a capability, the
// wire protocol of a provider, the thinking knob, the messages a caller hands
// the door, and the call dimensions a usage row is stamped with. Nothing here
// knows about a vendor, an endpoint, or a key.

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

export type AiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; bytes: ArrayBuffer; mimeType: string }

export type AiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | AiContentPart[] }
  | { role: 'assistant'; content: string }

/**
 * Real provider token counts (what the caller's own provider subscription
 * bills). `cached_tokens` is null when unreported — unknown, not zero.
 */
export type TokenUsage = {
  input_tokens: number
  output_tokens: number
  cached_tokens: number | null
}

export const EMPTY_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0, cached_tokens: null }

/**
 * A pre-resolved capability access. Resolve ONCE per request/run and reuse it
 * for N calls: the door holds the decrypted key, the endpoint and the thinking
 * level in module-private state (a WeakMap in capabilities.ts), so the handle
 * itself exposes no key and no accessor for one (plan §2.2).
 *
 * There is deliberately no way to FORGE a usable access: a handle the door did
 * not issue carries no material, and every call fails closed (not_configured)
 * before a provider is contacted.
 */
export type AiAccessHandle = {
  readonly capability: Capability
  readonly call: AiCall
}

export type AiResult = {
  text: string
  call: AiCall
  /** Provider-reported; zeroes when it reported none. */
  usage: TokenUsage
}

/** One typed decision: a stated question, a closed choice list, a confidence. */
export type DecisionAsk = {
  /** The subject being classified/decided. */
  state: string
  /** One imperative sentence. */
  question: string
  /** Labelled rubric, newline-separated. */
  criteria?: string
  /** Closed vocabulary; the answer must be one of these. */
  choices: readonly string[]
}

export type DecisionResult = {
  choice: string
  /** null when the provider reports none. */
  confidence: number | null
  /** null on providers that answer choice+confidence only (typed wire, D3). */
  reason: string | null
  call: AiCall
  usage: TokenUsage
}
