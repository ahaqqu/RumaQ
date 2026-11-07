// The adapter contract (ahaqqu/RumaQ#523, plan §2.4). One interface for the
// four WIRE protocols; the vendor a row came from is `preset` data, never a
// fifth kind and never a class here.
//
// Adapters own transport and nothing else: request shaping, response shaping,
// the provider's failure vocabulary (401/403, 429, 5xx, empty content, aborts)
// and its token-usage fields. They do NOT know capabilities policy (the facade
// checks `supports()` before calling), the household, the funding source, or the
// prompt — they receive finished messages.
//
// A model is ALWAYS supplied. There is no `defaultModel()` on this interface on
// purpose: `ai_capabilities.model ?? ai_providers.default_model` is owner-typed
// data and the resolver refuses a row where both are blank (plan §5.1, D2), so
// no vendor alias ages in code (P1 review B1 — deviation recorded in the plan).

import type {
  AiMessage,
  Capability,
  DecisionAsk,
  ProviderKind,
  ThinkingLevel,
  TokenUsage,
} from '../types.js'

/**
 * The provider-facing failure vocabulary. The facade maps it onto the public
 * `AiError` (code→HTTP, call, usage); adapters stay ignorant of the household.
 */
export type AdapterErrorCode =
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'provider_error'
  | 'invalid_response'
  | 'unsupported'

export type AdapterErrorDetail = {
  /** The provider's HTTP status, when the failure came from a response. */
  providerStatus?: number
  /** Seconds the provider asked us to wait (`Retry-After`) — surfaced, never slept. */
  retryAfterSeconds?: number
  /** Usage the provider reported before the answer was rejected (empty content, bad JSON). */
  usage?: TokenUsage
}

export class AdapterError extends Error {
  readonly code: AdapterErrorCode
  readonly detail: AdapterErrorDetail

  constructor(code: AdapterErrorCode, message: string, detail: AdapterErrorDetail = {}) {
    super(message)
    this.name = 'AdapterError'
    this.code = code
    this.detail = detail
  }
}

export type AdapterRequest = {
  capability: Capability
  /** Resolved by the door — never invented by an adapter. */
  model: string
  messages: AiMessage[]
  /** Ask for the provider's JSON mode when it has one (opt-in, off by default). */
  json: boolean
  thinkingLevel: ThinkingLevel | null
  maxTokens?: number
  /** The endpoint the row resolves to; null only for kinds that own a canonical one. */
  baseUrl: string | null
  apiKey: string
  /** Already composed with the door's deadline (see ../signal.ts). */
  signal: AbortSignal
}

export type AdapterResult = {
  text: string
  usage: TokenUsage
  /**
   * Whether the provider's response actually carried usage. The deprecated
   * legacy shim only forwards usage when it did (its pre-P2 callback contract);
   * the door itself always returns a TokenUsage (zeroes when unreported).
   */
  usageReported: boolean
}

export type DecisionAdapterRequest = Omit<AdapterRequest, 'json' | 'messages'> & {
  ask: DecisionAsk
}

export type DecisionAdapterResult = {
  choice: string
  confidence: number | null
  /** null on the typed wire, which answers choice+confidence only (D3). */
  reason: string | null
  usage: TokenUsage
  usageReported: boolean
}

export interface AiAdapter {
  readonly kind: ProviderKind
  /** Static capability matrix (plan §2.4) — validated at save time, belt at call time. */
  supports(capability: Capability): boolean
  /** Chat-shaped call: one request, one text answer, one usage report. */
  complete(req: AdapterRequest): Promise<AdapterResult>
  /** Closed-choice decision. Chat adapters do prompt + strict JSON parse. */
  decide(req: DecisionAdapterRequest): Promise<DecisionAdapterResult>
  /**
   * Schema-constrained JSON document (quick-add), chat kinds only. The feature
   * owns the schema; the adapter only guarantees well-formed JSON text.
   */
  structured?(req: AdapterRequest): Promise<AdapterResult>
}
