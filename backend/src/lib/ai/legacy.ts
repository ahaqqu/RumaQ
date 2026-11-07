// DEPRECATED IN P2, DELETED IN P4 — the compatibility bridge that lets the
// legacy single-provider call sites (lib/ai.ts shim and lib/ai-access.ts) keep
// working while the door lands. Nothing here is new product surface:
//
//   - `resolveLegacyAccess` is the P1 bridge's resolution (primary capability
//     reasoning → decision → vision, plus the vision model), now living INSIDE
//     the door because it reads key material.
//   - `legacyCompleteText` maps the six legacy VENDOR ids onto the four wire
//     kinds and dispatches an ordinary adapter call. The vendor ids and their
//     caps are legacy dispatcher behaviour, not door behaviour: P4 deletes both
//     this file and the call shape with it.
//
// Keeping it in `lib/ai/**` is what lets `lib/ai.ts` be a thin shim with no
// provider hostname and no transport, so the boundary test stays honest.

import type { Env } from '../../types.js'
import { accessMaterial, resolveAccess } from './capabilities.js'
import { AiError } from './errors.js'
import { presetEndpoint } from './presets.js'
import { adapterFor } from './adapters/registry.js'
import { AdapterError, type AdapterRequest } from './adapters/types.js'
import type {
  AiAccessHandle,
  AiCall,
  AiCtx,
  AiMessage,
  Capability,
  ProviderKind,
  ThinkingLevel,
  TokenUsage,
} from './types.js'

// The primary capability the legacy dispatcher serves. Chat, plans and the
// scan path are the majority; a household configured only for decision/vision
// still gets an access rather than a 402 until P4 routes each call site.
const PRIMARY_CAPABILITIES: readonly Capability[] = ['reasoning', 'decision', 'vision']

// The legacy provider ids, their wire, and the token cap the old dispatcher
// applied. `ollama` deliberately has NO cap (its reasoning models spend
// thousands of tokens thinking before the answer). P4 deletes this table.
const LEGACY_WIRES: Readonly<
  Record<string, { kind: ProviderKind; preset: string | null; maxTokens?: number }>
> = {
  openai: { kind: 'openai-compatible', preset: 'openai', maxTokens: 2000 },
  opencode: { kind: 'openai-compatible', preset: 'opencode', maxTokens: 2000 },
  ollama: { kind: 'openai-compatible', preset: 'ollama' },
  anthropic: { kind: 'anthropic', preset: 'anthropic' },
  gemini: { kind: 'gemini', preset: 'gemini' },
  custom: { kind: 'openai-compatible', preset: null, maxTokens: 2000 },
}

/** The legacy access shape (lib/ai-access.ts's `AiAccess` minus `keySource`). */
export type LegacyAccess = {
  provider: string
  apiKey: string
  baseUrl: string | null
  model: string | null
  visionModel: string | null
  thinkingLevel: ThinkingLevel | null
  call: AiCall
}

/**
 * Map a resolved gateway access onto a legacy dispatcher provider id. Null
 * means "this row cannot be dispatched by the legacy shim": a typed
 * ('questions') provider has no chat wire, and a row with no endpoint has no
 * place to send a request.
 */
function legacyProviderFor(
  kind: ProviderKind,
  baseUrl: string | null,
  preset: string | null
): string | null {
  if (kind === 'anthropic') return 'anthropic'
  if (kind === 'gemini') return 'gemini'
  if (kind === 'questions') return null
  // openai-compatible: a preset row whose endpoint has not been overridden is
  // its own vendor id; everything else rides the 'custom' branch (the only one
  // that honours a base URL).
  if (
    preset &&
    LEGACY_WIRES[preset]?.kind === 'openai-compatible' &&
    baseUrl === presetEndpoint(preset, 'openai-compatible')
  ) {
    return preset
  }
  return baseUrl ? 'custom' : null
}

/**
 * Resolve the provider credentials that serve this request, for the legacy
 * shim only. The household's rows are the only source (D8); returns null when
 * the household has no usable assignment.
 */
export async function resolveLegacyAccess(
  env: Env['Bindings'],
  householdId: string
): Promise<LegacyAccess | null> {
  // The acting user never enters resolution (plan §5.1); the legacy shim has no
  // user id to pass and does not need one.
  const householdCtx: AiCtx = { env, userId: '', householdId }

  let primary: AiAccessHandle | null = null
  for (const capability of PRIMARY_CAPABILITIES) {
    primary = await resolveAccess(householdCtx, capability)
    if (primary) break
  }
  if (!primary) return null
  const primaryMaterial = accessMaterial(primary)
  if (!primaryMaterial) return null

  const provider = legacyProviderFor(
    primary.call.providerKind,
    primaryMaterial.baseUrl,
    primaryMaterial.preset
  )
  if (!provider) return null

  // Vision precedence: the vision assignment's (effective) model when it points
  // at the SAME provider row, else the primary model (the old
  // `ai_vision_model ?? ai_model` behaviour). A vision assignment on another
  // provider cannot be expressed through one legacy access — P4 routes it.
  let visionModel = primary.call.model
  if (primary.capability !== 'vision') {
    const vision = await resolveAccess(householdCtx, 'vision')
    if (vision && vision.call.providerId === primary.call.providerId) {
      visionModel = vision.call.model ?? primary.call.model
    }
  }

  return {
    provider,
    apiKey: primaryMaterial.apiKey,
    baseUrl: primaryMaterial.baseUrl,
    model: primary.call.model,
    visionModel,
    thinkingLevel: primaryMaterial.thinkingLevel,
    call: primary.call,
  }
}

export type LegacyCompleteArgs = {
  provider: string
  apiKey: string
  messages: AiMessage[]
  baseUrl?: string | null
  model?: string | null
  thinkingLevel?: ThinkingLevel | null
  json?: boolean
  signal?: AbortSignal
}

/** A signal that never fires — the legacy call shape has no door deadline. */
const NEVER_ABORTED = new AbortController().signal

/**
 * One legacy provider call through the door's adapters. Returns the text plus
 * the reported usage (`null` when the provider reported none), preserving the
 * pre-P2 `onUsage` contract for the shim.
 */
export async function legacyCompleteText(
  args: LegacyCompleteArgs
): Promise<{ text: string; usage: TokenUsage | null }> {
  const wire = LEGACY_WIRES[args.provider]
  if (!wire) {
    throw new AiError('provider_error', `Unsupported AI provider: ${args.provider}`, { call: null })
  }

  const baseUrl = wire.preset
    ? presetEndpoint(wire.preset, wire.kind)
    : (args.baseUrl?.trim() ?? null)
  const model = args.model?.trim() ?? null

  if (args.provider === 'custom' && (!baseUrl || !model)) {
    throw new AiError(
      'provider_error',
      'Custom provider requires a base URL and model in Settings',
      { call: null }
    )
  }
  if (!model) {
    // Production never reaches this: resolveAccess refuses a model-less row.
    // The legacy signature allows null, so fail closed instead of inventing a
    // vendored default (plan §5.1: no model id compiled into code).
    throw new AiError('not_configured', 'AI capability has no model', { call: null })
  }

  const adapter = adapterFor(wire.kind)
  const request: AdapterRequest = {
    capability: 'reasoning',
    model,
    messages: args.messages,
    json: args.json ?? false,
    thinkingLevel: args.thinkingLevel ?? null,
    maxTokens: wire.maxTokens,
    baseUrl,
    apiKey: args.apiKey,
    signal: args.signal ?? NEVER_ABORTED,
  }
  try {
    const result = await adapter.complete(request)
    return { text: result.text, usage: result.usageReported ? result.usage : null }
  } catch (err) {
    // The shim sits OUTSIDE the door, so it may not import the adapter
    // vocabulary; map it onto AiError here (with the failed attempt's usage,
    // which the shim forwards to its onUsage before rethrowing — the pre-P2
    // "failure carries the bill" contract). The call dimensions are the
    // caller's (legacy AiAccess), so this error has no AiCall.
    if (err instanceof AdapterError) {
      throw new AiError(err.code, err.message, {
        call: null,
        usage: err.detail.usage,
        providerStatus: err.detail.providerStatus,
        retryAfterSeconds: err.detail.retryAfterSeconds,
      })
    }
    throw err
  }
}
