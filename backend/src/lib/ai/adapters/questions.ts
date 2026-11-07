// `questions` — OpenRouter's typed question/answer wire (owner decision D3,
// plan §5.4, amended in §9): one POST to the row's base URL with
//
//   {state: [<state>], model,
//    questions: {<name>: {type: 'choice', instructions, criteria: {<choice>: <criterion>}}}}
//
// answering `answers.<name>.{choice, confidence, probabilities}`. It answers
// CLOSED CHOICES only: no text completion, no vision, no JSON document, no
// reasoning knob (validated at save time; `supports()` is the call-time belt).
// The reason the review layer records under a typed provider is NULL — an
// accepted limitation.
//
// The wire shape is OpenRouter's, and the direct-typesafe shape is RETIRED
// (§9), not dual-supported: `state` is an ARRAY of strings, and `criteria` is
// a RECORD keyed by the allowed choice — the old string state and rubric
// string were never accepted here (a live probe returned 400 for both). The
// ask's rubric is shared rather than per-choice, so it is sent verbatim under
// every allowed choice; the question and the choice list ride `instructions`.
//
// The response is a SUPERSET — `type`, `probabilities`, `usage.{input_tokens,
// output_tokens, cost, …}`, `model`, `provider`, `id`. Extra keys are ignored
// (never an error): a missing/invalid `answers.<name>` is still a typed
// `invalid_response`. `probabilities` stays on the parsed envelope for a
// later confidence-calibration use; it is not surfaced here. Usage stays
// zeroes with `usageReported: false` — the usage row is distinguished by
// `provider = 'questions'` and the admin breakdown renders it as "typed — not
// token-billed" (plan §5.3). OpenRouter does report usage now; folding it in
// is a separate metering decision (§9).

import { providerFetch, readJson, responseError, trimBaseUrl } from './wire.js'
import {
  AdapterError,
  type AdapterRequest,
  type AdapterResult,
  type AiAdapter,
  type DecisionAdapterRequest,
  type DecisionAdapterResult,
  type ProbeRequest,
} from './types.js'
import type { Capability, TokenUsage } from '../types.js'

const LABEL = 'Typed decision provider'

/** The single question key this adapter asks (one decision per call). */
export const TYPED_QUESTION_NAME = 'verdict'

export const TYPED_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0, cached_tokens: null }

/**
 * The answer envelope as far as this adapter reads it. `probabilities` is part
 * of the wire and deliberately kept here (confidence calibration is a later
 * use); `type`, `usage`, `model`, `provider` and `id` are ignored extras — the
 * envelope is a superset and extra keys are never an error.
 */
type DecisionsResponse = {
  answers?: Record<
    string,
    {
      type?: unknown
      choice?: unknown
      confidence?: unknown
      probabilities?: Record<string, unknown>
    }
  >
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
  // OpenRouter's `criteria` is a RECORD keyed by the allowed choice — it IS
  // the answer vocabulary, so the keys are exactly `ask.choices`. The ask's
  // rubric is shared (not per-choice), so the verbatim rubric rides every
  // choice's criterion; with no rubric the choice label is its own criterion.
  const rubric = req.ask.criteria?.trim() || null
  const criteria = Object.fromEntries(req.ask.choices.map((choice) => [choice, rubric ?? choice]))
  const body = {
    state: [req.ask.state],
    model: req.model,
    questions: {
      [TYPED_QUESTION_NAME]: {
        type: 'choice',
        instructions,
        criteria,
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

  const data = await readJson<DecisionsResponse>(LABEL, res)
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

/**
 * Free authentication check (plan §4.6): POST the endpoint with an EMPTY
 * `questions` object. The expected 400/422 proves the bearer key authenticates
 * while buying no answer; any 2xx is also proof. Only 401/403 (auth) and the
 * rest of the failure vocabulary are a failed probe. This is deliberate — a
 * well-formed micro-question would be billed on every "Test" click.
 *
 * PENDING (owner manual action, #523 §7.2 #6): confirm the endpoint 400s on an
 * empty body rather than 500ing or billing; the documented fallback is the
 * billed micro-question.
 */
async function probe(req: ProbeRequest): Promise<void> {
  if (!req.baseUrl) {
    throw new AdapterError('provider_error', `${LABEL} requires a base URL`)
  }
  const res = await providerFetch(LABEL, trimBaseUrl(req.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify({ state: [], model: req.model ?? '', questions: {} }),
    signal: req.signal,
  })
  if (res.ok || res.status === 400 || res.status === 422) return
  throw await responseError(LABEL, res)
}

export const questionsAdapter: AiAdapter = {
  kind: 'questions',
  supports(capability: Capability): boolean {
    return capability === 'decision'
  },
  complete,
  decide,
  probe,
}
