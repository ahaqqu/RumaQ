// `openai-compatible` — the chat-completions wire (plan §5.4). Serves OpenAI,
// OpenCode, Ollama Cloud and any custom base URL with the same body; only two
// quirks vary by ENDPOINT and they live here, next to the wire they belong to:
//
//   - token cap field: OpenAI-proper rejects `max_tokens` on reasoning models
//     and wants `max_completion_tokens`; every other server speaks `max_tokens`.
//   - Ollama gets NO cap at all: its reasoning models spend thousands of tokens
//     thinking before the JSON content, and the key owner pays per actual token
//     anyway (the model's context window is the only limit).
//
// The provider LABEL in error messages ("OpenAI request failed: 500 …") is the
// existing route-test contract (plan §5.2), so it is derived from the endpoint
// here rather than from a capability or a model.

import { decideViaPrompt } from './chat-decide.js'
import {
  hostOf,
  providerFetch,
  readJson,
  requireText,
  responseError,
  toDataUri,
  trimBaseUrl,
} from './wire.js'
import {
  AdapterError,
  type AdapterRequest,
  type AdapterResult,
  type AiAdapter,
  type DecisionAdapterRequest,
  type DecisionAdapterResult,
} from './types.js'
import type { AiContentPart, AiMessage, Capability, TokenUsage } from '../types.js'

type OpenAIChatMessage =
  | { role: 'system' | 'assistant'; content: string }
  | {
      role: 'user'
      content:
        | string
        | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
    }

type OpenAIResponse = {
  choices?: Array<{ message?: { content?: string } }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

type OpenAIBody = {
  model: string
  messages: OpenAIChatMessage[]
  max_tokens?: number
  max_completion_tokens?: number
  reasoning_effort?: string
  response_format?: { type: 'json_object' }
}

const OPENAI_HOST = 'api.openai.com'
const OPENCODE_HOST = 'api.opencode.ai'
const OLLAMA_HOST = 'ollama.com'

function labelFor(baseUrl: string): string {
  switch (hostOf(baseUrl)) {
    case OPENAI_HOST:
      return 'OpenAI'
    case OPENCODE_HOST:
      return 'OpenCode'
    case OLLAMA_HOST:
      return 'Ollama Cloud'
    default:
      return 'Provider'
  }
}

function toOpenAIContent(
  parts: AiContentPart[]
): Extract<OpenAIChatMessage, { role: 'user' }>['content'] {
  return parts.map((part) =>
    part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : { type: 'image_url' as const, image_url: { url: toDataUri(part.bytes, part.mimeType) } }
  )
}

function toOpenAIMessages(messages: AiMessage[]): OpenAIChatMessage[] {
  return messages.map((message) => {
    if (message.role === 'user') {
      return {
        role: 'user',
        content:
          typeof message.content === 'string' ? message.content : toOpenAIContent(message.content),
      }
    }
    return { role: message.role, content: message.content }
  })
}

function mapUsage(data: OpenAIResponse): { usage: TokenUsage; reported: boolean } {
  const usage = data.usage
  if (!usage) {
    return { usage: { input_tokens: 0, output_tokens: 0, cached_tokens: null }, reported: false }
  }
  return {
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? null,
    },
    reported: true,
  }
}

async function complete(req: AdapterRequest): Promise<AdapterResult> {
  if (!req.baseUrl) {
    throw new AdapterError('provider_error', 'OpenAI-compatible provider requires a base URL')
  }
  const baseUrl = trimBaseUrl(req.baseUrl)
  const label = labelFor(baseUrl)
  const host = hostOf(baseUrl)

  const body: OpenAIBody = { model: req.model, messages: toOpenAIMessages(req.messages) }
  if (req.maxTokens !== undefined && host !== OLLAMA_HOST) {
    if (host === OPENAI_HOST) body.max_completion_tokens = req.maxTokens
    else body.max_tokens = req.maxTokens
  }
  if (req.thinkingLevel) body.reasoning_effort = req.thinkingLevel
  if (req.json) body.response_format = { type: 'json_object' }

  const res = await providerFetch(label, `${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  if (!res.ok) throw await responseError(label, res)

  const data = await readJson<OpenAIResponse>(label, res)
  const { usage, reported } = mapUsage(data)
  const text = requireText(label, data.choices?.[0]?.message?.content, reported ? usage : undefined)

  return { text, usage, usageReported: reported }
}

async function structured(req: AdapterRequest): Promise<AdapterResult> {
  return complete({ ...req, json: true })
}

async function decide(req: DecisionAdapterRequest): Promise<DecisionAdapterResult> {
  if (!req.baseUrl) {
    throw new AdapterError('provider_error', 'OpenAI-compatible provider requires a base URL')
  }
  return decideViaPrompt(labelFor(req.baseUrl), complete, req)
}

export const openaiAdapter: AiAdapter = {
  kind: 'openai-compatible',
  supports(_capability: Capability): boolean {
    return true
  },
  complete,
  decide,
  structured,
}
