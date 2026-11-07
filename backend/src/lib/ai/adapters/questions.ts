// `questions` — Jev's typed question/answer wire (owner decision D3, plan
// §5.4): one POST to the row's base URL with
//
//   {state, model, questions: {<name>: {type: 'choice', instructions, criteria}}}
//
// answering `answers.<name>.{choice, confidence}`. It answers CLOSED CHOICES
// only: no text completion, no vision, no JSON document, no reasoning knob
// (validated at save time; `supports()` is the call-time belt). The reason the
// review layer records under a typed provider is NULL — an accepted limitation.
//
// The wire reports no token counts, so usage is zeroes and `usageReported` is
// false; the usage row is distinguished by `provider = 'questions'` and the
// admin breakdown renders it as "typed — not token-billed" (plan §5.3).

import { providerFetch, readJson, responseError, trimBaseUrl } from './wire.js'
import {
  AdapterError,
  type AdapterRequest,
  type AdapterResult,
  type AiAdapter,
  type DecisionAdapterRequest,
  type DecisionAdapterResult,
} from './types.js'
import type { Capability, TokenUsage } from '../types.js'

const LABEL = 'Typed decision provider'

/** The single question key this adapter asks (one decision per call). */
export const TYPED_QUESTION_NAME = 'verdict'

export const TYPED_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0, cached_tokens: null }

type SystemOneResponse = {
  answers?: Record<string, { choice?: unknown; confidence?: unknown }>
}

async function complete(_req: AdapterRequest): Promise<AdapterResult> {
  // Unreachable when `supports()` is honoured; typed rows have no chat wire.
  throw new AdapterError('unsupported', `${LABEL} cannot answer text completions`)
}

async function decide(req: DecisionAdapterRequest): Promise<DecisionAdapterResult> {
  if (!req.baseUrl) {
    throw new AdapterError('provider_error', `${LABEL} requires a base URL`)
  }
  const instructions = `${req.ask.question}\nAnswer with exactly one of: ${req.ask.choices.join(', ')}`
  const body = {
    state: req.ask.state,
    model: req.model,
    questions: {
      [TYPED_QUESTION_NAME]: {
        type: 'choice',
        instructions,
        criteria: req.ask.criteria ?? '',
      },
    },
  }

  const res = await providerFetch(LABEL, trimBaseUrl(req.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  if (!res.ok) throw await responseError(LABEL, res)

  const data = await readJson<SystemOneResponse>(LABEL, res)
  const answer = data.answers?.[TYPED_QUESTION_NAME]
  const choice = answer?.choice
  const confidence = answer?.confidence

  if (typeof choice !== 'string' || !req.ask.choices.includes(choice)) {
    throw new AdapterError(
      'invalid_response',
      `${LABEL} returned no choice from the offered list`,
      { usage: TYPED_USAGE }
    )
  }
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    // D3's contract is choice + confidence; a missing number is an off-schema
    // answer, not an accepted "no confidence" (that tolerance is for chat JSON).
    throw new AdapterError('invalid_response', `${LABEL} returned no numeric confidence`, {
      usage: TYPED_USAGE,
    })
  }

  return {
    choice,
    confidence: Math.min(1, Math.max(0, confidence)),
    reason: null,
    usage: TYPED_USAGE,
    usageReported: false,
  }
}

export const questionsAdapter: AiAdapter = {
  kind: 'questions',
  supports(capability: Capability): boolean {
    return capability === 'decision'
  },
  complete,
  decide,
}
