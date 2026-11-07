import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import type { Env } from '../types.js'
import { encryptAiKey } from '../lib/crypto.js'
import {
  AI_TIMEOUT_MS,
  AiError,
  completeText,
  decide,
  isAiError,
  resolveAccess,
  structured,
  vision,
} from '../lib/ai/index.js'
import type { AiMessage, Capability, DecisionAsk, ProviderKind } from '../lib/ai/types.js'

// The DOOR's behaviour (ahaqqu/RumaQ#523 P2, plan §2.2 + §6 P2): resolution,
// dispatch, the decision shapes (chat kinds vs the typed wire), the failure
// vocabulary, and the two rules a caller relies on — the handle resolves once
// and hides the key, and a failure still reports the attempt's tokens.
//
// The D1 here is a two-line fake that answers the resolver's single join (the
// wire itself is the subject, not SQL); the provider transport is a mocked
// global fetch, exactly like the adapter contract suite.

const ENCRYPTION_KEY = 'test-encryption-key-32-bytes-long!!'
const HOUSEHOLD = 'h1'
const USER = 'u1'

type FakeRow = Record<string, unknown>

type BoundStatement = {
  first: () => Promise<FakeRow | null>
  all: () => Promise<{ results: FakeRow[] }>
  run: () => Promise<{ meta: { changes: number } }>
}

type FakeEnv = {
  env: Env['Bindings']
  prepares: () => number
  runs: () => Array<{ sql: string; params: unknown[] }>
}

/**
 * One fake D1: the resolver's join is answered from `rows` keyed by the
 * requested capability (the SQL's second bind parameter), which is exactly what
 * the real ACCESS_SQL returns.
 */
function fakeEnv(rows: Record<string, FakeRow>): FakeEnv {
  let prepares = 0
  const runs: Array<{ sql: string; params: unknown[] }> = []

  const execute = (sql: string, params: unknown[]): BoundStatement => ({
    first: async () => rows[String(params[1])] ?? null,
    all: async () => ({ results: [] }),
    run: async () => {
      runs.push({ sql, params })
      return { meta: { changes: 1 } }
    },
  })

  const db = {
    prepare: (sql: string) => {
      prepares += 1
      let bound = execute(sql, [])
      const statement = {
        bind: (...params: unknown[]) => {
          bound = execute(sql, params)
          return statement
        },
        first: () => bound.first(),
        all: () => bound.all(),
        run: () => bound.run(),
      }
      return statement
    },
  }

  return {
    env: { DB: db, WORKER_ENCRYPTION_KEY: ENCRYPTION_KEY } as unknown as Env['Bindings'],
    prepares: () => prepares,
    runs: () => runs,
  }
}

async function providerRow(capability: Capability, overrides: FakeRow = {}): Promise<FakeRow> {
  const providerId = String(overrides.provider_id ?? 'p-1')
  return {
    capability,
    model: 'test-model',
    thinking_level: null,
    provider_id: providerId,
    kind: 'openai-compatible' as ProviderKind,
    preset: 'openai',
    base_url: null,
    default_model: null,
    encrypted_key: await encryptAiKey('sk-household', ENCRYPTION_KEY, `ai_provider:${providerId}`),
    ...overrides,
  }
}

async function envWith(rows: Partial<Record<Capability, FakeRow>>): Promise<FakeEnv> {
  const resolved: Record<string, FakeRow> = {}
  for (const capability of ['reasoning', 'decision', 'vision'] as const) {
    if (rows[capability]) resolved[capability] = await providerRow(capability, rows[capability])
  }
  return fakeEnv(resolved)
}

function ctx(env: Env['Bindings']) {
  return { env, userId: USER, householdId: HOUSEHOLD }
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const MESSAGES: AiMessage[] = [{ role: 'user', content: 'hello' }]
const ASK: DecisionAsk = {
  state: 'Susu cair 1L',
  question: 'Are these the same product?',
  choices: ['same', 'different'],
  criteria: '- same: identical\n- different: not',
}

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

describe('the door: resolution and dispatch', () => {
  it('resolves a household assignment and answers with text, call and usage', async () => {
    const { env } = await envWith({ reasoning: {} })
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'the answer' } }],
        usage: { prompt_tokens: 12, completion_tokens: 7 },
      })
    )
    globalThis.fetch = fetchMock

    const result = await completeText({ ...ctx(env), messages: MESSAGES })

    expect(result).toEqual({
      text: 'the answer',
      call: {
        capability: 'reasoning',
        householdId: HOUSEHOLD,
        providerKind: 'openai-compatible',
        providerId: 'p-1',
        model: 'test-model',
        // D9: v1 has exactly one funding value, and this is where it is decided.
        funding: 'household',
      },
      usage: { input_tokens: 12, output_tokens: 7, cached_tokens: null },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reuses a pre-resolved handle for N calls with zero extra D1 reads', async () => {
    const fake = await envWith({ reasoning: {} })
    const access = await resolveAccess(ctx(fake.env), 'reasoning')
    expect(access).not.toBeNull()
    // The handle exposes no key material (plan §2.2).
    expect(access).not.toHaveProperty('apiKey')
    expect(access).not.toHaveProperty('baseUrl')
    expect(Object.keys(access!).sort()).toEqual(['call', 'capability'])

    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'x' } }] }))
    globalThis.fetch = fetchMock

    await completeText({ ...ctx(fake.env), access: access!, messages: MESSAGES })
    await completeText({ ...ctx(fake.env), access: access!, messages: MESSAGES })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    // One resolve (one prepare) for the whole batch — the review sweep's budget.
    expect(fake.prepares()).toBe(1)
  })

  it('answers not_configured (402) for an unassigned capability, with no call to bill', async () => {
    const { env } = await envWith({})

    const error = await completeText({ ...ctx(env), messages: MESSAGES }).catch(
      (err: unknown) => err
    )

    expect(isAiError(error)).toBe(true)
    expect(error).toBeInstanceOf(AiError)
    expect(error).toMatchObject({
      code: 'not_configured',
      httpStatus: 402,
      call: null,
      retryable: false,
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('answers unsupported (500) when the assigned kind cannot serve the capability', async () => {
    const { env } = await envWith({
      reasoning: {
        kind: 'questions',
        preset: null,
        base_url: 'https://api.typesafe.ai/v1/systemone',
      },
    })

    const error = await completeText({ ...ctx(env), messages: MESSAGES }).catch(
      (err: unknown) => err
    )

    expect(error).toMatchObject({
      code: 'unsupported',
      httpStatus: 500,
      call: { capability: 'reasoning', providerKind: 'questions' },
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('fails closed for a forged handle (one the door never issued)', async () => {
    const { env } = await envWith({ reasoning: {} })
    const forged = {
      capability: 'reasoning' as const,
      call: {
        capability: 'reasoning' as const,
        householdId: HOUSEHOLD,
        providerKind: 'openai-compatible' as const,
        providerId: 'p-forged',
        model: 'test-model',
        funding: 'household' as const,
      },
    }
    const error = await completeText({ ...ctx(env), access: forged, messages: MESSAGES }).catch(
      (err: unknown) => err
    )
    expect(error).toMatchObject({ code: 'not_configured', httpStatus: 402 })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('uses the resolved thinking level, and a per-call override wins', async () => {
    const { env } = await envWith({ reasoning: { thinking_level: 'high' } })
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'x' } }] }))
    globalThis.fetch = fetchMock

    await completeText({ ...ctx(env), messages: MESSAGES })
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).reasoning_effort).toBe('high')

    await completeText({ ...ctx(env), messages: MESSAGES, thinkingLevel: null })
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body)).reasoning_effort).toBeUndefined()
  })

  it('exposes per-capability default timeouts (§5.2)', () => {
    expect(AI_TIMEOUT_MS).toEqual({ reasoning: 60_000, decision: 20_000, vision: 30_000 })
  })
})

describe('the door: failures carry the bill (§2.2/§5.2)', () => {
  it('maps a provider 429 to rate_limited with Retry-After surfaced', async () => {
    const { env } = await envWith({ reasoning: {} })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '7' }),
      text: async () => 'slow down',
    } as unknown as Response)

    const error = await completeText({ ...ctx(env), messages: MESSAGES }).catch(
      (err: unknown) => err
    )

    expect(error).toMatchObject({
      code: 'rate_limited',
      httpStatus: 502,
      retryable: true,
      retryAfterSeconds: 7,
      providerStatus: 429,
      call: { capability: 'reasoning', householdId: HOUSEHOLD },
    })
    expect(error).toBeInstanceOf(AiError)
  })

  it('maps an aborted provider call to timeout (same 502 as today)', async () => {
    const { env } = await envWith({ reasoning: {} })
    const controller = new AbortController()
    controller.abort()
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new DOMException('operation aborted', 'AbortError'))

    const error = await completeText({
      ...ctx(env),
      messages: MESSAGES,
      signal: controller.signal,
    }).catch((err: unknown) => err)

    expect(error).toMatchObject({ code: 'timeout', httpStatus: 502, retryable: true })
  })

  it('enforces its own per-call deadline, composed with the caller signal', async () => {
    const { env } = await envWith({ reasoning: {} })
    // A provider that never answers: the door's timeout (not the caller's
    // signal) must abort it. 5 ms stands in for the 60 s capability default.
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('timed out', 'AbortError'))
          )
        })
    )

    const error = await completeText({ ...ctx(env), messages: MESSAGES, timeoutMs: 5 }).catch(
      (err: unknown) => err
    )

    expect(error).toMatchObject({ code: 'timeout', httpStatus: 502, retryable: true })
  })

  it('a failed answer still reports the tokens the provider billed', async () => {
    const { env } = await envWith({ reasoning: {} })
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: '' } }],
        usage: { prompt_tokens: 900, completion_tokens: 100 },
      })
    )

    const error = await completeText({ ...ctx(env), messages: MESSAGES }).catch(
      (err: unknown) => err
    )

    expect(error).toMatchObject({
      code: 'invalid_response',
      httpStatus: 502,
      usage: { input_tokens: 900, output_tokens: 100, cached_tokens: null },
    })
    expect((error as Error).message).toContain('empty response')
  })

  it('an auth failure keeps the provider label and never echoes the key', async () => {
    const { env } = await envWith({ reasoning: {} })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => 'invalid key',
    } as unknown as Response)

    const error = await completeText({ ...ctx(env), messages: MESSAGES }).catch(
      (err: unknown) => err
    )

    expect(error).toMatchObject({ code: 'auth', providerStatus: 401, httpStatus: 502 })
    expect((error as Error).message).toContain('OpenAI')
    expect((error as Error).message).not.toContain('sk-household')
  })
})

describe('the door: decide() across the two provider shapes', () => {
  it('chat kind: prompts, asks for JSON mode and parses choice + confidence + reason', async () => {
    const { env } = await envWith({ decision: { thinking_level: 'high' } })
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              content: '```json\n{"choice":"same","confidence":1.7,"reason":" same brand "}\n```',
            },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 12 },
      })
    )
    globalThis.fetch = fetchMock

    const result = await decide({ ...ctx(env), ask: ASK })

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body))
    // The JSON mode is opt-in and the prompt is the shared decision prompt.
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.reasoning_effort).toBe('high')
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[0].content).toContain('decision assistant')
    expect(body.messages[1].content).toContain(ASK.state)
    expect(body.messages[1].content).toContain('- same')

    expect(result).toEqual({
      choice: 'same',
      // The door's promise: a reported confidence is clamped into [0,1].
      confidence: 1,
      reason: 'same brand',
      call: {
        capability: 'decision',
        householdId: HOUSEHOLD,
        providerKind: 'openai-compatible',
        providerId: 'p-1',
        model: 'test-model',
        funding: 'household',
      },
      usage: { input_tokens: 50, output_tokens: 12, cached_tokens: null },
    })
  })

  it('chat kind: no confidence in the answer is null, not zero', async () => {
    const { env } = await envWith({ decision: {} })
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ choices: [{ message: { content: '{"choice":"different"}' } }] })
      )

    const result = await decide({ ...ctx(env), ask: ASK })
    expect(result.choice).toBe('different')
    expect(result.confidence).toBeNull()
    expect(result.reason).toBeNull()
  })

  it('chat kind: an off-list choice is invalid_response (never a silent choice)', async () => {
    const { env } = await envWith({ decision: {} })
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ choices: [{ message: { content: '{"choice":"maybe","confidence":0.5}' } }] })
      )

    const error = await decide({ ...ctx(env), ask: ASK }).catch((err: unknown) => err)
    expect(error).toMatchObject({ code: 'invalid_response', httpStatus: 502 })
    expect((error as Error).message).toContain('off-schema')
  })

  it('typed kind: one native question, choice + confidence out, reason null and zero tokens', async () => {
    const { env } = await envWith({
      decision: {
        kind: 'questions',
        preset: null,
        model: 'jev-latest',
        base_url: 'https://api.typesafe.ai/v1/systemone',
      },
    })
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        answers: { verdict: { choice: 'same', confidence: 0.78 } },
      })
    )
    globalThis.fetch = fetchMock

    const result = await decide({ ...ctx(env), ask: ASK })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-household')
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({
      state: ASK.state,
      model: 'jev-latest',
      questions: {
        verdict: {
          type: 'choice',
          instructions: `${ASK.question}\nAnswer with exactly one of: same, different`,
          criteria: ASK.criteria,
        },
      },
    })

    expect(result.choice).toBe('same')
    expect(result.confidence).toBe(0.78)
    // D3: the typed wire answers choice + confidence only.
    expect(result.reason).toBeNull()
    expect(result.call.providerKind).toBe('questions')
    // Typed calls are not token-billed; the usage row is marked by the kind.
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0, cached_tokens: null })
  })

  it('typed kind: an answer without a numeric confidence is invalid_response', async () => {
    const { env } = await envWith({
      decision: {
        kind: 'questions',
        preset: null,
        model: 'jev-latest',
        base_url: 'https://api.typesafe.ai/v1/systemone',
      },
    })
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ answers: { verdict: { choice: 'same' } } }))

    const error = await decide({ ...ctx(env), ask: ASK }).catch((err: unknown) => err)
    expect(error).toMatchObject({ code: 'invalid_response', httpStatus: 502 })
  })
})

describe('the door: vision() and structured()', () => {
  it('vision sends the prompt and image as one user turn and resolves the vision assignment', async () => {
    const { env } = await envWith({
      vision: { model: 'gpt-4o-vision', preset: 'openai' },
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: '{"items":[]}' } }] }))
    globalThis.fetch = fetchMock

    const result = await vision({
      ...ctx(env),
      parts: [
        { type: 'text', text: 'read this receipt' },
        { type: 'image', bytes: new Uint8Array([1, 2, 3]).buffer, mimeType: 'image/jpeg' },
      ],
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body))
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'read this receipt' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQID' } },
        ],
      },
    ])
    expect(result.call).toMatchObject({
      capability: 'vision',
      model: 'gpt-4o-vision',
      providerKind: 'openai-compatible',
    })
    expect(result.text).toBe('{"items":[]}')
  })

  it('structured validates the feature schema on a chat kind', async () => {
    const { env } = await envWith({ decision: {} })
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ choices: [{ message: { content: '{"items":[{"name":"milk"}]}' } }] })
      )

    const result = await structured({
      ...ctx(env),
      messages: MESSAGES,
      validate: (raw) => (raw as { items: Array<{ name: string }> }).items[0]!.name,
    })

    expect(result.value).toBe('milk')
    expect(result.call.capability).toBe('decision')
  })

  it('structured is unsupported on a typed kind (the capability stays unambiguous)', async () => {
    const { env } = await envWith({
      decision: {
        kind: 'questions',
        preset: null,
        model: 'jev-latest',
        base_url: 'https://api.typesafe.ai/v1/systemone',
      },
    })

    const error = await structured({
      ...ctx(env),
      messages: MESSAGES,
      validate: (raw) => raw,
    }).catch((err: unknown) => err)

    expect(error).toMatchObject({ code: 'unsupported', httpStatus: 500 })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
