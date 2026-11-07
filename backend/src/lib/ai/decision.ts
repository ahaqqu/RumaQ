// The decision shape shared by every chat-shaped decision call (plan §2.1:
// "decision.ts — the {choice, confidence} parse shared by chat-shaped decision
// calls"). A chat provider answers `decide()` by prompt + strict JSON; the
// `questions` adapter answers the SAME shape natively, so it does not use the
// prompt here but does use the same validation contract.
//
// The door guarantees "the choice is in the list, the confidence is a number in
// [0,1]" (plan §2.5): the choice is membership-checked, a reported confidence
// is clamped, and `reason` — which the typed wire never returns — stays null.

import type { DecisionAsk } from './types.js'
import { parseJsonResponse } from './parse.js'

export type ParsedDecisionAnswer = {
  choice: string
  confidence: number | null
  reason: string | null
}

/** The system + user prompt a chat provider answers to produce a DecisionAsk. */
export function buildDecisionPrompt(ask: DecisionAsk): { system: string; user: string } {
  return {
    system:
      'You are a strict decision assistant. Decide ONE question about the state you are given. ' +
      'Reply with ONLY JSON in this exact shape: ' +
      '{"choice":"<one of the allowed choices>","confidence":0..1,"reason":"one short sentence"}. ' +
      'No prose outside the JSON, no code fences.',
    user: [
      `State:\n${ask.state}`,
      `Question: ${ask.question}`,
      ...(ask.criteria ? [`Criteria:\n${ask.criteria}`] : []),
      `Allowed choices:\n${ask.choices.map((choice) => `- ${choice}`).join('\n')}`,
    ].join('\n\n'),
  }
}

/**
 * Validate one decision answer against the closed choice list. Throws a plain
 * Error with a caller-facing reason; adapters wrap it as `invalid_response`.
 */
export function parseDecisionAnswer(ask: DecisionAsk, content: string): ParsedDecisionAnswer {
  const raw = parseJsonResponse<Record<string, unknown>>(content)

  const choice = raw.choice
  if (typeof choice !== 'string' || !ask.choices.includes(choice)) {
    throw new Error(
      `choice ${JSON.stringify(String(choice)).slice(0, 80)} is not one of the offered choices`
    )
  }

  let confidence: number | null = null
  const reported = raw.confidence
  if (reported !== undefined && reported !== null) {
    if (typeof reported !== 'number' || !Number.isFinite(reported)) {
      throw new Error('confidence is not a number')
    }
    // The door PROMISES a confidence in [0,1]: a model that answers 1.2 is
    // clamped, not failed (the same posture as the review verdict parser).
    confidence = Math.min(1, Math.max(0, reported))
  }

  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : null

  return { choice, confidence, reason: reason ? reason : null }
}
