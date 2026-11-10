import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'
import type { Env } from '../types.js'
import { apiApp } from '../apps/api.js'
import { encryptAiKey } from '../lib/crypto.js'
import { householdIsoDate } from '../lib/household-day.js'
import type { Capability } from '../lib/ai/types.js'
import { createDb, type Db } from './support/d1-sqlite.js'

// EVERY CALL SITE ROUTES BY CAPABILITY (ahaqqu/RumaQ#523 P4, plan §5.5 + §6 P4).
//
// The P2 facade made capabilities resolvable; this suite is what proves the
// features USE them. Real SQLite over the real migration chain (the usage rows,
// the verdict cache and the two GROUP BY cuts are SQL semantics a mock cannot
// exercise), a MOCKED global fetch standing in for every provider, and a
// recorder that captures what actually went on the wire — URL + model + the
// request body. A fake provider "records the capability it was called for":
// each capability is seeded with a distinct model, so the recorded model names
// the capability without the wire needing a capability field.
//
// No test in this suite may reach a real AI endpoint.

const ENCRYPTION_KEY = 'test-enc-key'
const HOUSEHOLD = 'h1'
const OWNER = 'u-owner'
const MEMBER = 'u-member'
const ADMIN = 'u-admin'

// Distinct per-capability models: the assertion surface for "which capability".
const REASONING_MODEL = 'reasoning-model'
const VISION_MODEL = 'vision-model'
const DECISION_MODEL = 'decision-model'

let sqlite: Db
let d1: D1Database

type RecordedCall = { url: string; model: string; body: Record<string, unknown> }
let calls: RecordedCall[] = []

function openAiAnswer(content: string, usage = { prompt_tokens: 100, completion_tokens: 10 }) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      choices: [{ message: { content } }],
      usage,
    }),
    text: async () => '',
  } as unknown as Response
}

/** A provider that answers with an error status (a billed, failed attempt). */
function failedAnswer(status: number) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: async () => ({}),
    text: async () => 'upstream is down',
  } as unknown as Response
}

function geminiAnswer(text: string, usage = { promptTokenCount: 90, candidatesTokenCount: 9 }) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: usage,
    }),
    text: async () => '',
  } as unknown as Response
}

/**
 * Install a fetch mock that responds per request and records what each call
 * carried. `respond` receives the parsed body so a test can answer differently
 * per prompt if it wants; the default answers by wire shape.
 */
function providerMock(respond?: (body: Record<string, unknown>, url: string) => Response) {
  const mock = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    // The chat wires carry the model in the body; gemini puts it in the URL
    // path (`/models/<model>:generateContent`). Both name the capability.
    const geminiModel = /\/models\/([^:]+):/.exec(String(url))?.[1]
    calls.push({ url, model: String(body.model ?? geminiModel ?? ''), body })
    if (respond) return respond(body, url)
    // Gemini speaks `contents`; every other seeded wire is chat-completions.
    if (String(url).includes('generativelanguage')) return geminiAnswer('{"items":[]}')
    return openAiAnswer('{"items":[]}')
  })
  globalThis.fetch = mock as unknown as typeof fetch
  return mock
}

beforeEach(async () => {
  calls = []
  globalThis.fetch = vi.fn()
  const { sqlite: db, d1: adapter } = createDb()
  sqlite = db
  d1 = adapter
  // D1 enforces foreign keys; node:sqlite defaults them OFF. The usage/verdict
  // FKs are part of the contract under test.
  sqlite.exec('PRAGMA foreign_keys = ON')

  for (const [id, email] of [
    [OWNER, 'owner@rumaq.dev'],
    [MEMBER, 'member@rumaq.dev'],
    [ADMIN, 'admin@rumaq.dev'],
  ] as const) {
    sqlite.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id, email, id)
  }
  sqlite.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(ADMIN)
  sqlite
    .prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)')
    .run(HOUSEHOLD, 'Test household', OWNER)
  for (const [id, userId, role] of [
    ['m-owner', OWNER, 'owner'],
    ['m-member', MEMBER, 'member'],
    ['m-admin', ADMIN, 'member'],
  ] as const) {
    sqlite
      .prepare(
        `INSERT INTO household_members (id, household_id, user_id, role, joined_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, HOUSEHOLD, userId, role, '2026-01-01 00:00:00')
  }
  for (const userId of [OWNER, MEMBER, ADMIN]) {
    sqlite
      .prepare('INSERT INTO user_settings (id, user_id, active_household_id) VALUES (?, ?, ?)')
      .run(`s-${userId}`, userId, HOUSEHOLD)
  }

  await seedProviders()
})

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * The configured household: reasoning + decision on a chat-wire provider (the
 * common BYOK shape) and vision on a DIFFERENT provider, so a route that reads
 * the wrong capability is caught by model AND endpoint.
 */
async function seedProviders(
  options: { reasoning?: string; vision?: string; decision?: string } = {}
): Promise<void> {
  const textKey = await encryptAiKey('sk-text', ENCRYPTION_KEY, 'ai_provider:p-text')
  sqlite
    .prepare(
      `INSERT INTO ai_providers
         (id, household_id, label, kind, preset, base_url, default_model, encrypted_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run('p-text', HOUSEHOLD, 'Home key', 'openai-compatible', 'openai', null, null, textKey)
  const visionKey = await encryptAiKey('sk-vision', ENCRYPTION_KEY, 'ai_provider:p-vision')
  sqlite
    .prepare(
      `INSERT INTO ai_providers
         (id, household_id, label, kind, preset, base_url, default_model, encrypted_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run('p-vision', HOUSEHOLD, 'Vision key', 'gemini', 'gemini', null, null, visionKey)

  const assignments: Array<[Capability, string, string]> = [
    ['reasoning', 'p-text', options.reasoning ?? REASONING_MODEL],
    ['decision', 'p-text', options.decision ?? DECISION_MODEL],
    ['vision', 'p-vision', options.vision ?? VISION_MODEL],
  ]
  for (const [capability, providerId, model] of assignments) {
    sqlite
      .prepare(
        `INSERT INTO ai_capabilities (household_id, capability, provider_id, model)
         VALUES (?, ?, ?, ?)`
      )
      .run(HOUSEHOLD, capability, providerId, model)
  }
}

function clearAi(): void {
  sqlite.prepare('DELETE FROM ai_capabilities').run()
  sqlite.prepare('DELETE FROM ai_providers').run()
}

function env(userId: string = OWNER, overrides: Record<string, unknown> = {}): Env['Bindings'] {
  return {
    DB: d1,
    // The scan route stores the image before it asks a provider about it.
    RECEIPTS: receiptBucket(),
    WORKER_ENCRYPTION_KEY: ENCRYPTION_KEY,
    // The test-only auth shortcut: props sets the resolved request context.
    props: { userId, householdId: HOUSEHOLD },
    // No route in this suite takes the TEST_MODE stub: every call must reach
    // the recorder, because the wire is the subject.
    TEST_MODE: 'false',
    ...overrides,
  } as unknown as Env['Bindings']
}

function usageRows(): Array<Record<string, unknown>> {
  return sqlite.prepare('SELECT * FROM ai_usage_events ORDER BY ts, id').all()
}

function request(path: string, init: RequestInit = {}, userId: string = OWNER) {
  return apiApp.request(path, init, env(userId))
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/** The R2 stub the scan route writes the uploaded receipt to. */
function receiptBucket() {
  return { put: vi.fn().mockResolvedValue({}), get: vi.fn().mockResolvedValue(null) }
}

function scanRequest(): RequestInit {
  const formData = new FormData()
  formData.append('image', new File(['fake-jpeg-bytes'], 'receipt.jpg', { type: 'image/jpeg' }))
  return { method: 'POST', body: formData }
}

// ---------------------------------------------------------------------------
// Per-route capability routing.

describe('every call site routes by capability (#523 P4)', () => {
  it('chat dispatches the REASONING capability', async () => {
    const fetchMock = providerMock(() => openAiAnswer('Hello from the assistant'))
    const res = await request('/api/ai/chat', jsonRequest('POST', { message: 'hi' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reply: 'Hello from the assistant' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(calls[0].model).toBe(REASONING_MODEL)
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions')
    expect(usageRows()).toEqual([
      expect.objectContaining({
        user_id: OWNER,
        provider: 'openai-compatible',
        model: REASONING_MODEL,
        capability: 'reasoning',
        household_id: HOUSEHOLD,
        funding: 'household',
        input_tokens: 100,
        output_tokens: 10,
      }),
    ])
  })

  it('the persona rewrite dispatches the REASONING capability (#523 P5)', async () => {
    const fetchMock = providerMock(() =>
      openAiAnswer(JSON.stringify({ homeLead: 'Sire, the kitchen is calm.' }))
    )
    const res = await request(
      '/api/ai/generate/persona',
      jsonRequest('POST', {
        user_role: 'raja',
        ai_role: 'prajurit',
        language: 'en',
        copy: { homeLead: 'A calmer kitchen starts with what you already have.' },
      })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ copy: { homeLead: 'Sire, the kitchen is calm.' } })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(calls[0].model).toBe(REASONING_MODEL)
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions')
    // The rewrite is billed like every other call: one row, reasoning, household.
    expect(usageRows()).toEqual([
      expect.objectContaining({
        user_id: OWNER,
        capability: 'reasoning',
        household_id: HOUSEHOLD,
        funding: 'household',
      }),
    ])
  })

  it('a shopping plan dispatches the REASONING capability', async () => {
    const plan = {
      items: [
        {
          name: 'Milk',
          qty: 1,
          unit: 'L',
          store_id: null,
          price_estimate: 18500,
          why: 'running out',
        },
      ],
    }
    const fetchMock = providerMock(() => openAiAnswer(JSON.stringify(plan)))
    const res = await request('/api/plans/generate', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ name: string }> }
    expect(body.items[0].name).toBe('Milk')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(calls[0].model).toBe(REASONING_MODEL)
    expect(usageRows()).toEqual([
      expect.objectContaining({ capability: 'reasoning', household_id: HOUSEHOLD }),
    ])
  })

  it('THE SCAN-TO-VISION FIX: a receipt scan dispatches the VISION capability (its own provider + model)', async () => {
    // Before P4 this call went through the legacy shim's single provider: an
    // image was sent to the REASONING model (here a text provider). The scan
    // must now use the vision assignment's row, model and wire.
    const scan = {
      store_name: 'Indomaret',
      date: '2026-11-07',
      items: [{ name: 'Susu cair 1L', qty: 1, unit: 'L', price: 18500 }],
    }
    const fetchMock = providerMock(() => geminiAnswer(JSON.stringify(scan)))
    const res = await request('/api/purchases/scan', scanRequest(), OWNER)
    expect(res.status).toBe(200)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(calls[0].model).toBe(VISION_MODEL)
    expect(calls[0].model).not.toBe(REASONING_MODEL)
    // The vision ROW's wire, not the text provider's.
    expect(calls[0].url).toContain('generativelanguage.googleapis.com')
    // The image rode the request (gemini's inline_data part).
    expect(JSON.stringify(calls[0].body)).toContain('inline_data')

    expect(usageRows()).toEqual([
      expect.objectContaining({
        user_id: OWNER,
        provider: 'gemini',
        model: VISION_MODEL,
        capability: 'vision',
        household_id: HOUSEHOLD,
        funding: 'household',
      }),
    ])
  })

  it('the review evaluate route dispatches the DECISION capability', async () => {
    sqlite.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('assist', 'review_mode')
    insertReviewItem('r1')
    const fetchMock = providerMock(() =>
      openAiAnswer('{"choice":"same","confidence":0.91,"reason":"Same pack."}')
    )

    const res = await request(
      '/api/admin/review/evaluate',
      jsonRequest('POST', { limit: 5 }),
      ADMIN
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      evaluated: 1,
      applied: 0,
      mode: 'assist',
      aiConfigured: true,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(calls[0].model).toBe(DECISION_MODEL)
    // The review is a decide() on the chat wire: the door's decision prompt and
    // the feature's ask (state + rubric + closed choices).
    const userMessage = (calls[0].body.messages as Array<{ content: string }>)[1].content
    expect(userMessage).toContain('Allowed choices')
    expect(userMessage).toContain('Beras Ramos')

    expect(usageRows()).toEqual([
      expect.objectContaining({
        user_id: ADMIN,
        model: DECISION_MODEL,
        capability: 'decision',
        household_id: HOUSEHOLD,
        funding: 'household',
      }),
    ])
    // The verdict is cached with the call's provenance, reason included.
    expect(sqlite.prepare('SELECT * FROM review_ai_verdicts').all()).toEqual([
      expect.objectContaining({
        review_item_id: 'r1',
        verdict: 'same',
        confidence: 0.91,
        reason: 'Same pack.',
        provider: 'openai-compatible',
        model: DECISION_MODEL,
      }),
    ])
  })

  it('the cron sweep dispatches the DECISION capability, once per run', async () => {
    sqlite.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('auto', 'review_mode')
    sqlite
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES ('review_ai_user_id', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(ADMIN)
    insertReviewItem('r1')
    insertReviewItem('r2')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchMock = providerMock(() =>
      openAiAnswer('{"choice":"same","confidence":0.9,"reason":"Same."}')
    )

    const { runReviewAiSweep } = await import('../lib/review-ai.js')
    const outcome = await runReviewAiSweep(env())
    expect(outcome).toMatchObject({ mode: 'auto', evaluated: 2, failed: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of calls) expect(call.model).toBe(DECISION_MODEL)
    for (const row of usageRows()) {
      expect(row).toMatchObject({
        user_id: ADMIN,
        capability: 'decision',
        household_id: HOUSEHOLD,
        funding: 'household',
      })
    }
  })
})

// ---------------------------------------------------------------------------
// Attribution.

describe('usage attribution (#523 P4)', () => {
  it("a member's call records THAT member with the household's id", async () => {
    providerMock(() => openAiAnswer('Sure'))
    // The member acts; the provider row (and the bill) belongs to the household.
    const res = await request('/api/ai/chat', jsonRequest('POST', { message: 'hi' }), MEMBER)
    expect(res.status).toBe(200)

    expect(usageRows()).toEqual([
      expect.objectContaining({
        user_id: MEMBER,
        household_id: HOUSEHOLD,
        capability: 'reasoning',
        funding: 'household',
      }),
    ])
    // Not re-attributed to the owner who configured the provider.
    expect(usageRows()[0].user_id).not.toBe(OWNER)
  })

  it('the failed scan records the VISION attempt and its billed tokens (failure carries the bill)', async () => {
    // A provider that answers with no content still billed the inputs it read.
    // The vision row is gemini, so the billing figures ride usageMetadata.
    providerMock(() => geminiAnswer('', { promptTokenCount: 100, candidatesTokenCount: 50 }))
    const res = await request('/api/purchases/scan', scanRequest(), OWNER)
    expect(res.status).toBe(502)
    expect(usageRows()).toEqual([
      expect.objectContaining({
        user_id: OWNER,
        capability: 'vision',
        household_id: HOUSEHOLD,
        model: VISION_MODEL,
        input_tokens: 100,
        output_tokens: 50,
      }),
    ])
  })

  it('the failed chat records the REASONING attempt (failure carries the bill)', async () => {
    // A provider 500 is a billed attempt: the row still names the call's own
    // dimensions, so the admin cut sees the failure.
    providerMock(() => failedAnswer(500))
    const res = await request('/api/ai/chat', jsonRequest('POST', { message: 'hi' }), OWNER)
    expect(res.status).toBe(502)
    expect(usageRows()).toEqual([
      expect.objectContaining({
        user_id: OWNER,
        capability: 'reasoning',
        household_id: HOUSEHOLD,
        model: REASONING_MODEL,
      }),
    ])
  })

  it('the failed plan records the REASONING attempt (failure carries the bill)', async () => {
    providerMock(() => failedAnswer(500))
    const res = await request('/api/plans/generate', jsonRequest('POST', {}), OWNER)
    expect(res.status).toBe(502)
    expect(usageRows()).toEqual([
      expect.objectContaining({
        user_id: OWNER,
        capability: 'reasoning',
        household_id: HOUSEHOLD,
        model: REASONING_MODEL,
      }),
    ])
  })

  it('an unparseable scan answer still records the VISION call it was billed for', async () => {
    // The provider answered (and billed) but the reply is not JSON: the route's
    // parser rejects it AFTER the call, so the attempt's call/usage must be
    // captured before the parse or the usage row is silently lost.
    providerMock(() =>
      geminiAnswer('I cannot read this receipt', {
        promptTokenCount: 120,
        candidatesTokenCount: 30,
      })
    )
    const res = await request('/api/purchases/scan', scanRequest(), OWNER)
    expect(res.status).toBe(502)
    expect(usageRows()).toEqual([
      expect.objectContaining({
        user_id: OWNER,
        capability: 'vision',
        household_id: HOUSEHOLD,
        model: VISION_MODEL,
        input_tokens: 120,
        output_tokens: 30,
      }),
    ])
  })

  it('an unparseable plan answer still records the REASONING call it was billed for', async () => {
    providerMock(() => openAiAnswer('I cannot build a plan'))
    const res = await request('/api/plans/generate', jsonRequest('POST', {}), OWNER)
    expect(res.status).toBe(502)
    expect(usageRows()).toEqual([
      expect.objectContaining({
        user_id: OWNER,
        capability: 'reasoning',
        household_id: HOUSEHOLD,
        model: REASONING_MODEL,
        input_tokens: 100,
        output_tokens: 10,
      }),
    ])
  })

  it('a call that never reached a provider writes no usage row', async () => {
    // not_configured has no call and no bill (plan §2.2): no row at all.
    clearAi()
    const res = await request('/api/ai/chat', jsonRequest('POST', { message: 'hi' }))
    expect(res.status).toBe(402)
    expect(usageRows()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// "Empty means empty": every AI route answers 402, and no provider is called.

describe('an empty household is not configured on every AI route', () => {
  beforeEach(() => {
    clearAi()
  })

  it('chat answers 402 and calls no provider', async () => {
    const fetchMock = providerMock()
    const res = await request('/api/ai/chat', jsonRequest('POST', { message: 'hi' }))
    expect(res.status).toBe(402)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(usageRows()).toEqual([])
  })

  it('a shopping plan answers 402 and calls no provider', async () => {
    const fetchMock = providerMock()
    const res = await request('/api/plans/generate', { method: 'POST' })
    expect(res.status).toBe(402)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a receipt scan answers 402 and calls no provider', async () => {
    const fetchMock = providerMock()
    const res = await request('/api/purchases/scan', scanRequest())
    expect(res.status).toBe(402)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the review evaluate route degrades to manual with zero calls', async () => {
    sqlite.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('auto', 'review_mode')
    insertReviewItem('r1')
    const fetchMock = providerMock()
    const res = await request(
      '/api/admin/review/evaluate',
      jsonRequest('POST', { limit: 5 }),
      ADMIN
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      evaluated: 0,
      applied: 0,
      mode: 'auto',
      aiConfigured: false,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT * FROM review_ai_verdicts').all()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The usage endpoints' breakdowns.

describe('/api/ai/usage — the per-capability breakdown and the household cut', () => {
  function insertEvent(args: {
    id: string
    userId: string
    householdId?: string | null
    capability: string | null
    provider?: string
    model?: string | null
    input?: number
    output?: number
    cached?: number | null
    date?: string
  }): void {
    const now = new Date()
    const ts = now.toISOString()
    sqlite
      .prepare(
        `INSERT INTO ai_usage_events
           (id, user_id, ts, date, provider, model, capability, household_id, funding,
            input_tokens, output_tokens, cached_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'household', ?, ?, ?)`
      )
      .run(
        args.id,
        args.userId,
        ts,
        // #554: the usage reader cuts "today" on the household day (WIB), the
        // same day the event writer stamps — so this fixture (which stands in
        // for events recorded "today") must stamp that day, not the UTC one.
        args.date ?? householdIsoDate(now),
        args.provider ?? 'openai-compatible',
        args.model ?? 'm',
        args.capability,
        args.householdId === undefined ? HOUSEHOLD : args.householdId,
        args.input ?? 0,
        args.output ?? 0,
        args.cached ?? null
      )
  }

  it("reports the acting member's calls by capability plus the household total", async () => {
    // The member: 2 reasoning + 1 vision + 1 typed decision (0 tokens).
    insertEvent({
      id: 'e1',
      userId: MEMBER,
      capability: 'reasoning',
      input: 1000,
      output: 100,
      cached: 700,
    })
    insertEvent({ id: 'e2', userId: MEMBER, capability: 'reasoning', input: 500, output: 50 })
    insertEvent({ id: 'e3', userId: MEMBER, capability: 'vision', input: 300, output: 30 })
    insertEvent({
      id: 'e4',
      userId: MEMBER,
      capability: 'decision',
      provider: 'questions',
      input: 0,
      output: 0,
    })
    // Another member of the same household — household total only.
    insertEvent({ id: 'e5', userId: OWNER, capability: 'reasoning', input: 2000, output: 200 })
    // Another user's event in another household must not leak in at all.
    sqlite
      .prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)')
      .run('h2', 'Other', ADMIN)
    insertEvent({ id: 'e6', userId: ADMIN, householdId: 'h2', capability: 'vision', input: 9999 })

    const res = await request('/api/ai/usage', {}, MEMBER)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any

    // "Your calls": the acting member only. There is no single `provider` any
    // more — the breakdown is the honest dimension (#523 P4).
    expect(body).not.toHaveProperty('provider')
    expect(body.used).toBe(4)
    expect(body.input_tokens).toBe(1800)
    expect(body.output_tokens).toBe(180)
    expect(body.cached_tokens).toBe(700)

    // Per capability, in the enum's own order; typed calls are flagged.
    expect(body.capabilities).toEqual([
      {
        capability: 'decision',
        used: 1,
        typed_calls: 1,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: null,
      },
      {
        capability: 'reasoning',
        used: 2,
        typed_calls: 0,
        input_tokens: 1500,
        output_tokens: 150,
        cached_tokens: 700,
      },
      {
        capability: 'vision',
        used: 1,
        typed_calls: 0,
        input_tokens: 300,
        output_tokens: 30,
        cached_tokens: null,
      },
    ])

    // The household cut: every member of THIS household today, nobody else's.
    expect(body.household).toEqual({
      used: 5,
      input_tokens: 3800,
      output_tokens: 380,
      cached_tokens: 700,
    })
  })

  it('is zeroed for a fresh member, with no rows invented', async () => {
    const res = await request('/api/ai/usage', {}, MEMBER)
    expect(await res.json()).toEqual({
      used: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: null,
      capabilities: [],
      household: { used: 0, input_tokens: 0, output_tokens: 0, cached_tokens: null },
    })
  })

  it('lists a pre-gateway event (capability NULL) as unknown, never as a capability', async () => {
    insertEvent({ id: 'legacy', userId: MEMBER, capability: null, input: 10, output: 1 })
    insertEvent({ id: 'new', userId: MEMBER, capability: 'reasoning', input: 20, output: 2 })
    const body = (await (await request('/api/ai/usage', {}, MEMBER)).json()) as any
    expect(body.used).toBe(2)
    expect(body.capabilities.map((row: { capability: unknown }) => row.capability)).toEqual([
      'reasoning',
      null,
    ])
  })

  it('scopes to the resolved request household, not the caller’s other memberships', async () => {
    // Same user, two households: the endpoint reads the middleware's household.
    sqlite
      .prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)')
      .run('h2', 'Other', MEMBER)
    sqlite
      .prepare(
        `INSERT INTO household_members (id, household_id, user_id, role, joined_at)
         VALUES ('m2', 'h2', ?, 'owner', '2026-01-02 00:00:00')`
      )
      .run(MEMBER)
    insertEvent({ id: 'e1', userId: MEMBER, capability: 'reasoning', input: 10 })
    insertEvent({ id: 'e2', userId: MEMBER, householdId: 'h2', capability: 'vision', input: 20 })

    const body = (await (await request('/api/ai/usage', {}, MEMBER)).json()) as any
    expect(body.used).toBe(2)
    expect(body.household.used).toBe(1)
    expect(body.household.input_tokens).toBe(10)
  })
})

describe('/api/admin/ai/usage — per-capability totals and the per-household cut', () => {
  function insertEvent(args: {
    id: string
    userId: string
    householdId: string
    capability: string
    provider?: string
    input?: number
    output?: number
    cached?: number | null
  }): void {
    const ts = new Date().toISOString()
    sqlite
      .prepare(
        `INSERT INTO ai_usage_events
           (id, user_id, ts, date, provider, model, capability, household_id, funding,
            input_tokens, output_tokens, cached_tokens)
         VALUES (?, ?, ?, ?, ?, 'm', ?, ?, 'household', ?, ?, ?)`
      )
      .run(
        args.id,
        args.userId,
        ts,
        ts.slice(0, 10),
        args.provider ?? 'openai-compatible',
        args.capability,
        args.householdId,
        args.input ?? 0,
        args.output ?? 0,
        args.cached ?? null
      )
  }

  it('serves each documented range with capability, user and household cuts', async () => {
    sqlite
      .prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)')
      .run('h2', 'Second home', OWNER)
    for (const range of ['24h', '7d', '30d']) {
      sqlite.prepare('DELETE FROM ai_usage_events').run()
      insertEvent({
        id: `${range}-1`,
        userId: OWNER,
        householdId: HOUSEHOLD,
        capability: 'reasoning',
        input: 1000,
        output: 100,
        cached: 500,
      })
      insertEvent({
        id: `${range}-2`,
        userId: MEMBER,
        householdId: HOUSEHOLD,
        capability: 'decision',
        provider: 'questions',
      })
      insertEvent({
        id: `${range}-3`,
        userId: ADMIN,
        householdId: 'h2',
        capability: 'vision',
        input: 200,
        output: 20,
      })

      const res = await request(`/api/admin/ai/usage?range=${range}`, {}, ADMIN)
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.range).toBe(range)
      expect(new Date(body.since).toISOString()).toBe(body.since)

      expect(body.totals.calls).toBe(3)
      expect(body.totals.input_tokens).toBe(1200)
      expect(body.totals.cache_hit_rate).toBe(500 / 1200)
      expect(body.totals.capabilities).toEqual([
        {
          capability: 'decision',
          calls: 1,
          typed_calls: 1,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: null,
        },
        {
          capability: 'reasoning',
          calls: 1,
          typed_calls: 0,
          input_tokens: 1000,
          output_tokens: 100,
          cached_tokens: 500,
        },
        {
          capability: 'vision',
          calls: 1,
          typed_calls: 0,
          input_tokens: 200,
          output_tokens: 20,
          cached_tokens: null,
        },
      ])

      // The per-user cut (unchanged shape).
      expect(body.users).toHaveLength(3)

      // The per-household cut names the household and its cache rate.
      const byId = new Map(body.households.map((row: any) => [row.household_id, row]))
      expect(byId.get(HOUSEHOLD)).toMatchObject({
        name: 'Test household',
        calls: 2,
        input_tokens: 1000,
        output_tokens: 100,
        cached_tokens: 500,
        cache_hit_rate: 0.5,
      })
      expect(byId.get('h2')).toMatchObject({ name: 'Second home', calls: 1, cache_hit_rate: null })
    }
  })

  it('returns zeroed totals and no rows when the range is empty', async () => {
    const res = await request('/api/admin/ai/usage?range=24h', {}, ADMIN)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.totals).toEqual({
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: null,
      cache_hit_rate: null,
      capabilities: [],
    })
    expect(body.users).toEqual([])
    expect(body.households).toEqual([])
  })

  it('keeps the usage of a deleted household (household_id SET NULL) under a null household', async () => {
    // 0041 models household_id as ON DELETE SET NULL: deleting a household must
    // not delete the record that its tokens were spent.
    sqlite
      .prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)')
      .run('h-gone', 'Gone', OWNER)
    insertEvent({
      id: 'e1',
      userId: OWNER,
      householdId: 'h-gone',
      capability: 'reasoning',
      input: 5,
    })
    sqlite.prepare('DELETE FROM households WHERE id = ?').run('h-gone')

    const body = (await (await request('/api/admin/ai/usage?range=24h', {}, ADMIN)).json()) as any
    expect(body.households).toEqual([
      expect.objectContaining({ household_id: null, name: null, calls: 1 }),
    ])
  })
})

// ---------------------------------------------------------------------------
// Fixtures.

/** One pending match-review pair (the same shape review-ai.test.ts uses). */
function insertReviewItem(id: string, lastFlaggedAt = '2026-11-01T00:00:00Z'): void {
  const pair = {
    itemProductKey: `${id}-item`,
    itemName: 'Beras Ramos 5 kg',
    itemBrand: null,
    itemUnit: '5 kg',
    itemPrice: 89000,
    itemEffectiveUnitPrice: 89000,
    itemStore: 'lotte-mart',
    entryProductKey: `${id}-entry`,
    entryName: 'Beras Ramos',
    entryBrand: 'Ramos',
    entryUnit: '5 kg',
    entryPrice: 27000,
    entryEffectiveUnitPrice: 27000,
    entryStore: 'superindo',
    matchMethod: 'exact',
    confidence: 1,
    reason: 'price_ratio',
  }
  sqlite
    .prepare(
      `INSERT INTO match_review_items
         (id, item_product_key, entry_product_key, pair_data, reason, match_method,
          confidence, run_started_at, first_flagged_at, last_flagged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      pair.itemProductKey,
      pair.entryProductKey,
      JSON.stringify(pair),
      pair.reason,
      pair.matchMethod,
      pair.confidence,
      lastFlaggedAt,
      lastFlaggedAt,
      lastFlaggedAt
    )
}
