import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { adapterFor, ADAPTER_KINDS } from '../lib/ai/adapters/registry.js'
import type { AiAdapter } from '../lib/ai/adapters/types.js'
import type { DecisionAsk, ProviderKind, TokenUsage } from '../lib/ai/types.js'

// The ADAPTER CONTRACT (ahaqqu/RumaQ#523 P2, plan §6 P2): one table of cases ×
// the four wire kinds, driven by a fake fetch. Every adapter must answer the
// same questions — happy path, auth error, 429, 5xx, empty content, an aborted
// signal and usage mapping — because the facade above them knows nothing about
// a wire. The suite talks to the adapters directly (no database, no facade):
// that is the seam the door isolates.

const MODEL = 'test-model'
const API_KEY = 'sk-test'
const ASK: DecisionAsk = {
  state: 'Susu cair 1L',
  question: 'Are these the same product?',
  criteria: '- same: identical product\n- different: not the same product',
  choices: ['same', 'different'],
}

type JsonResponseInit = {
  ok?: boolean
  status?: number
  headers?: Record<string, string>
}

/** A Response-shaped object: only the surface the adapters read. */
function fakeResponse(body: unknown, init: JsonResponseInit = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? {}),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

type Invocation = {
  text?: string
  choice?: string
  usage: TokenUsage
  usageReported: boolean
}

type KindHarness = {
  kind: ProviderKind
  label: string
  baseUrl: string | null
  invoke: (adapter: AiAdapter, signal: AbortSignal) => Promise<Invocation>
  happy: () => Response
  empty: () => Response
  expectedUsage: TokenUsage
  expectedReported: boolean
  assertHappyRequest: (url: string, init: RequestInit) => void
}

function completeRequest(baseUrl: string | null, signal: AbortSignal) {
  return {
    capability: 'reasoning' as const,
    model: MODEL,
    messages: [
      { role: 'system' as const, content: 'You are a helper.' },
      { role: 'user' as const, content: 'hello' },
    ],
    json: false,
    thinkingLevel: 'low' as const,
    maxTokens: 100,
    baseUrl,
    apiKey: API_KEY,
    signal,
  }
}

function decideRequest(baseUrl: string | null, signal: AbortSignal) {
  return {
    capability: 'decision' as const,
    model: MODEL,
    ask: ASK,
    thinkingLevel: 'low' as const,
    maxTokens: 100,
    baseUrl,
    apiKey: API_KEY,
    signal,
  }
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name)
}

const HARNESSES: readonly KindHarness[] = [
  {
    kind: 'openai-compatible',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    expectedUsage: { input_tokens: 1000, output_tokens: 200, cached_tokens: 700 },
    expectedReported: true,
    invoke: async (adapter, signal) => {
      const result = await adapter.complete(completeRequest('https://api.openai.com/v1', signal))
      return { text: result.text, usage: result.usage, usageReported: result.usageReported }
    },
    happy: () =>
      fakeResponse({
        choices: [{ message: { content: 'hello from openai' } }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          prompt_tokens_details: { cached_tokens: 700 },
        },
      }),
    empty: () => fakeResponse({ choices: [{ message: { content: '' } }] }),
    assertHappyRequest: (url, init) => {
      expect(url).toBe('https://api.openai.com/v1/chat/completions')
      expect(headerOf(init, 'authorization')).toBe(`Bearer ${API_KEY}`)
      const body = bodyOf(init)
      expect(body.model).toBe(MODEL)
      expect(body.messages).toEqual([
        { role: 'system', content: 'You are a helper.' },
        { role: 'user', content: 'hello' },
      ])
      // OpenAI-proper takes max_completion_tokens; reasoning_effort is the knob.
      expect(body.max_completion_tokens).toBe(100)
      expect(body.max_tokens).toBeUndefined()
      expect(body.reasoning_effort).toBe('low')
      expect(body.response_format).toBeUndefined()
    },
  },
  {
    kind: 'anthropic',
    label: 'Anthropic',
    baseUrl: null,
    expectedUsage: { input_tokens: 1000, output_tokens: 200, cached_tokens: null },
    expectedReported: true,
    invoke: async (adapter, signal) => {
      const result = await adapter.complete(completeRequest(null, signal))
      return { text: result.text, usage: result.usage, usageReported: result.usageReported }
    },
    happy: () =>
      fakeResponse({
        content: [{ type: 'text', text: 'hello from anthropic' }],
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 900 },
      }),
    empty: () => fakeResponse({ content: [] }),
    assertHappyRequest: (url, init) => {
      expect(url).toBe('https://api.anthropic.com/v1/messages')
      expect(headerOf(init, 'x-api-key')).toBe(API_KEY)
      expect(headerOf(init, 'anthropic-version')).toBe('2023-06-01')
      const body = bodyOf(init)
      expect(body.model).toBe(MODEL)
      // The system prompt is top-level, not a message.
      expect(body.system).toBe('You are a helper.')
      expect(body.messages).toEqual([{ role: 'user', content: 'hello' }])
      // Extended thinking: low = 2048, and max_tokens must exceed the budget.
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 })
      expect(Number(body.max_tokens)).toBeGreaterThan(2048)
    },
  },
  {
    kind: 'gemini',
    label: 'Gemini',
    baseUrl: null,
    expectedUsage: { input_tokens: 1000, output_tokens: 260, cached_tokens: 700 },
    expectedReported: true,
    invoke: async (adapter, signal) => {
      const result = await adapter.complete(completeRequest(null, signal))
      return { text: result.text, usage: result.usage, usageReported: result.usageReported }
    },
    happy: () =>
      fakeResponse({
        candidates: [{ content: { parts: [{ text: 'hello from gemini' }] } }],
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 200,
          thoughtsTokenCount: 60,
          cachedContentTokenCount: 700,
        },
      }),
    empty: () => fakeResponse({ candidates: [{ content: { parts: [] } }] }),
    assertHappyRequest: (url, init) => {
      expect(url).toBe(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`
      )
      const body = bodyOf(init)
      expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are a helper.' }] })
      expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }])
      // Thinking is a token budget in generationConfig.
      expect(body.generationConfig).toEqual({ thinkingConfig: { thinkingBudget: 1024 } })
    },
  },
  {
    kind: 'questions',
    label: 'Typed decision provider',
    // The ONE questions endpoint: OpenRouter's decisions wire (plan §9).
    baseUrl: 'https://openrouter.ai/api/alpha/decisions',
    // The typed wire reports no token counts: zeroes, distinguished by kind.
    // OpenRouter's `usage` is a superset key and is deliberately not read yet.
    expectedUsage: { input_tokens: 0, output_tokens: 0, cached_tokens: null },
    expectedReported: false,
    invoke: async (adapter, signal) => {
      const baseUrl = 'https://openrouter.ai/api/alpha/decisions'
      const result = await adapter.decide(decideRequest(baseUrl, signal))
      return {
        choice: result.choice,
        usage: result.usage,
        usageReported: result.usageReported,
      }
    },
    happy: () =>
      fakeResponse({
        // A real OpenRouter envelope: extra keys are ignored, never an error.
        model: 'typesafe/jev-1.14-20261014',
        provider: 'TypeSafe',
        id: 'gen-dec-test',
        answers: {
          verdict: {
            type: 'choice',
            choice: 'same',
            confidence: 0.91,
            probabilities: { same: 0.91, different: 0.09 },
          },
        },
        usage: { input_tokens: 100, output_tokens: 20, cost: 0.000001 },
      }),
    empty: () => fakeResponse({ answers: { verdict: {} } }),
    assertHappyRequest: (url, init) => {
      expect(url).toBe('https://openrouter.ai/api/alpha/decisions')
      expect(headerOf(init, 'authorization')).toBe(`Bearer ${API_KEY}`)
      const body = bodyOf(init)
      // OpenRouter's contract: `state` is an ARRAY, `criteria` is a RECORD
      // keyed by the allowed choice (the direct-typesafe shape is retired).
      expect(body.state).toEqual([ASK.state])
      expect(body.model).toBe(MODEL)
      const questions = body.questions as Record<
        string,
        { type: string; instructions: string; criteria: Record<string, string> }
      >
      expect(questions.verdict?.type).toBe('choice')
      expect(questions.verdict?.instructions).toContain(ASK.question)
      expect(questions.verdict?.instructions).toContain('same')
      expect(questions.verdict?.criteria).toEqual({
        same: ASK.criteria,
        different: ASK.criteria,
      })
    },
  },
]

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

describe.each(HARNESSES)('adapter contract — $kind', (harness) => {
  const adapter = adapterFor(harness.kind)
  const signal = new AbortController().signal

  it('happy path: dispatches one shaped request and returns the answer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(harness.happy())
    globalThis.fetch = fetchMock

    const result = await harness.invoke(adapter, signal)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    harness.assertHappyRequest(url, init)

    if (harness.kind === 'questions') {
      expect(result.choice).toBe('same')
    } else {
      expect(result.text).toBe(
        `hello from ${harness.kind === 'openai-compatible' ? 'openai' : harness.kind}`
      )
    }
    // Usage mapping is part of the contract: every provider's token fields map
    // onto the ONE TokenUsage shape (typed = zeroes, marked by the kind).
    expect(result.usage).toEqual(harness.expectedUsage)
    expect(result.usageReported).toBe(harness.expectedReported)
  })

  it('401 maps to auth, with the provider status and no key echo', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        fakeResponse(`${harness.label} says nope ${API_KEY}`, { ok: false, status: 401 })
      )

    const error = await harness.invoke(adapter, signal).catch((err: unknown) => err)
    expect(error).toMatchObject({ code: 'auth', detail: { providerStatus: 401 } })
    // The failure message keeps the provider label (§5.2 route-test contract).
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(harness.label)
    expect((error as Error).message).toContain('401')
  })

  it('429 maps to rate_limited and surfaces Retry-After without sleeping', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        fakeResponse('slow down', { ok: false, status: 429, headers: { 'retry-after': '7' } })
      )

    await expect(harness.invoke(adapter, signal)).rejects.toMatchObject({
      code: 'rate_limited',
      detail: { providerStatus: 429, retryAfterSeconds: 7 },
    })
  })

  it('5xx maps to provider_error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse('boom', { ok: false, status: 503 }))

    await expect(harness.invoke(adapter, signal)).rejects.toMatchObject({
      code: 'provider_error',
      detail: { providerStatus: 503 },
    })
  })

  it('empty content is invalid_response, never an empty answer', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(harness.empty())

    await expect(harness.invoke(adapter, signal)).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('an aborted signal maps to timeout', async () => {
    const controller = new AbortController()
    controller.abort()
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'))

    await expect(harness.invoke(adapter, controller.signal)).rejects.toMatchObject({
      code: 'timeout',
    })
  })
})

describe('decide() shape across the chat kinds vs the typed kind', () => {
  const ANSWER = '{"choice":"same","confidence":0.6,"reason":"same packaging"}'

  const CHAT_KINDS: ReadonlyArray<{
    kind: ProviderKind
    baseUrl: string | null
    happy: () => Response
    body: (init: RequestInit) => Record<string, unknown>
  }> = [
    {
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      happy: () => fakeResponse({ choices: [{ message: { content: ANSWER } }] }),
      body: (init) => bodyOf(init),
    },
    {
      kind: 'anthropic',
      baseUrl: null,
      happy: () => fakeResponse({ content: [{ type: 'text', text: ANSWER }] }),
      body: (init) => bodyOf(init),
    },
    {
      kind: 'gemini',
      baseUrl: null,
      happy: () => fakeResponse({ candidates: [{ content: { parts: [{ text: ANSWER }] } }] }),
      body: (init) => bodyOf(init),
    },
  ]

  for (const chat of CHAT_KINDS) {
    it(`${chat.kind}: prompts, parses and reports the same {choice, confidence, reason}`, async () => {
      const fetchMock = vi.fn().mockResolvedValue(chat.happy())
      globalThis.fetch = fetchMock
      const signal = new AbortController().signal

      const result = await adapterFor(chat.kind).decide(decideRequest(chat.baseUrl, signal))

      expect(result).toMatchObject({
        choice: 'same',
        confidence: 0.6,
        reason: 'same packaging',
        usage: { input_tokens: 0, output_tokens: 0, cached_tokens: null },
        usageReported: false,
      })
      const body = chat.body(fetchMock.mock.calls[0]![1] as RequestInit)
      // The prompt carries the closed choice list; the model answers JSON.
      expect(JSON.stringify(body)).toContain('Allowed choices')
      expect(JSON.stringify(body)).toContain('same')
    })
  }

  it('questions: the same decision, answered natively, with reason null', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({
        answers: {
          verdict: {
            type: 'choice',
            choice: 'different',
            confidence: 0.4,
            probabilities: { same: 0.6, different: 0.4 },
          },
        },
        usage: { input_tokens: 10, output_tokens: 5, cost: 0.0000004 },
      })
    )
    const signal = new AbortController().signal

    const result = await adapterFor('questions').decide(
      decideRequest('https://openrouter.ai/api/alpha/decisions', signal)
    )

    expect(result).toMatchObject({
      choice: 'different',
      confidence: 0.4,
      reason: null,
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: null },
    })
  })
})

// The two quirks that vary by ENDPOINT rather than by kind (plan §5.4). They
// live in the adapter because they are wire behaviour, and they are the sort of
// thing that breaks silently: an Ollama reasoning model that receives a 100-token
// cap spends the cap thinking and returns empty content.
describe('openai-compatible host quirks (endpoint, not capability)', () => {
  const OK = () => fakeResponse({ choices: [{ message: { content: 'ok' } }] })

  it('Ollama Cloud gets NO token cap; every other host gets max_tokens', async () => {
    const signal = new AbortController().signal
    const send = async (baseUrl: string) => {
      const fetchMock = vi.fn().mockResolvedValue(OK())
      globalThis.fetch = fetchMock
      await adapterFor('openai-compatible').complete(completeRequest(baseUrl, signal))
      return bodyOf(fetchMock.mock.calls[0]![1] as RequestInit)
    }

    const ollama = await send('https://ollama.com/v1')
    expect(ollama.max_tokens).toBeUndefined()
    expect(ollama.max_completion_tokens).toBeUndefined()

    const opencode = await send('https://api.opencode.ai/v1')
    expect(opencode.max_tokens).toBe(100)
    expect(opencode.max_completion_tokens).toBeUndefined()

    // A custom base URL is "elsewhere": max_tokens, never the OpenAI-proper field.
    const custom = await send('https://llm.example.test/v1')
    expect(custom.max_tokens).toBe(100)
    expect(custom.max_completion_tokens).toBeUndefined()
  })

  it('labels a failure with the host it recognised (the route-test contract)', async () => {
    const signal = new AbortController().signal
    const failLabel = async (baseUrl: string) => {
      globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse('nope', { ok: false, status: 401 }))
      const error = await adapterFor('openai-compatible')
        .complete(completeRequest(baseUrl, signal))
        .catch((err: unknown) => err)
      return (error as Error).message
    }

    expect(await failLabel('https://ollama.com/v1')).toContain('Ollama Cloud')
    expect(await failLabel('https://api.opencode.ai/v1')).toContain('OpenCode')
    expect(await failLabel('https://llm.example.test/v1')).toContain('Provider')
  })
})

describe('adapter registry and capability matrix (plan §2.4)', () => {
  it('maps every kind to exactly one adapter and no kind is missing', () => {
    expect([...ADAPTER_KINDS].sort()).toEqual(
      ['anthropic', 'gemini', 'openai-compatible', 'questions'].sort()
    )
    for (const kind of ADAPTER_KINDS) {
      expect(adapterFor(kind).kind).toBe(kind)
    }
  })

  it('chat kinds serve all three capabilities; the typed kind serves decisions only', () => {
    for (const kind of ['openai-compatible', 'anthropic', 'gemini'] as const) {
      const adapter = adapterFor(kind)
      expect(adapter.supports('reasoning')).toBe(true)
      expect(adapter.supports('vision')).toBe(true)
      expect(adapter.supports('decision')).toBe(true)
      // The JSON-document shape is chat-only.
      expect(typeof adapter.structured).toBe('function')
    }

    const typed = adapterFor('questions')
    expect(typed.supports('reasoning')).toBe(false)
    expect(typed.supports('vision')).toBe(false)
    expect(typed.supports('decision')).toBe(true)
    expect(typed.structured).toBeUndefined()
  })

  it('a typed provider refuses a text completion (fail closed)', async () => {
    await expect(
      adapterFor('questions').complete(
        completeRequest('https://openrouter.ai/api/alpha/decisions', new AbortController().signal)
      )
    ).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('no adapter carries a default model — the model is owner-typed data (plan §5.1)', () => {
    for (const kind of ADAPTER_KINDS) {
      expect('defaultModel' in adapterFor(kind)).toBe(false)
    }
  })
})
