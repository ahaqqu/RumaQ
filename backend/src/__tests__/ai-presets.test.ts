import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { adapterFor } from '../lib/ai/adapters/registry.js'
import { TYPED_QUESTION_NAME } from '../lib/ai/adapters/questions.js'
import { PRESETS, presetById, presetEndpoint } from '../lib/ai/presets.js'
import type { DecisionAsk, ProviderKind } from '../lib/ai/types.js'

// The OpenRouter presets (#523 follow-up, plan §9). Two shipped catalog rows,
// data only: a `questions` row for the decisions wire and an
// `openai-compatible` row for reasoning/vision. The test proves the catalog
// stays model-free and that the adapter speaks OpenRouter's envelope at the
// preset's canonical endpoint — the shape a live probe pinned.

const DECISIONS_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'
const CHAT_ENDPOINT = 'https://openrouter.ai/api/v1'
const MODEL = '~typesafe/jev-latest'
const API_KEY = 'sk-test'

const ASK: DecisionAsk = {
  state: 'Susu UHT Ultra 1L',
  question: 'Are these two records the same product?',
  criteria: 'Same brand, same variant, same size/pack.',
  choices: ['same', 'different'],
}

/** A Response-shaped object: only the surface the adapters read. */
function fakeResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({}),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function decideRequest(): Parameters<ReturnType<typeof adapterFor>['decide']>[0] {
  return {
    capability: 'decision',
    model: MODEL,
    ask: ASK,
    thinkingLevel: null,
    baseUrl: presetEndpoint('openrouter-decisions', 'questions'),
    apiKey: API_KEY,
    signal: new AbortController().signal,
  }
}

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

describe('the OpenRouter presets are data rows in the catalog', () => {
  it('ships both rows, in catalog order, after the existing vendors', () => {
    expect(PRESETS.map((preset) => preset.id)).toEqual([
      'openai',
      'opencode',
      'anthropic',
      'gemini',
      'ollama',
      'openrouter-decisions',
      'openrouter',
      'custom',
    ])
    expect(PRESETS).toHaveLength(8)
  })

  it('labels and wires them exactly as decided (no model id anywhere)', () => {
    expect(presetById('openrouter-decisions')).toEqual({
      id: 'openrouter-decisions',
      label: 'OpenRouter (decisions)',
      kind: 'questions',
      endpoint: DECISIONS_ENDPOINT,
    })
    expect(presetById('openrouter')).toEqual({
      id: 'openrouter',
      label: 'OpenRouter',
      kind: 'openai-compatible',
      endpoint: CHAT_ENDPOINT,
    })
    // A preset is wire + label + endpoint: no model field can age in code.
    for (const preset of PRESETS) {
      expect(Object.keys(preset).sort()).toEqual(['endpoint', 'id', 'kind', 'label'])
    }
    expect(JSON.stringify(PRESETS)).not.toMatch(/gpt-|gemini-3|claude-|glm-|jev-|pplx-/i)
  })

  it('every preset endpoint is HTTPS; only custom has none', () => {
    for (const preset of PRESETS) {
      if (preset.id === 'custom') {
        expect(preset.endpoint).toBeNull()
        continue
      }
      expect(preset.endpoint, preset.id).toMatch(/^https:\/\//)
    }
    const ids = PRESETS.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    const kinds: ProviderKind[] = ['openai-compatible', 'anthropic', 'gemini', 'questions']
    for (const preset of PRESETS) expect(kinds).toContain(preset.kind)
  })

  it('resolves each preset only for its own wire', () => {
    expect(presetEndpoint('openrouter-decisions', 'questions')).toBe(DECISIONS_ENDPOINT)
    expect(presetEndpoint('openrouter', 'openai-compatible')).toBe(CHAT_ENDPOINT)
    // A hand-edited row whose kind disagrees with the preset is unusable.
    expect(presetEndpoint('openrouter-decisions', 'openai-compatible')).toBeNull()
    expect(presetEndpoint('openrouter', 'questions')).toBeNull()
    expect(presetEndpoint('custom', 'openai-compatible')).toBeNull()
    expect(presetEndpoint('nope', 'questions')).toBeNull()
  })
})

describe('the questions adapter speaks the OpenRouter decisions wire', () => {
  it('POSTs the preset endpoint with array state and choice-keyed criteria', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({
        model: 'typesafe/jev-1.14-20261014',
        provider: 'TypeSafe',
        id: 'gen-dec-test',
        answers: {
          verdict: {
            type: 'choice',
            choice: 'different',
            confidence: 0.93,
            probabilities: { same: 0.07, different: 0.93 },
          },
        },
        usage: { input_tokens: 120, output_tokens: 12, cost: 0.000005 },
      })
    )
    globalThis.fetch = fetchMock

    const result = await adapterFor('questions').decide(decideRequest())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    // The preset endpoint is posted AS-IS — no /chat/completions suffix.
    expect(url).toBe(DECISIONS_ENDPOINT)
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${API_KEY}`)

    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toEqual({
      state: [ASK.state],
      model: MODEL,
      questions: {
        [TYPED_QUESTION_NAME]: {
          type: 'choice',
          instructions: expect.stringContaining(ASK.question),
          criteria: { same: ASK.criteria, different: ASK.criteria },
        },
      },
    })
    const questions = body.questions as Record<string, { instructions: string }>
    expect(questions[TYPED_QUESTION_NAME]!.instructions).toContain('same, different')

    // Parsed from answers.<q>.choice/confidence; the superset usage/probabilities
    // keys are ignored, never an error (the typed row stays un-token-billed).
    expect(result).toEqual({
      choice: 'different',
      confidence: 0.93,
      reason: null,
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: null },
      usageReported: false,
    })
  })

  it('falls back to each choice label when the ask has no rubric', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({
        answers: { verdict: { type: 'choice', choice: 'same', confidence: 0.8 } },
      })
    )
    globalThis.fetch = fetchMock

    // The rubric is optional (plan §9.2): with none, the record value is the
    // choice itself, so the vocabulary stays complete and no empty criterion is
    // sent. A whitespace-only rubric takes the same path.
    for (const criteria of [undefined, '   ']) {
      await adapterFor('questions').decide({ ...decideRequest(), ask: { ...ASK, criteria } })
    }

    for (const call of fetchMock.mock.calls) {
      const [, init] = call as [string, RequestInit]
      const body = JSON.parse(String(init.body))
      expect(body.questions[TYPED_QUESTION_NAME].criteria).toEqual({
        same: 'same',
        different: 'different',
      })
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails typed (invalid_response) when answers is missing — never a silent default', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(fakeResponse({ usage: { input_tokens: 1, output_tokens: 1, cost: 0 } }))

    await expect(adapterFor('questions').decide(decideRequest())).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('fails typed when the answer is outside the criteria vocabulary', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({
        answers: { verdict: { type: 'choice', choice: 'maybe', confidence: 0.5 } },
      })
    )

    await expect(adapterFor('questions').decide(decideRequest())).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })
})

describe('the chat preset serves reasoning/vision through the openai wire', () => {
  it('posts {base}/chat/completions at the OpenRouter chat endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      })
    )
    globalThis.fetch = fetchMock

    const result = await adapterFor('openai-compatible').complete({
      capability: 'reasoning',
      model: 'openai/gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      json: false,
      thinkingLevel: null,
      baseUrl: presetEndpoint('openrouter', 'openai-compatible'),
      apiKey: API_KEY,
      signal: new AbortController().signal,
    })

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${CHAT_ENDPOINT}/chat/completions`)
    expect(result.text).toBe('hi')
  })
})
