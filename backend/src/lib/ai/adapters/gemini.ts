// `gemini` — the generateContent wire (plan §5.4). A separate kind from
// `openai-compatible` because the shape is genuinely different: `contents` /
// `parts`, a `systemInstruction`, `usageMetadata`, and thinking expressed as a
// token budget.
//
// The system prompt goes in `systemInstruction` (the plan's preferred form;
// the pre-P2 dispatcher folded it into the first text part). The model is a URL
// path segment, so it is percent-encoded — save-time validation already
// restricts its charset, and this keeps that true for hand-written rows too.

import { decideViaPrompt } from './chat-decide.js'
import { arrayBufferToBase64, providerFetch, readJson, requireText, responseError } from './wire.js'
import {
  type AdapterRequest,
  type AdapterResult,
  type AiAdapter,
  type DecisionAdapterRequest,
  type DecisionAdapterResult,
  type ProbeRequest,
} from './types.js'
import type { AiContentPart, AiMessage, Capability, ThinkingLevel, TokenUsage } from '../types.js'

const LABEL = 'Gemini'
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta'

// Gemini exposes thinking as a token budget on thinking-capable models.
const THINKING_BUDGET: Record<ThinkingLevel, number> = {
  low: 1024,
  medium: 8192,
  high: 24576,
}

type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } }

type GeminiBody = {
  contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }>
  systemInstruction?: { parts: Array<{ text: string }> }
  generationConfig?: {
    thinkingConfig?: { thinkingBudget: number }
    responseMimeType?: 'application/json'
  }
}

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
    cachedContentTokenCount?: number
  }
}

function toGeminiParts(content: string | AiContentPart[]): GeminiPart[] {
  if (typeof content === 'string') return [{ text: content }]
  return content.map((part) =>
    part.type === 'text'
      ? { text: part.text }
      : {
          inline_data: {
            mime_type: part.mimeType,
            data: arrayBufferToBase64(part.bytes),
          },
        }
  )
}

function buildBody(req: AdapterRequest): GeminiBody {
  const system = req.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')

  const contents: GeminiBody['contents'] = req.messages
    .filter(
      (message): message is Exclude<AiMessage, { role: 'system' }> => message.role !== 'system'
    )
    .map((message) => ({
      role: message.role === 'assistant' ? ('model' as const) : ('user' as const),
      parts: toGeminiParts(message.content),
    }))

  const body: GeminiBody = { contents }
  if (system.length > 0) body.systemInstruction = { parts: [{ text: system }] }
  if (req.thinkingLevel || req.json) {
    body.generationConfig = {}
    if (req.thinkingLevel) {
      body.generationConfig.thinkingConfig = { thinkingBudget: THINKING_BUDGET[req.thinkingLevel] }
    }
    if (req.json) body.generationConfig.responseMimeType = 'application/json'
  }
  return body
}

function mapUsage(data: GeminiResponse): { usage: TokenUsage; reported: boolean } {
  const meta = data.usageMetadata
  if (!meta) {
    return { usage: { input_tokens: 0, output_tokens: 0, cached_tokens: null }, reported: false }
  }
  return {
    usage: {
      input_tokens: meta.promptTokenCount ?? 0,
      // Thinking tokens are billed output; the pre-P2 dispatcher counted them.
      output_tokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
      cached_tokens: meta.cachedContentTokenCount ?? null,
    },
    reported: true,
  }
}

async function complete(req: AdapterRequest): Promise<AdapterResult> {
  const model = encodeURIComponent(req.model)
  const url = `${ENDPOINT}/models/${model}:generateContent?key=${encodeURIComponent(req.apiKey)}`

  const res = await providerFetch(LABEL, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBody(req)),
    signal: req.signal,
  })
  if (!res.ok) throw await responseError(LABEL, res)

  const data = await readJson<GeminiResponse>(LABEL, res)
  const { usage, reported } = mapUsage(data)
  // A thought part is not the answer; join the real text parts (a long answer
  // can be split across several).
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('')
  return {
    text: requireText(LABEL, text, reported ? usage : undefined),
    usage,
    usageReported: reported,
  }
}

async function structured(req: AdapterRequest): Promise<AdapterResult> {
  return complete({ ...req, json: true })
}

async function decide(req: DecisionAdapterRequest): Promise<DecisionAdapterResult> {
  return decideViaPrompt(LABEL, complete, req)
}

// Free authentication check (plan §4.6): the models listing uses the same API
// key as generateContent and bills nothing. The endpoint is CANONICAL here for
// the same reason it is in `complete` below: this wire builds its URL from
// ENDPOINT, so probing a row's `base_url` would test an endpoint the call never
// reaches (#523 P3 review A4). A `gemini` row's stored base URL is inert, exactly
// as it is for the call path.
async function probe(req: ProbeRequest): Promise<void> {
  const res = await providerFetch(
    LABEL,
    `${ENDPOINT}/models?key=${encodeURIComponent(req.apiKey)}`,
    {
      method: 'GET',
      signal: req.signal,
    }
  )
  if (!res.ok) throw await responseError(LABEL, res)
}

export const geminiAdapter: AiAdapter = {
  kind: 'gemini',
  supports(_capability: Capability): boolean {
    return true
  },
  complete,
  decide,
  structured,
  probe,
}
