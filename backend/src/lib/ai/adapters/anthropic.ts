// `anthropic` — the Messages API wire (plan §5.4). The endpoint is canonical
// (a row's base URL cannot move it), the system prompt is top-level, thinking
// is a token budget that `max_tokens` must exceed, and cache-read tokens are
// deliberately NOT folded into `cached_tokens`: Anthropic's
// `cache_read_input_tokens` are not part of `input_tokens`, so treating them as
// a cached/input ratio would exceed 1 and misstate the cache hit rate.

import { decideViaPrompt } from './chat-decide.js'
import { arrayBufferToBase64, providerFetch, readJson, requireText, responseError } from './wire.js'
import {
  type AdapterRequest,
  type AdapterResult,
  type AiAdapter,
  type DecisionAdapterRequest,
  type DecisionAdapterResult,
} from './types.js'
import type { AiContentPart, AiMessage, Capability, ThinkingLevel, TokenUsage } from '../types.js'

const LABEL = 'Anthropic'
const ENDPOINT = 'https://api.anthropic.com/v1/messages'

// Extended thinking requires budget_tokens >= 1024 and max_tokens > budget.
const THINKING_BUDGET: Record<ThinkingLevel, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
}

type AnthropicContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

type AnthropicMessage = { role: 'user' | 'assistant'; content: string | AnthropicContentPart[] }

type AnthropicBody = {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
  system?: string
  thinking?: { type: 'enabled'; budget_tokens: number }
}

type AnthropicResponse = {
  content?: Array<{ type?: string; text?: string }>
  usage?: { input_tokens?: number; output_tokens?: number }
}

function toAnthropicContent(parts: AiContentPart[]): AnthropicContentPart[] {
  return parts.map((part) =>
    part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: part.mimeType,
            data: arrayBufferToBase64(part.bytes),
          },
        }
  )
}

function splitSystem(messages: AiMessage[]): { system: string | null; rest: AnthropicMessage[] } {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
  const rest = messages
    .filter(
      (message): message is Exclude<AiMessage, { role: 'system' }> => message.role !== 'system'
    )
    .map((message) => ({
      role: message.role,
      content:
        typeof message.content === 'string' ? message.content : toAnthropicContent(message.content),
    }))
  return { system: system.length > 0 ? system : null, rest }
}

function mapUsage(data: AnthropicResponse): { usage: TokenUsage; reported: boolean } {
  if (!data.usage) {
    return { usage: { input_tokens: 0, output_tokens: 0, cached_tokens: null }, reported: false }
  }
  return {
    usage: {
      input_tokens: data.usage.input_tokens ?? 0,
      output_tokens: data.usage.output_tokens ?? 0,
      cached_tokens: null,
    },
    reported: true,
  }
}

async function complete(req: AdapterRequest): Promise<AdapterResult> {
  const { system, rest } = splitSystem(req.messages)
  const thinkingBudget = req.thinkingLevel ? THINKING_BUDGET[req.thinkingLevel] : null

  const body: AnthropicBody = {
    model: req.model,
    // With thinking on, the cap must exceed the budget; a caller-supplied cap
    // is honoured as a floor so it can never invalidate the request.
    max_tokens: thinkingBudget
      ? Math.max(req.maxTokens ?? 2000, thinkingBudget + 2000)
      : (req.maxTokens ?? 2000),
    messages: rest,
  }
  if (system) body.system = system
  if (thinkingBudget) body.thinking = { type: 'enabled', budget_tokens: thinkingBudget }

  const res = await providerFetch(LABEL, ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': req.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  if (!res.ok) throw await responseError(LABEL, res)

  const data = await readJson<AnthropicResponse>(LABEL, res)
  const { usage, reported } = mapUsage(data)
  // Only `text` blocks are the answer; a `thinking` block is not content.
  const text = (data.content ?? [])
    .filter((block) => block.type === undefined || block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
  return {
    text: requireText(LABEL, text, reported ? usage : undefined),
    usage,
    usageReported: reported,
  }
}

async function structured(req: AdapterRequest): Promise<AdapterResult> {
  // Anthropic has no JSON mode; the prompt asks for JSON and the feature's
  // parser is the gate (plan §5.4: "none (prompt only)").
  return complete({ ...req, json: false })
}

async function decide(req: DecisionAdapterRequest): Promise<DecisionAdapterResult> {
  return decideViaPrompt(LABEL, complete, req)
}

export const anthropicAdapter: AiAdapter = {
  kind: 'anthropic',
  supports(_capability: Capability): boolean {
    return true
  },
  complete,
  decide,
  structured,
}
