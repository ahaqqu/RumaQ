// ─────────────────────────────────────────────────────────────────────────────
//                     THE DOOR (ahaqqu/RumaQ#523 P2, plan §2)
//
// This is the ONLY AI module a feature may import. It resolves a household's
// capability assignment, dispatches exactly one provider request through the
// wire adapters, and hands back text / a decision / an image answer plus the
// call dimensions and token usage.
//
// Why one door is load-bearing (not stylistic): platform-funded AI can only be
// metered and limited if ONE module dispatches provider requests; a capability
// assignment is only meaningful if nothing bypasses it; and "what did this
// household spend" needs one writer of `ai_usage_events` and one place that
// knows the funding source. `backend/src/__tests__/ai-boundary.test.ts` makes
// the rule enforceable: outside `lib/ai/**`, a module may build prompts,
// validate the model's answer, write usage rows and map `AiError` to HTTP — it
// may not import an adapter, hold a key, or fetch a model endpoint.
//
// The decrypted key never appears in a signature or a return value. It lives
// in module-private state inside capabilities.ts and is looked up by the
// opaque `AiAccessHandle` this file is handed (§2.2).
// ─────────────────────────────────────────────────────────────────────────────

import { adapterFor } from './adapters/registry.js'
import { AdapterError, type AdapterRequest, type AiAdapter } from './adapters/types.js'
import { resolveAccess as resolveCapabilityAccess } from './capabilities.js'
import { accessMaterial } from './key-material.js'
import { AiError } from './errors.js'
import { withTimeout } from './signal.js'
import { parseJsonResponse } from './parse.js'
import {
  type AiAccessHandle,
  type AiCall,
  type AiContentPart,
  type AiCtx,
  type AiMessage,
  type AiResult,
  type Capability,
  type DecisionAsk,
  type DecisionResult,
  type ThinkingLevel,
  type TokenUsage,
} from './types.js'

// --- public types -----------------------------------------------------------

export type {
  AiAccessHandle,
  AiCall,
  AiContentPart,
  AiCtx,
  AiMessage,
  AiResult,
  Capability,
  DecisionAsk,
  DecisionResult,
  Funding,
  ProviderKind,
  ThinkingLevel,
  TokenUsage,
} from './types.js'
export { CAPABILITIES, THINKING_LEVELS, EMPTY_USAGE } from './types.js'
export { AiError, isAiError } from './errors.js'
export type { AiErrorCode } from './errors.js'

/**
 * The door's per-capability deadlines (plan §5.2), overridable per call.
 * reasoning: long chat/plan answers; decision: the review constant today;
 * vision: image upload + read.
 */
export const AI_TIMEOUT_MS: Readonly<Record<Capability, number>> = {
  reasoning: 60_000,
  decision: 20_000,
  vision: 30_000,
}

// --- resolution -------------------------------------------------------------

/**
 * Resolve one capability ONCE per request/run and reuse the handle for N calls
 * (the review sweep's subrequest budget depends on it). null = the capability
 * is not configured for the household; the door turns that into
 * `AiError('not_configured')` (402) at the call, exactly as `resolveAccess`
 * itself never throws.
 */
export function resolveAccess(ctx: AiCtx, capability: Capability): Promise<AiAccessHandle | null> {
  return resolveCapabilityAccess(ctx, capability)
}

type ResolvedCall = {
  handle: AiAccessHandle
  material: NonNullable<ReturnType<typeof accessMaterial>>
}

async function resolveFor(
  args: AiCtx & { access?: AiAccessHandle },
  capability: Capability
): Promise<ResolvedCall> {
  let handle: AiAccessHandle | null
  if (args.access) {
    if (args.access.capability !== capability) {
      throw new AiError(
        'unsupported',
        `AI access handle is for '${args.access.capability}', not '${capability}'`,
        { call: args.access.call }
      )
    }
    if (args.access.call.householdId !== args.householdId) {
      // The handle carries the household that owns the provider and pays for
      // the call; the request acts in another one. Billing the wrong household
      // is not a recoverable state, so fail closed before the provider is
      // contacted instead of stamping a usage row that lies (plan §5.3).
      throw new AiError('unsupported', 'AI access handle was resolved for another household', {
        call: args.access.call,
      })
    }
    handle = args.access
  } else {
    handle = await resolveCapabilityAccess(args, capability)
  }
  if (!handle) {
    throw new AiError('not_configured', 'AI is not configured for this household', { call: null })
  }
  const material = accessMaterial(handle)
  if (!material) {
    // A handle the door did not issue (or one whose material was collected):
    // fail closed before a provider is contacted. Never 500 — a missing
    // capability is a normal state the routes already answer 402 for.
    throw new AiError('not_configured', 'AI access handle is not usable', { call: handle.call })
  }
  return { handle, material }
}

// --- the one dispatch path --------------------------------------------------

type AdapterContext = {
  model: string
  baseUrl: string | null
  apiKey: string
  signal: AbortSignal
}

async function dispatch<T>(
  resolved: ResolvedCall,
  capability: Capability,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  run: (context: AdapterContext, adapter: AiAdapter) => Promise<{ value: T; usage: TokenUsage }>
): Promise<{ call: AiCall; usage: TokenUsage; value: T }> {
  const { handle, material } = resolved
  const deadline = withTimeout(callerSignal, timeoutMs)
  try {
    const adapter = adapterFor(handle.call.providerKind)
    if (!adapter.supports(capability)) {
      throw new AdapterError(
        'unsupported',
        `A '${handle.call.providerKind}' provider cannot serve the '${capability}' capability`
      )
    }
    if (handle.call.model == null) {
      // resolveAccess refuses such a row, so this is belt only.
      throw new AdapterError('provider_error', 'AI capability has no model')
    }
    const result = await run(
      {
        model: handle.call.model,
        baseUrl: material.baseUrl,
        apiKey: material.apiKey,
        signal: deadline.signal,
      },
      adapter
    )
    return { call: handle.call, usage: result.usage, value: result.value }
  } catch (err) {
    throw toAiError(err, handle.call, deadline.timedOut(), callerSignal)
  } finally {
    deadline.dispose()
  }
}

/**
 * Map the adapter vocabulary (and anything unexpected) onto the public AiError.
 * The failed attempt's usage rides along: a provider bills the inputs it read
 * even when its answer was unusable (plan §2.2 "failure carries the bill").
 */
function toAiError(
  err: unknown,
  call: AiCall,
  timedOut: boolean,
  callerSignal: AbortSignal | undefined
): AiError {
  if (err instanceof AiError) return err
  if (err instanceof AdapterError) {
    return new AiError(err.code, err.message, {
      call,
      usage: err.detail.usage,
      providerStatus: err.detail.providerStatus,
      retryAfterSeconds: err.detail.retryAfterSeconds,
    })
  }
  if (timedOut) {
    return new AiError('timeout', 'AI provider request timed out', { call })
  }
  if (callerSignal?.aborted) {
    // Same code/status as a deadline (client handling is unchanged, §5.2); the
    // log line keeps the two distinguishable.
    console.warn(`[ai] provider call cancelled by the caller household=${call.householdId}`)
    return new AiError('timeout', 'AI provider request was cancelled', { call })
  }
  return new AiError(
    'provider_error',
    err instanceof Error ? err.message : 'AI provider request failed',
    { call }
  )
}

function adapterRequest(
  context: AdapterContext,
  capability: Capability,
  fields: Pick<AdapterRequest, 'messages' | 'json' | 'thinkingLevel' | 'maxTokens'>
): AdapterRequest {
  return {
    capability,
    model: context.model,
    messages: fields.messages,
    json: fields.json,
    thinkingLevel: fields.thinkingLevel,
    maxTokens: fields.maxTokens,
    baseUrl: context.baseUrl,
    apiKey: context.apiKey,
    signal: context.signal,
  }
}

// --- the public API ---------------------------------------------------------

/**
 * Prose in, prose out. The REASONING capability only — there is no way to ask
 * for a decision answer here, which is what keeps the capability unambiguous.
 */
export async function completeText(
  args: AiCtx & {
    /** Resolve once and reuse; omit to resolve internally (single-call routes). */
    access?: AiAccessHandle
    messages: AiMessage[]
    json?: boolean
    thinkingLevel?: ThinkingLevel | null
    maxTokens?: number
    timeoutMs?: number
    signal?: AbortSignal
  }
): Promise<AiResult> {
  const resolved = await resolveFor(args, 'reasoning')
  // undefined = the assignment's level; an explicit null = no thinking this call.
  const thinkingLevel =
    args.thinkingLevel === undefined ? resolved.material.thinkingLevel : args.thinkingLevel

  const dispatched = await dispatch(
    resolved,
    'reasoning',
    args.timeoutMs ?? AI_TIMEOUT_MS.reasoning,
    args.signal,
    async (context, adapter) => {
      const result = await adapter.complete(
        adapterRequest(context, 'reasoning', {
          messages: args.messages,
          json: args.json ?? false,
          thinkingLevel,
          maxTokens: args.maxTokens,
        })
      )
      return { value: result.text, usage: result.usage }
    }
  )
  return { text: dispatched.value, call: dispatched.call, usage: dispatched.usage }
}

/** Image-in, text-out. Receipt scan and vault expiry OCR. */
export async function vision(
  args: AiCtx & {
    access?: AiAccessHandle
    parts: AiContentPart[]
    json?: boolean
    timeoutMs?: number
    signal?: AbortSignal
  }
): Promise<AiResult> {
  const resolved = await resolveFor(args, 'vision')

  const dispatched = await dispatch(
    resolved,
    'vision',
    args.timeoutMs ?? AI_TIMEOUT_MS.vision,
    args.signal,
    async (context, adapter) => {
      const result = await adapter.complete(
        adapterRequest(context, 'vision', {
          // One user turn: the feature's prompt text and the image(s) it reads.
          // No thinking level: a vision OCR read wants a cheap deterministic
          // answer, and the schema forbids one on the vision capability.
          messages: [{ role: 'user', content: args.parts }],
          json: args.json ?? false,
          thinkingLevel: null,
        })
      )
      return { value: result.text, usage: result.usage }
    }
  )
  return { text: dispatched.value, call: dispatched.call, usage: dispatched.usage }
}

/**
 * One typed decision: a stated question, a closed choice list, a confidence.
 * Chat providers answer through their JSON mode; a `questions` provider answers
 * natively. The door guarantees the choice is in the list and a reported
 * confidence is clamped into [0,1] (`decision.ts`).
 */
export async function decide(
  args: AiCtx & {
    access?: AiAccessHandle
    ask: DecisionAsk
    timeoutMs?: number
    signal?: AbortSignal
  }
): Promise<DecisionResult> {
  const resolved = await resolveFor(args, 'decision')

  const dispatched = await dispatch(
    resolved,
    'decision',
    args.timeoutMs ?? AI_TIMEOUT_MS.decision,
    args.signal,
    async (context, adapter) => {
      const result = await adapter.decide({
        capability: 'decision',
        model: context.model,
        ask: args.ask,
        thinkingLevel: resolved.material.thinkingLevel,
        baseUrl: context.baseUrl,
        apiKey: context.apiKey,
        signal: context.signal,
      })
      // Belt over the adapter's own validation: the promise the facade makes.
      if (!args.ask.choices.includes(result.choice)) {
        throw new AdapterError(
          'invalid_response',
          `AI decision returned '${result.choice}', not one of the offered choices`,
          { usage: result.usage }
        )
      }
      const confidence =
        result.confidence == null ? null : Math.min(1, Math.max(0, result.confidence))
      return { value: { ...result, confidence }, usage: result.usage }
    }
  )

  const answer = dispatched.value
  return {
    choice: answer.choice,
    confidence: answer.confidence,
    reason: answer.reason,
    call: dispatched.call,
    usage: dispatched.usage,
  }
}

/**
 * The OTHER decision shape: a schema-constrained JSON DOCUMENT (quick-add:
 * items + qty + unit + store), not one choice. Same capability, different wire
 * requirement — only chat-shaped providers can serve it; a typed provider
 * answers `unsupported` until the household points decision at a chat provider.
 * No shipped feature uses this yet; the feature owns its schema.
 */
export async function structured<T>(
  args: AiCtx & {
    access?: AiAccessHandle
    messages: AiMessage[]
    validate: (raw: unknown) => T
    timeoutMs?: number
    signal?: AbortSignal
  }
): Promise<{ value: T; call: AiCall; usage: TokenUsage }> {
  const resolved = await resolveFor(args, 'decision')

  const dispatched = await dispatch(
    resolved,
    'decision',
    args.timeoutMs ?? AI_TIMEOUT_MS.decision,
    args.signal,
    async (context, adapter) => {
      if (!adapter.structured) {
        throw new AdapterError(
          'unsupported',
          `A '${resolved.handle.call.providerKind}' provider cannot answer a JSON document`
        )
      }
      const result = await adapter.structured(
        adapterRequest(context, 'decision', {
          messages: args.messages,
          json: true,
          thinkingLevel: resolved.material.thinkingLevel,
        })
      )
      let value: T
      try {
        value = args.validate(parseJsonResponse<unknown>(result.text))
      } catch (err) {
        throw new AdapterError(
          'invalid_response',
          `AI answer failed the feature's schema: ${err instanceof Error ? err.message : 'invalid'}`,
          { usage: result.usage }
        )
      }
      return { value, usage: result.usage }
    }
  )
  return { value: dispatched.value, call: dispatched.call, usage: dispatched.usage }
}

// --- usage accounting -------------------------------------------------------

/**
 * Usage accounting, beside the door so call sites never hand-build SQL. The
 * door does not write the row itself: the feature decides WHERE the event goes
 * (the review sweep batches one write per run), while the door keeps the one
 * shape of the row and the funding dimension (plan §2.5, §5.3).
 */
export {
  buildAiUsageEventStatement,
  deleteExpiredAiUsageEvents,
  recordAiUsageEvent,
  usageCollector,
} from './usage.js'
export type { AiUsageEvent } from './usage.js'

// The shared, fence-tolerant JSON reader for every structured answer.
export { parseJsonResponse } from './parse.js'
