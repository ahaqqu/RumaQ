import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'
import type { Env } from '../types.js'
import { apiApp } from '../apps/api.js'
import { encryptProviderKey } from '../lib/ai/credentials.js'
import { resetRateLimit } from '../lib/rate-limit.js'
import { createDb, type Db } from './support/d1-sqlite.js'

// The AI gateway SETTINGS surface (ahaqqu/RumaQ#523 P3, plan §4). Real SQLite
// over the real migration chain (node:sqlite — D1 is SQLite), so the label
// uniqueness index, the provider cap, the assignment upsert, the cascade report
// and the row-bound key envelope are the database's behaviour, not a mock's
// description of it. Requests go through the real `apiApp` and the real
// `propsAuthMiddleware`; `props` is the only shortcut (no session cookie).
//
// The matrix this file exists for (plan §6 P3):
//   401 no session  ·  200 reads as a member  ·  403 every write as a member
//   404 a provider id from another household  ·  409 duplicate label
//   400 kind/capability mismatch  ·  400 vision+thinking  ·  400 the 11th provider
//   404 assigning a missing provider  ·  the delete's cleared-capability report.

const ENCRYPTION_KEY = 'test-encryption-key-32-bytes-long!!'

let sqlite: Db
let d1: D1Database
let env: Env['Bindings']
let realFetch: typeof fetch

beforeEach(() => {
  const { sqlite: db, d1: adapter } = createDb()
  sqlite = db
  d1 = adapter
  sqlite.exec('PRAGMA foreign_keys = ON')
  env = {
    DB: d1,
    WORKER_ENCRYPTION_KEY: ENCRYPTION_KEY,
    TEST_MODE: 'true',
    PAGES_ORIGIN: 'http://localhost:5173',
  } as unknown as Env['Bindings']
  realFetch = globalThis.fetch
  // The general per-IP limiter and the provider-test limiter keep module-scope
  // windows keyed by IP/user; a fresh database per test must not inherit the
  // previous test's budget (the file crosses 100 requests in one window).
  resetRateLimit()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

// --- fixtures ---------------------------------------------------------------

function seedHouseholds(): void {
  sqlite.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'owner@x', 'Alice')").run()
  sqlite.prepare("INSERT INTO users (id, email, name) VALUES ('u2', 'member@x', 'Bob')").run()
  sqlite.prepare("INSERT INTO users (id, email, name) VALUES ('u9', 'other@x', 'Carol')").run()
  sqlite.prepare("INSERT INTO households (id, name, created_by) VALUES ('h1', 'H1', 'u1')").run()
  sqlite.prepare("INSERT INTO households (id, name, created_by) VALUES ('h2', 'H2', 'u9')").run()
  const member = sqlite.prepare(
    `INSERT INTO household_members (id, household_id, user_id, role, joined_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  member.run('m-owner', 'h1', 'u1', 'owner', '2026-01-01 00:00:00')
  member.run('m-member', 'h1', 'u2', 'member', '2026-02-01 00:00:00')
  member.run('m-other', 'h2', 'u9', 'owner', '2026-01-01 00:00:00')
  sqlite
    .prepare(
      "INSERT INTO user_settings (id, user_id, active_household_id) VALUES ('s1', 'u1', 'h1')"
    )
    .run()
  sqlite
    .prepare(
      "INSERT INTO user_settings (id, user_id, active_household_id) VALUES ('s2', 'u2', 'h1')"
    )
    .run()
  sqlite
    .prepare(
      "INSERT INTO user_settings (id, user_id, active_household_id) VALUES ('s9', 'u9', 'h2')"
    )
    .run()
}

const OWNER = { userId: 'u1', householdId: 'h1' }
const MEMBER = { userId: 'u2', householdId: 'h1' }

function as(props: { userId: string; householdId: string } | undefined) {
  return { ...env, props } as unknown as Env['Bindings']
}

function call(
  method: string,
  path: string,
  props: { userId: string; householdId: string } | undefined,
  body?: unknown
) {
  return apiApp.request(
    path,
    {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    },
    as(props)
  )
}

/** Insert a provider row directly (bypassing the route: fixtures, not coverage). */
async function insertProvider(args: {
  id: string
  householdId?: string
  label?: string
  kind?: string
  preset?: string | null
  baseUrl?: string | null
  defaultModel?: string | null
  /** null = a keyless row (the "cannot be assigned yet" state). */
  key?: string | null
}): Promise<string> {
  const id = args.id
  const encrypted =
    args.key === null ? null : await encryptProviderKey(env, id, args.key ?? 'sk-fixture')
  sqlite
    .prepare(
      `INSERT INTO ai_providers
         (id, household_id, label, kind, preset, base_url, default_model, encrypted_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      args.householdId ?? 'h1',
      args.label ?? id,
      args.kind ?? 'gemini',
      args.preset === undefined ? 'gemini' : args.preset,
      args.baseUrl ?? null,
      args.defaultModel ?? null,
      encrypted
    )
  return id
}

function insertCapability(
  capability: string,
  providerId: string,
  opts: { householdId?: string; model?: string | null; thinking_level?: string | null } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO ai_capabilities (household_id, capability, provider_id, model, thinking_level)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      opts.householdId ?? 'h1',
      capability,
      providerId,
      opts.model ?? null,
      opts.thinking_level ?? null
    )
}

function jsonResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response
}

// --- 401 --------------------------------------------------------------------

describe('AI settings routes — authentication (plan §6 P3: 401 without a session)', () => {
  const ROUTES: Array<[string, string]> = [
    ['GET', '/api/ai/presets'],
    ['GET', '/api/ai/providers'],
    ['POST', '/api/ai/providers'],
    ['PATCH', '/api/ai/providers/p-1'],
    ['DELETE', '/api/ai/providers/p-1'],
    ['POST', '/api/ai/providers/p-1/test'],
    ['GET', '/api/ai/capabilities'],
    ['PUT', '/api/ai/capabilities/decision'],
    ['DELETE', '/api/ai/capabilities/decision'],
  ]

  it('every new path answers 401 without a session (a missed use-line is unauthenticated)', async () => {
    seedHouseholds()
    for (const [method, path] of ROUTES) {
      const res = await call(method, path, undefined, method === 'GET' ? undefined : {})
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })
})

// --- member: reads 200, every write 403 -------------------------------------

describe('AI settings routes — the member boundary (plan §4.1)', () => {
  beforeEach(() => {
    seedHouseholds()
  })

  it('a member READS the providers, the capabilities and the presets', async () => {
    await insertProvider({ id: 'p-1', label: 'Home key', defaultModel: 'gemini-3.6-flash' })
    insertCapability('reasoning', 'p-1')

    const providers = await call('GET', '/api/ai/providers', MEMBER)
    expect(providers.status).toBe(200)
    const body = (await providers.json()) as any
    expect(body.can_manage).toBe(false)
    // The read-only line the UI renders: the owner's display name.
    expect(body.managed_by).toBe('Alice')
    expect(body.providers).toEqual([
      expect.objectContaining({ id: 'p-1', label: 'Home key', has_key: true }),
    ])
    expect(JSON.stringify(body)).not.toContain('encrypted_key')

    const capabilities = await call('GET', '/api/ai/capabilities', MEMBER)
    expect(capabilities.status).toBe(200)
    const caps = (await capabilities.json()) as any
    expect(caps.can_manage).toBe(false)
    expect(caps.status.reasoning).toBe('household')
    // The assignment has no model of its own; the payload reports the column
    // (null = inherit) and the resolved value separately, so the Settings form
    // can round-trip a pinned model without guessing (#523 P3 review A2).
    expect(caps.capabilities.reasoning.model).toBeNull()
    expect(caps.capabilities.reasoning.effective_model).toBe('gemini-3.6-flash')

    const presets = await call('GET', '/api/ai/presets', MEMBER)
    expect(presets.status).toBe(200)
  })

  it('a member gets 403 on EVERY write, before any row is touched', async () => {
    await insertProvider({ id: 'p-1', label: 'Home key' })
    insertCapability('reasoning', 'p-1')
    const before = sqlite.prepare('SELECT * FROM ai_providers').all()

    const writes: Array<[string, string, unknown?]> = [
      ['POST', '/api/ai/providers', { label: 'Mine', kind: 'gemini', api_key: 'sk-x' }],
      ['PATCH', '/api/ai/providers/p-1', { label: 'Renamed' }],
      ['DELETE', '/api/ai/providers/p-1'],
      ['POST', '/api/ai/providers/p-1/test'],
      ['PUT', '/api/ai/capabilities/decision', { provider_id: 'p-1' }],
      ['DELETE', '/api/ai/capabilities/reasoning'],
    ]
    for (const [method, path, body] of writes) {
      const res = await call(method, path, MEMBER, body)
      expect(res.status, `${method} ${path}`).toBe(403)
      expect(((await res.json()) as any).error).toMatch(/owner/i)
    }

    // Nothing changed: the gate ran first (plan §4.2 "role checks come first").
    expect(sqlite.prepare('SELECT * FROM ai_providers').all()).toEqual(before)
    expect(sqlite.prepare('SELECT COUNT(*) AS cnt FROM ai_capabilities').get()).toEqual({ cnt: 1 })
  })
})

// --- presets ---------------------------------------------------------------

describe('GET /api/ai/presets (plan §4.1/§4.5)', () => {
  beforeEach(seedHouseholds)

  it('publishes the catalog with NO model ids and no preselection', async () => {
    const res = await call('GET', '/api/ai/presets', OWNER)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.presets.map((preset: any) => preset.id)).toEqual([
      'openai',
      'opencode',
      'anthropic',
      'gemini',
      'ollama',
      'openrouter-decisions',
      'openrouter',
      'custom',
    ])
    for (const preset of body.presets) {
      // label + kind + base URL only: a model is owner-typed row data, never a
      // preset field, so no vendor alias can age in this payload.
      expect(Object.keys(preset).sort()).toEqual(['base_url', 'id', 'kind', 'label'])
    }
    // No model-looking identifier anywhere in the catalog.
    expect(JSON.stringify(body)).not.toMatch(/gpt-|gemini-3|claude-|glm-|jev-/i)
  })
})

// --- provider CRUD ---------------------------------------------------------

describe('POST /api/ai/providers (plan §4.2)', () => {
  beforeEach(seedHouseholds)

  it('rejects a whitespace-only label instead of storing an empty one', async () => {
    // Valibot's minLength(1) lets "   " through; the write trims and refuses.
    const res = await call('POST', '/api/ai/providers', OWNER, {
      label: '   ',
      kind: 'gemini',
      preset: 'gemini',
      api_key: 'sk-very-secret',
    })
    expect(res.status).toBe(400)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM ai_providers').get()).toEqual({ n: 0 })
  })

  it('creates a provider, seals the key to the row, and never echoes it', async () => {
    const res = await call('POST', '/api/ai/providers', OWNER, {
      label: 'Home key',
      kind: 'gemini',
      preset: 'gemini',
      default_model: 'gemini-3.6-flash',
      api_key: 'sk-very-secret',
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as any
    expect(body.provider).toMatchObject({
      label: 'Home key',
      kind: 'gemini',
      preset: 'gemini',
      base_url: null,
      default_model: 'gemini-3.6-flash',
      has_key: true,
    })
    expect(JSON.stringify(body)).not.toContain('sk-very-secret')
    expect(JSON.stringify(body)).not.toContain('encrypted_key')

    const row = sqlite
      .prepare("SELECT * FROM ai_providers WHERE household_id = 'h1'")
      .get() as Record<string, unknown>
    expect(row.id).toBe(body.provider.id)
    // D10: written with the provider row id as additional authenticated data.
    expect(String(row.encrypted_key)).toMatch(/^v2:/)
  })

  it('never returns key material under ANY field name, on any read', async () => {
    // Review A6: the old guard asserted the literal field name (`encrypted_key`)
    // and used `objectContaining`, so a decrypted `api_key` on the list passed
    // all 1,305 tests. This pins the exact provider shape and a plaintext canary.
    const created = await call('POST', '/api/ai/providers', OWNER, {
      label: 'Canary',
      kind: 'gemini',
      preset: 'gemini',
      default_model: 'gemini-3.6-flash',
      api_key: 'sk-canary-6b21',
    })
    const id = ((await created.json()) as any).provider.id
    await call('PUT', '/api/ai/capabilities/decision', OWNER, { provider_id: id, model: '' })

    const list = (await (await call('GET', '/api/ai/providers', OWNER)).json()) as any
    expect(list.providers).toHaveLength(1)
    // Exact shape, not objectContaining: adding a field to the serialiser fails.
    expect(Object.keys(list.providers[0]).sort()).toEqual([
      'base_url',
      'created_at',
      'default_model',
      'has_key',
      'id',
      'kind',
      'label',
      'preset',
      'updated_at',
    ])

    for (const path of ['/api/ai/providers', '/api/ai/capabilities', '/api/settings']) {
      const res = await call('GET', path, OWNER)
      expect(res.status, path).toBe(200)
      const text = await res.text()
      expect(text, path).not.toContain('sk-canary-6b21')
      expect(text, path).not.toContain('encrypted_key')
    }
  })

  it('a stored key that cannot be decrypted answers ok:false unreadable_key, never a 500', async () => {
    sqlite
      .prepare(
        `INSERT INTO ai_providers
           (id, household_id, label, kind, preset, base_url, default_model, encrypted_key)
         VALUES ('p-broken', 'h1', 'Broken', 'gemini', 'gemini', NULL, NULL, 'v2:not-a-real-envelope')`
      )
      .run()
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await call('POST', '/api/ai/providers/p-broken/test', OWNER)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, code: 'unreadable_key' })
    // Nothing was sent to a provider and the error carries no key material.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts a typed-decision row from its preset or an explicit base URL', async () => {
    // No endpoint anywhere: the row could never resolve one (400).
    const missing = await call('POST', '/api/ai/providers', OWNER, {
      label: 'Typed without endpoint',
      kind: 'questions',
      api_key: 'sk-typed',
    })
    expect(missing.status).toBe(400)

    // The preset carries the canonical endpoint, exactly like every other
    // preset row: the base URL does not need to be repeated on the row (A1).
    const fromPreset = await call('POST', '/api/ai/providers', OWNER, {
      label: 'OpenRouter decisions',
      kind: 'questions',
      preset: 'openrouter-decisions',
      default_model: 'perplexity/pplx-decider-v1.2',
      api_key: 'sk-typed',
    })
    expect(fromPreset.status).toBe(201)
    const presetBody = (await fromPreset.json()) as any
    expect(presetBody.provider.base_url).toBeNull()
    expect(presetBody.provider.preset).toBe('openrouter-decisions')

    // And it is assignable: the endpoint resolves through the preset, so the
    // capability is usable rather than silently 402 (the same resolver rule).
    const assigned = await call('PUT', '/api/ai/capabilities/decision', OWNER, {
      provider_id: presetBody.provider.id,
      model: '',
    })
    expect(assigned.status).toBe(200)
    const assignedBody = (await assigned.json()) as any
    expect(assignedBody.status).toBe('household')
    expect(assignedBody.capability.effective_model).toBe('perplexity/pplx-decider-v1.2')

    const explicit = await call('POST', '/api/ai/providers', OWNER, {
      label: 'Typed custom',
      kind: 'questions',
      base_url: 'https://ai.example.test/decisions',
      api_key: 'sk-typed',
    })
    expect(explicit.status).toBe(201)
    expect(((await explicit.json()) as any).provider.base_url).toBe(
      'https://ai.example.test/decisions'
    )
  })

  it('rejects HTTP (non-HTTPS) and over-long labels at the door', async () => {
    const http = await call('POST', '/api/ai/providers', OWNER, {
      label: 'Plain',
      kind: 'openai-compatible',
      base_url: 'http://api.example.test/v1',
      api_key: 'sk-x',
    })
    expect(http.status).toBe(400)

    const longLabel = await call('POST', '/api/ai/providers', OWNER, {
      label: 'l'.repeat(61),
      kind: 'gemini',
      api_key: 'sk-x',
    })
    expect(longLabel.status).toBe(400)
  })

  it('rejects a preset whose wire disagrees with the kind (400)', async () => {
    const res = await call('POST', '/api/ai/providers', OWNER, {
      label: 'Mismatch',
      kind: 'anthropic',
      preset: 'gemini',
      api_key: 'sk-x',
    })
    expect(res.status).toBe(400)
  })

  it('answers 409 for a duplicate label, case-insensitively', async () => {
    await insertProvider({ id: 'p-1', label: 'Work account' })
    const res = await call('POST', '/api/ai/providers', OWNER, {
      label: 'work ACCOUNT',
      kind: 'gemini',
      api_key: 'sk-x',
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error).toMatch(/already exists/i)
  })

  it('caps a household at ten providers (400 on the eleventh)', async () => {
    for (let i = 1; i <= 10; i += 1) {
      await insertProvider({ id: `p-${i}`, label: `Provider ${i}` })
    }
    const res = await call('POST', '/api/ai/providers', OWNER, {
      label: 'Eleven',
      kind: 'gemini',
      api_key: 'sk-x',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/at most 10/i)
    expect(
      sqlite.prepare("SELECT COUNT(*) AS cnt FROM ai_providers WHERE household_id = 'h1'").get()
    ).toEqual({ cnt: 10 })
  })
})

describe('PATCH/DELETE /api/ai/providers/:id (plan §4.1/§4.2)', () => {
  beforeEach(seedHouseholds)

  it('404s every provider id from ANOTHER household (never a 403 that confirms it)', async () => {
    await insertProvider({ id: 'p-other', householdId: 'h2', label: 'Theirs' })

    for (const [method, path, body] of [
      ['PATCH', '/api/ai/providers/p-other', { label: 'Hijack' }],
      ['DELETE', '/api/ai/providers/p-other'],
      ['POST', '/api/ai/providers/p-other/test'],
    ] as Array<[string, string, unknown?]>) {
      const res = await call(method, path, OWNER, body)
      expect(res.status, `${method} ${path}`).toBe(404)
    }
    // A missing id is the same 404 — the row's existence is never a signal.
    expect((await call('PATCH', '/api/ai/providers/nope', OWNER, { label: 'x' })).status).toBe(404)
    expect(sqlite.prepare("SELECT label FROM ai_providers WHERE id = 'p-other'").get()).toEqual({
      label: 'Theirs',
    })
  })

  it('renames, re-keys and clears the default model; 409 on a duplicate label', async () => {
    await insertProvider({ id: 'p-1', label: 'One', defaultModel: 'gemini-3.6-flash' })
    await insertProvider({ id: 'p-2', label: 'Two' })

    const renamed = await call('PATCH', '/api/ai/providers/p-1', OWNER, {
      label: 'Renamed',
      default_model: '',
      api_key: 'sk-new',
    })
    expect(renamed.status).toBe(200)
    const body = (await renamed.json()) as any
    expect(body.provider).toMatchObject({ label: 'Renamed', default_model: null, has_key: true })

    const duplicate = await call('PATCH', '/api/ai/providers/p-1', OWNER, { label: 'two' })
    expect(duplicate.status).toBe(409)

    // api_key: '' clears the key of an UNASSIGNED provider.
    const cleared = await call('PATCH', '/api/ai/providers/p-1', OWNER, { api_key: '' })
    expect(cleared.status).toBe(200)
    expect(((await cleared.json()) as any).provider.has_key).toBe(false)
  })

  it('refuses to clear the key of an ASSIGNED provider (409 — reassign first)', async () => {
    await insertProvider({ id: 'p-1', label: 'One' })
    insertCapability('reasoning', 'p-1')

    const res = await call('PATCH', '/api/ai/providers/p-1', OWNER, { api_key: '' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error).toMatch(/reasoning/)
    expect(
      sqlite.prepare("SELECT encrypted_key FROM ai_providers WHERE id = 'p-1'").get()
    ).toMatchObject({ encrypted_key: expect.stringMatching(/^v2:/) })
  })

  it('rejects a kind change that would strand an assignment (400)', async () => {
    await insertProvider({ id: 'p-1', label: 'One', kind: 'gemini', preset: 'gemini' })
    insertCapability('vision', 'p-1')

    // 'questions' cannot serve vision — save-time validation, not a call-time 500.
    const res = await call('PATCH', '/api/ai/providers/p-1', OWNER, { kind: 'questions' })
    expect(res.status).toBe(400)
  })

  it('refuses to move a provider to the typed wire while an assignment keeps a thinking level', async () => {
    await insertProvider({ id: 'p-1', label: 'One', kind: 'anthropic', preset: 'anthropic' })
    insertCapability('decision', 'p-1', { thinking_level: 'high' })

    const res = await call('PATCH', '/api/ai/providers/p-1', OWNER, { kind: 'questions' })
    expect(res.status).toBe(400)
    // Nothing was written: the row and its assignment are untouched.
    expect(sqlite.prepare("SELECT kind FROM ai_providers WHERE id = 'p-1'").get()).toEqual({
      kind: 'anthropic',
    })
  })

  it('refuses to clear the default model an assigned capability inherits (409)', async () => {
    // Review A5: the model is the third usability input, so clearing the last
    // model an assignment relies on is the same silent-402 hazard as clearing
    // its key — refused, with the capability named.
    await insertProvider({ id: 'p-1', label: 'One', defaultModel: 'gemini-3.6-flash' })
    insertCapability('reasoning', 'p-1')

    const res = await call('PATCH', '/api/ai/providers/p-1', OWNER, { default_model: '' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error).toMatch(/reasoning/)
    expect(sqlite.prepare("SELECT default_model FROM ai_providers WHERE id = 'p-1'").get()).toEqual(
      { default_model: 'gemini-3.6-flash' }
    )

    // Re-sending the existing value, or a value, is not a clear.
    expect(
      (await call('PATCH', '/api/ai/providers/p-1', OWNER, { default_model: 'gemini-3.6-flash' }))
        .status
    ).toBe(200)
  })

  it('allows clearing the default model when every assignment pins its own', async () => {
    await insertProvider({ id: 'p-1', label: 'One', defaultModel: 'gemini-3.6-flash' })
    insertCapability('reasoning', 'p-1', { model: 'own-model' })

    const res = await call('PATCH', '/api/ai/providers/p-1', OWNER, { default_model: '' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).provider.default_model).toBeNull()
    // The capability keeps resolving through its own model.
    const caps = (await (await call('GET', '/api/ai/capabilities', OWNER)).json()) as any
    expect(caps.capabilities.reasoning.effective_model).toBe('own-model')
    expect(caps.status.reasoning).toBe('household')
  })

  it('reports the capabilities a delete cleared, and the assignments are gone', async () => {
    await insertProvider({ id: 'p-1', label: 'One' })
    await insertProvider({ id: 'p-2', label: 'Two' })
    insertCapability('reasoning', 'p-1')
    insertCapability('vision', 'p-1')
    insertCapability('decision', 'p-2')

    const res = await call('DELETE', '/api/ai/providers/p-1', OWNER)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).cleared).toEqual(['reasoning', 'vision'])

    expect(sqlite.prepare("SELECT id FROM ai_providers WHERE id = 'p-1'").get()).toBeUndefined()
    expect(
      sqlite.prepare("SELECT capability FROM ai_capabilities WHERE household_id = 'h1'").all()
    ).toEqual([{ capability: 'decision' }])

    // The capability then reads as not configured, honestly.
    const caps = (await (await call('GET', '/api/ai/capabilities', OWNER)).json()) as any
    expect(caps.status.reasoning).toBe('none')
    expect(caps.capabilities.reasoning.source).toBe('none')
  })
})

// --- capabilities ----------------------------------------------------------

describe('PUT/DELETE /api/ai/capabilities/:capability (plan §4.1/§4.2)', () => {
  beforeEach(seedHouseholds)

  it('assigns a provider and reports the EFFECTIVE model (capability ?? provider default)', async () => {
    await insertProvider({ id: 'p-1', defaultModel: 'gemini-3.6-flash' })

    const res = await call('PUT', '/api/ai/capabilities/reasoning', OWNER, {
      provider_id: 'p-1',
      model: '',
      thinking_level: 'medium',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.status).toBe('household')
    expect(body.capability).toMatchObject({
      provider_id: 'p-1',
      // `model: ''` is the inherit sentinel: the column stays null and the
      // resolved value comes back in `effective_model`.
      model: null,
      effective_model: 'gemini-3.6-flash',
      thinking_level: 'medium',
      source: 'household',
    })

    // Upsert: one assignment per capability.
    await insertProvider({ id: 'p-2', label: 'Second', defaultModel: 'gemini-3.6-pro' })
    const second = await call('PUT', '/api/ai/capabilities/reasoning', OWNER, {
      provider_id: 'p-2',
    })
    expect(((await second.json()) as any).capability.effective_model).toBe('gemini-3.6-pro')
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS cnt FROM ai_capabilities WHERE household_id = 'h1' AND capability = 'reasoning'"
        )
        .get()
    ).toEqual({ cnt: 1 })
  })

  it('both blank = not configured, not an error (plan §4.5)', async () => {
    await insertProvider({ id: 'p-1', defaultModel: null })
    const res = await call('PUT', '/api/ai/capabilities/decision', OWNER, {
      provider_id: 'p-1',
      model: '',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.status).toBe('none')
    expect(body.capability.source).toBe('household')
    expect(body.capability.model).toBeNull()
    expect(body.capability.effective_model).toBeNull()
  })

  it('rejects a kind that cannot serve the capability (400)', async () => {
    const typed = await insertProvider({
      id: 'p-typed',
      label: 'Typed',
      kind: 'questions',
      preset: null,
      baseUrl: 'https://ai.example.test/decisions',
    })
    // A typed provider answers closed choices only (decision), never vision.
    const vision = await call('PUT', '/api/ai/capabilities/vision', OWNER, { provider_id: typed })
    expect(vision.status).toBe(400)

    const reasoning = await call('PUT', '/api/ai/capabilities/reasoning', OWNER, {
      provider_id: typed,
    })
    expect(reasoning.status).toBe(400)

    // …and it IS assignable to decision (both shapes are allowed, §7.2 #5).
    const decision = await call('PUT', '/api/ai/capabilities/decision', OWNER, {
      provider_id: typed,
    })
    expect(decision.status).toBe(200)
  })

  it('rejects a thinking level for vision and for a typed provider (400)', async () => {
    await insertProvider({ id: 'p-1' })
    const vision = await call('PUT', '/api/ai/capabilities/vision', OWNER, {
      provider_id: 'p-1',
      thinking_level: 'high',
    })
    expect(vision.status).toBe(400)
    expect(((await vision.json()) as any).error).toMatch(/thinking/i)

    const typed = await insertProvider({
      id: 'p-typed',
      label: 'Typed',
      kind: 'questions',
      preset: null,
      baseUrl: 'https://ai.example.test/decisions',
    })
    const typedThinking = await call('PUT', '/api/ai/capabilities/decision', OWNER, {
      provider_id: typed,
      thinking_level: 'low',
    })
    expect(typedThinking.status).toBe(400)
  })

  it('404s a provider id that does not exist in this household (including another one’s)', async () => {
    await insertProvider({ id: 'p-other', householdId: 'h2', label: 'Theirs' })
    expect(
      (await call('PUT', '/api/ai/capabilities/decision', OWNER, { provider_id: 'p-other' })).status
    ).toBe(404)
    expect(
      (await call('PUT', '/api/ai/capabilities/decision', OWNER, { provider_id: 'ghost' })).status
    ).toBe(404)
  })

  it('rejects assigning a provider with no key or no endpoint (400)', async () => {
    const keyless = await insertProvider({ id: 'p-keyless', label: 'Keyless', key: null })
    expect(
      (await call('PUT', '/api/ai/capabilities/reasoning', OWNER, { provider_id: keyless })).status
    ).toBe(400)

    const endpointless = await insertProvider({
      id: 'p-no-url',
      label: 'No URL',
      kind: 'openai-compatible',
      preset: null,
      baseUrl: null,
    })
    const res = await call('PUT', '/api/ai/capabilities/reasoning', OWNER, {
      provider_id: endpointless,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/base URL/i)
  })

  it('rejects an unknown capability and clears idempotently', async () => {
    expect(
      (await call('PUT', '/api/ai/capabilities/embedding', OWNER, { provider_id: 'p-1' })).status
    ).toBe(400)

    await insertProvider({ id: 'p-1' })
    insertCapability('decision', 'p-1')
    const cleared = await call('DELETE', '/api/ai/capabilities/decision', OWNER)
    expect(cleared.status).toBe(200)
    expect(((await cleared.json()) as any).status).toBe('none')
    // Idempotent: clearing an unassigned capability is a 200, not a 404.
    expect((await call('DELETE', '/api/ai/capabilities/decision', OWNER)).status).toBe(200)
    expect((await call('DELETE', '/api/ai/capabilities/nope', OWNER)).status).toBe(400)
  })
})

// --- connection test -------------------------------------------------------

describe('POST /api/ai/providers/:id/test (plan §4.6)', () => {
  beforeEach(seedHouseholds)

  it('a preset-less gemini row is assignable and probes its canonical endpoint', async () => {
    // Review A4: kind gemini/anthropic own a canonical endpoint, the resolver
    // accepts a row without a base URL, and createProvider allows creating one —
    // so assign and test must accept it too (one rule, capabilities.ts).
    const created = await call('POST', '/api/ai/providers', OWNER, {
      label: 'Canonical',
      kind: 'gemini',
      api_key: 'sk-canonical',
    })
    expect(created.status).toBe(201)
    const provider = ((await created.json()) as any).provider
    expect(provider).toMatchObject({ preset: null, base_url: null, has_key: true })

    const assigned = await call('PUT', '/api/ai/capabilities/vision', OWNER, {
      provider_id: provider.id,
      model: 'gemini-3.6-flash',
    })
    expect(assigned.status).toBe(200)
    expect(((await assigned.json()) as any).status).toBe('household')

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { models: [] }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const tested = await call('POST', `/api/ai/providers/${provider.id}/test`, OWNER)
    expect(tested.status).toBe(200)
    expect(await tested.json()).toEqual({ ok: true })
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?key=sk-canonical'
    )
  })

  it('a gemini probe tests the endpoint the CALL uses, not a stored base URL', async () => {
    // Review A4: gemini.complete builds its URL from the canonical ENDPOINT, so
    // probing a row's base_url would report on an endpoint no call reaches.
    await insertProvider({
      id: 'p-proxy',
      kind: 'gemini',
      preset: 'gemini',
      baseUrl: 'https://proxy.example.test/v1beta',
      defaultModel: 'gemini-3.6-flash',
    })
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { models: [] }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await call('POST', '/api/ai/providers/p-proxy/test', OWNER)
    expect(res.status).toBe(200)
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?key=sk-fixture'
    )
  })

  it('a chat provider probes its free /models listing', async () => {
    await insertProvider({ id: 'p-1', kind: 'openai-compatible', preset: 'openai' })
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await call('POST', '/api/ai/providers/p-1/test', OWNER)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://api.openai.com/v1/models')
    expect(
      String((init as RequestInit).headers && JSON.stringify((init as RequestInit).headers))
    ).toContain('Bearer')
  })

  it('a typed provider expects the empty-questions 400 — free, not billed', async () => {
    await insertProvider({
      id: 'p-typed',
      kind: 'questions',
      preset: null,
      baseUrl: 'https://ai.example.test/decisions',
      defaultModel: 'jev-latest',
    })
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, { error: 'no questions' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await call('POST', '/api/ai/providers/p-typed/test', OWNER)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    // The body is the deliberately malformed probe: the documented envelope
    // (array state) with an EMPTY questions object.
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body).toEqual({ state: [], model: 'jev-latest', questions: {} })
  })

  it('reports a failure as a CODE, never the provider body', async () => {
    await insertProvider({ id: 'p-1', kind: 'openai-compatible', preset: 'openai' })
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(401, { error: 'sk-leaked-in-body' })
      ) as unknown as typeof fetch

    const res = await call('POST', '/api/ai/providers/p-1/test', OWNER)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, code: 'auth' })
  })

  it('400s a provider with no key to test', async () => {
    await insertProvider({ id: 'p-keyless', label: 'Keyless', key: null })
    const res = await call('POST', '/api/ai/providers/p-keyless/test', OWNER)
    expect(res.status).toBe(400)
  })

  it('is rate-limited per user like OCR (30/min)', async () => {
    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u3', 'ratelimit@x')").run()
    sqlite
      .prepare(
        "INSERT INTO household_members (id, household_id, user_id, role) VALUES ('m-rl', 'h1', 'u3', 'owner')"
      )
      .run()
    await insertProvider({ id: 'p-1', kind: 'openai-compatible', preset: 'openai' })
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: [] })) as unknown as typeof fetch

    const limiter = { userId: 'u3', householdId: 'h1' }
    for (let i = 0; i < 30; i += 1) {
      expect((await call('POST', '/api/ai/providers/p-1/test', limiter)).status).toBe(200)
    }
    const limited = await call('POST', '/api/ai/providers/p-1/test', limiter)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).toBeTruthy()

    // A different user has their own window.
    expect((await call('POST', '/api/ai/providers/p-1/test', OWNER)).status).toBe(200)

    // The role gate runs BEFORE the limiter: 40 member attempts all answer 403,
    // never the 429 a member would see if the window were checked first (review
    // C1). 30 would pass under either order.
    for (let i = 0; i < 40; i += 1) {
      expect(
        (await call('POST', '/api/ai/providers/p-1/test', MEMBER)).status,
        `attempt ${i}`
      ).toBe(403)
    }
  })
})

// --- the fresh-database Settings payload -----------------------------------

describe('settings payload on a fresh database (#523 P3)', () => {
  beforeEach(seedHouseholds)

  it('GET /api/settings works with no AI rows and no legacy columns', async () => {
    const res = await call('GET', '/api/settings', OWNER)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body).toMatchObject({
      motion_preference: 'standard',
      language: null,
      persona_enabled: false,
      active_household_id: 'h1',
      active_household_name: 'H1',
      ai_providers: [],
      ai_status: { decision: 'none', reasoning: 'none', vision: 'none' },
    })
    for (const field of [
      'ai_provider',
      'ai_model',
      'ai_vision_model',
      'ai_thinking_level',
      'ai_base_url',
      'has_ai_key',
      'server_ai_available',
    ]) {
      expect(body, field).not.toHaveProperty(field)
    }
  })

  it('GET /api/ai/providers tells the owner they can manage, with no owner name to show', async () => {
    const res = await call('GET', '/api/ai/providers', OWNER)
    expect(await res.json()).toEqual({ can_manage: true, managed_by: null, providers: [] })
  })
})
