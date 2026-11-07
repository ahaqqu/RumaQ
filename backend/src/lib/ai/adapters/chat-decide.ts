// The prompt + strict-JSON path shared by the chat-shaped adapters' `decide()`
// (plan §2.4: "Chat adapters do prompt + strict JSON parse"). The typed
// `questions` adapter does NOT use this file — it answers the same shape
// natively.

import { buildDecisionPrompt, parseDecisionAnswer } from '../decision.js'
import {
  AdapterError,
  type AdapterRequest,
  type AdapterResult,
  type DecisionAdapterRequest,
  type DecisionAdapterResult,
} from './types.js'

export async function decideViaPrompt(
  label: string,
  complete: (req: AdapterRequest) => Promise<AdapterResult>,
  req: DecisionAdapterRequest
): Promise<DecisionAdapterResult> {
  const prompt = buildDecisionPrompt(req.ask)
  const result = await complete({
    capability: 'decision',
    model: req.model,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    json: true,
    thinkingLevel: req.thinkingLevel,
    maxTokens: req.maxTokens,
    baseUrl: req.baseUrl,
    apiKey: req.apiKey,
    signal: req.signal,
  })

  try {
    const answer = parseDecisionAnswer(req.ask, result.text)
    return {
      choice: answer.choice,
      confidence: answer.confidence,
      reason: answer.reason,
      usage: result.usage,
      usageReported: result.usageReported,
    }
  } catch (err) {
    throw new AdapterError(
      'invalid_response',
      `${label} returned an off-schema decision: ${err instanceof Error ? err.message : 'invalid answer'}`,
      { usage: result.usage }
    )
  }
}
