import { describe, it, expect, vi } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'

const ENCRYPTED_KEY = 'v1:KIPkC6p1Fvnv4KoVsu-dx-GNoEqmm2kStaExhNbptUJ3lrE'

function createMockEnv(overrides = {}) {
  return {
    DB: {
      prepare: vi.fn().mockReturnThis(),
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
      batch: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue(undefined),
    },
    RECEIPTS: { put: vi.fn().mockResolvedValue({}), get: vi.fn().mockResolvedValue(null) },
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    WORKER_JWT_SECRET: 'test-secret',
    WORKER_ENCRYPTION_KEY: 'test-encryption-key-32-bytes-long!!',
    PAGES_ORIGIN: 'http://localhost:5173',
    EMAIL_AUTH_ENABLED: 'false',
    ASSETS: undefined as unknown as Fetcher,
    props: undefined,
    TEST_MODE: 'true',
    ...overrides,
  }
}

// The AI routes read two shapes through the same mocked D1: the caller's
// persona settings (the only user_settings read left after #523 P3) and the
// capability JOIN row. One fixture carries both halves so a single
// `.mockResolvedValue` answers either read; `mockResolvedValueOnce` chains add
// the extra capability read explicitly.
function aiConfiguredRow(overrides: Record<string, unknown> = {}) {
  return {
    // persona-settings half
    persona_enabled: 0,
    persona_user_role: null,
    persona_ai_role: null,
    // capability-join half (what resolveAccess actually reads)
    capability: 'reasoning',
    model: null,
    thinking_level: null,
    provider_id: 'p-1',
    kind: 'openai-compatible',
    preset: 'openai',
    base_url: null,
    // The capability leaves its model blank, so the provider default serves it
    // (#523 owner decision) — this is the common "one alias per key" shape.
    default_model: 'gpt-4o-mini',
    encrypted_key: ENCRYPTED_KEY,
    ...overrides,
  }
}

function aiCapabilityRow(overrides: Record<string, unknown> = {}) {
  return {
    capability: 'reasoning',
    model: null,
    thinking_level: null,
    provider_id: 'p-1',
    kind: 'openai-compatible',
    preset: 'openai',
    base_url: null,
    default_model: 'gpt-4o-mini',
    encrypted_key: ENCRYPTED_KEY,
    ...overrides,
  }
}

describe('api routes', () => {
  it('/api/health returns ok', async () => {
    const res = await apiApp.request('/api/health', {}, createMockEnv())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('/api/auth/email-status reflects env flag', async () => {
    const env = createMockEnv({ EMAIL_AUTH_ENABLED: 'true' })
    const res = await apiApp.request('/api/auth/email-status', {}, env)
    expect(((await res.json()) as any).enabled).toBe(true)
  })

  it('/api/me returns user with props', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValue({ id: 'u1', email: 'a@b.com', name: 'Alice', picture: null })
    const res = await apiApp.request('/api/me', {}, env)
    expect(res.status).toBe(200)
  })

  // Route-level pin for the plugin advertisement (§4.5, #435): the handler
  // must COPY the resolver's output into the payload — ids only, not manifest
  // objects. The enablement rows come back through the REAL statement the
  // route issues, so a wiring break (field dropped, resolver bypassed) fails
  // these instead of being absorbed by a mock default (#422-A3 lesson).
  it('/api/me advertises enabledPlugins as ids-only from the enablement rows', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValue({ id: 'u1', email: 'a@b.com', name: 'Alice', picture: null })
    env.DB.all = vi
      .fn()
      .mockResolvedValue({ results: [{ plugin_id: 'documents', status: 'enabled' }] })
    const res = await apiApp.request('/api/me', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { enabledPlugins?: unknown }
    expect(body.enabledPlugins).toEqual(['documents'])
  })

  it('/api/me omits enabledPlugins when the enablement read fails and still answers 200', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValue({ id: 'u1', email: 'a@b.com', name: 'Alice', picture: null })
    env.DB.all = vi.fn().mockRejectedValue(new Error('D1 unavailable'))
    const res = await apiApp.request('/api/me', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { enabledPlugins?: unknown }
    // The additive-nullish rule: absent field = all catalog plugins enabled.
    expect('enabledPlugins' in body).toBe(false)
  })

  it('/api/stock returns stock list', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.all = vi.fn().mockResolvedValue({ results: [{ id: 's1', name: 'Milk' }] })
    const res = await apiApp.request('/api/stock', {}, env)
    expect(res.status).toBe(200)
  })

  it('/api/home returns dashboard data', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ cnt: 5 })
      .mockResolvedValueOnce({ cnt: 1 })
      .mockResolvedValueOnce({ cnt: 2 })
      .mockResolvedValueOnce({ cnt: 3 })
      .mockResolvedValueOnce({ spend: 1245000, receipts: 8 })
    const res = await apiApp.request('/api/home', {}, env)
    const body = (await res.json()) as any
    expect(body.total_items).toBe(5)
    expect(body.attention_count).toBe(3)
    expect(body.current_month_spend).toBe(1245000)
    expect(body.current_month_receipts).toBe(8)
  })

  it('/api/settings returns settings', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue({
      motion_preference: 'standard',
      language: 'id',
      ai_provider: 'gemini',
      persona_user_role: 'raja',
      persona_ai_role: 'prajurit',
      persona_enabled: 1,
      theme_hue: 230,
      active_household_id: 'h1',
      encrypted_ai_key: ENCRYPTED_KEY,
    })
    const res = await apiApp.request('/api/settings', {}, env)
    expect(res.status).toBe(200)
  })

  it('/api/settings patches settings', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue({
      motion_preference: 'reduced',
      language: 'en',
      ai_provider: 'openai',
      persona_user_role: null,
      persona_ai_role: null,
      persona_enabled: 0,
      theme_hue: null,
      encrypted_ai_key: null,
    })
    const res = await apiApp.request(
      '/api/settings',
      {
        method: 'PATCH',
        body: JSON.stringify({ motion_preference: 'reduced', language: 'en' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
  })

  // #523 P3 (plan §4.3): the payload keeps the household AI block and loses
  // every legacy field together with the columns migration 0042 drops. A fresh
  // household is empty and honestly "none" per capability — no invented
  // provider, no server-default affordance (D8).
  it('/api/settings includes the AI gateway block, all none for a fresh household', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue({
      motion_preference: 'standard',
      active_household_id: 'h1',
    })
    env.DB.all = vi.fn().mockResolvedValue({ results: [] })

    const res = await apiApp.request('/api/settings', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ai_providers).toEqual([])
    expect(body.ai_capabilities).toEqual({
      decision: {
        provider_id: null,
        provider_label: null,
        model: null,
        thinking_level: null,
        source: 'none',
      },
      reasoning: {
        provider_id: null,
        provider_label: null,
        model: null,
        thinking_level: null,
        source: 'none',
      },
      vision: {
        provider_id: null,
        provider_label: null,
        model: null,
        thinking_level: null,
        source: 'none',
      },
    })
    expect(body.ai_status).toEqual({ decision: 'none', reasoning: 'none', vision: 'none' })
  })

  it('/api/settings drops every legacy AI field and the server-default signals', async () => {
    // The six dropped columns plus the two derived signals that only existed to
    // describe them. Removing them is half of P3: a stale client reading
    // `has_ai_key` now gets `undefined` instead of a lie.
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue({ motion_preference: 'standard' })
    env.DB.all = vi.fn().mockResolvedValue({ results: [] })

    const body = (await (await apiApp.request('/api/settings', {}, env)).json()) as any
    for (const field of [
      'ai_provider',
      'ai_base_url',
      'ai_model',
      'ai_vision_model',
      'ai_thinking_level',
      'has_ai_key',
      'server_ai_available',
    ]) {
      expect(body, field).not.toHaveProperty(field)
    }
    // The GET's SELECT must not name a dropped column either.
    const selects = env.DB.prepare.mock.calls.map(([sql]) => String(sql))
    for (const sql of selects) {
      expect(sql).not.toMatch(/\b(ai_provider|encrypted_ai_key|ai_base_url|ai_model)\b/)
    }
  })

  it('/api/settings PATCH rejects every legacy AI field (400, nothing written)', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    for (const payload of [
      { ai_key: 'sk-replacement', ai_provider: 'openai' },
      { ai_model: 'gemini-3.6-flash' },
      { ai_thinking_level: 'high' },
    ]) {
      const res = await apiApp.request(
        '/api/settings',
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
          headers: { 'Content-Type': 'application/json' },
        },
        env
      )
      expect(res.status, JSON.stringify(payload)).toBe(400)
    }
    // No UPDATE reached the database: the strict schema refused before the write.
    expect(env.DB.prepare.mock.calls.some(([sql]) => String(sql).includes('UPDATE'))).toBe(false)
  })

  it('/api/settings serializes the household providers, assignments and resolver status', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue({
      motion_preference: 'standard',
      active_household_id: 'h1',
    })
    // One assigned provider (reasoning + vision) and one unassigned provider:
    // the payload must dedupe the provider and never leak the key.
    env.DB.all = vi.fn().mockResolvedValue({
      results: [
        {
          id: 'p-1',
          label: 'OpenAI (imported)',
          kind: 'openai-compatible',
          preset: 'openai',
          base_url: null,
          default_model: 'gpt-4o-mini',
          encrypted_key: ENCRYPTED_KEY,
          created_at: '2026-10-01 00:00:00',
          updated_at: '2026-10-01 00:00:00',
          capability: 'reasoning',
          model: 'gpt-4o-mini',
          thinking_level: 'low',
        },
        {
          id: 'p-1',
          label: 'OpenAI (imported)',
          kind: 'openai-compatible',
          preset: 'openai',
          base_url: null,
          default_model: 'gpt-4o-mini',
          encrypted_key: ENCRYPTED_KEY,
          created_at: '2026-10-01 00:00:00',
          updated_at: '2026-10-01 00:00:00',
          capability: 'vision',
          model: 'gpt-4o-vision',
          thinking_level: null,
        },
        {
          id: 'p-2',
          label: 'Spare key',
          kind: 'gemini',
          preset: 'gemini',
          base_url: null,
          default_model: null,
          encrypted_key: null,
          created_at: '2026-10-02 00:00:00',
          updated_at: '2026-10-02 00:00:00',
          capability: null,
          model: null,
          thinking_level: null,
        },
      ],
    })

    const res = await apiApp.request('/api/settings', {}, env)
    const body = (await res.json()) as any
    expect(body.ai_providers).toEqual([
      {
        id: 'p-1',
        label: 'OpenAI (imported)',
        kind: 'openai-compatible',
        base_url: null,
        default_model: 'gpt-4o-mini',
        has_key: true,
        created_at: '2026-10-01 00:00:00',
        updated_at: '2026-10-01 00:00:00',
      },
      {
        id: 'p-2',
        label: 'Spare key',
        kind: 'gemini',
        base_url: null,
        default_model: null,
        has_key: false,
        created_at: '2026-10-02 00:00:00',
        updated_at: '2026-10-02 00:00:00',
      },
    ])
    expect(body.ai_capabilities.reasoning).toEqual({
      provider_id: 'p-1',
      provider_label: 'OpenAI (imported)',
      model: 'gpt-4o-mini',
      thinking_level: 'low',
      source: 'household',
    })
    expect(body.ai_capabilities.vision).toMatchObject({
      model: 'gpt-4o-vision',
      thinking_level: null,
      source: 'household',
    })
    expect(body.ai_capabilities.decision.source).toBe('none')
    // The keyed rows are usable; the unassigned provider does not make decision
    // configured.
    expect(body.ai_status).toEqual({
      decision: 'none',
      reasoning: 'household',
      vision: 'household',
    })
    expect(JSON.stringify(body)).not.toContain(ENCRYPTED_KEY)
    expect(JSON.stringify(body.ai_providers)).not.toContain('sk-household')
  })

  it('/api/ai/chat succeeds on the household provider regardless of usage volume (cap removed, #353)', async () => {
    // The daily cap was removed unconditionally: no AI call is ever gated by
    // usage. The call still records an ai_usage_events row (#523 P1: no server
    // key exists to fall back to any more).
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue(aiConfiguredRow())
    env.DB.run = vi.fn().mockResolvedValue(undefined)
    const res = await apiApp.request(
      '/api/ai/chat',
      {
        method: 'POST',
        body: JSON.stringify({ message: 'hello' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
    expect(
      env.DB.prepare.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO ai_usage_events'))
    ).toBe(true)
  })

  it('/api/locations lists locations', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.all = vi.fn().mockResolvedValue({ results: [{ id: 'l1', label: 'Kulkas' }] })
    const res = await apiApp.request('/api/locations', {}, env)
    expect(res.status).toBe(200)
  })

  it('/api/locations creates a location', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ next: 1 })
      .mockResolvedValueOnce({ id: 'l1', label: 'Freezer', sort_order: 2 })
    const res = await apiApp.request(
      '/api/locations',
      {
        method: 'POST',
        body: JSON.stringify({ label: 'Freezer' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(201)
  })

  it('/api/locations/:id deletes when not in use', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValueOnce({ id: 'l1' }).mockResolvedValueOnce({ cnt: 0 })
    const res = await apiApp.request('/api/locations/l1', { method: 'DELETE' }, env)
    expect(res.status).toBe(204)
  })

  it('/api/locations/:id returns 409 when in use', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValueOnce({ id: 'l1' }).mockResolvedValueOnce({ cnt: 3 })
    const res = await apiApp.request('/api/locations/l1', { method: 'DELETE' }, env)
    expect(res.status).toBe(409)
  })

  it('/api/stores lists stores', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.all = vi.fn().mockResolvedValue({ results: [{ id: 's1', label: 'Indomaret' }] })
    const res = await apiApp.request('/api/stores', {}, env)
    expect(res.status).toBe(200)
  })

  it('/api/stores creates a store', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValueOnce({ id: 's1', label: 'Alfamart' })
    const res = await apiApp.request(
      '/api/stores',
      {
        method: 'POST',
        body: JSON.stringify({ label: 'Alfamart' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(201)
  })

  it('/api/stores/:id deletes when not in use', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ id: 's1' })
      .mockResolvedValueOnce({ cnt: 0 })
      .mockResolvedValueOnce({ cnt: 0 })
    const res = await apiApp.request('/api/stores/s1', { method: 'DELETE' }, env)
    expect(res.status).toBe(204)
  })

  // #523 P3: the usage read resolves the household assignment directly (no
  // settings projection any more) and no longer reports `key_source` — every
  // call is household-funded (D9) and the usage row carries `funding`.
  it('/api/ai/usage sums today events with no cap fields (#353)', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    // reasoning resolves first (the bridge's primary), then the separate vision
    // read, then the totals.
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce(aiCapabilityRow())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        used: 4,
        input_tokens: 1200,
        output_tokens: 350,
        cached_tokens: 700,
      })
    const res = await apiApp.request('/api/ai/usage', {}, env)
    const body = (await res.json()) as any
    expect(body).toEqual({
      used: 4,
      input_tokens: 1200,
      output_tokens: 350,
      cached_tokens: 700,
      provider: 'openai',
    })
    expect(body).not.toHaveProperty('key_source')
  })

  it('/api/ai/usage reports zeroed usage when there are no events today (no row creation)', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce(aiCapabilityRow())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
    const res = await apiApp.request('/api/ai/usage', {}, env)
    const body = (await res.json()) as any
    expect(body).toEqual({
      used: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: null,
      provider: 'openai',
    })
    // Read-only: no counter row is inserted anymore.
    expect(env.DB.prepare.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO'))).toBe(
      false
    )
  })

  it('/api/ai/usage reports the household provider, and no settings row is read to find it', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce(aiCapabilityRow())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
    const res = await apiApp.request('/api/ai/usage', {}, env)
    const body = (await res.json()) as any
    // The legacy dispatcher id, as before the swap (the preset, not the wire).
    expect(body.provider).toBe('openai')
    // P3 deleted the projection: the route must not SELECT from user_settings at
    // all — the middleware's household id is the only source.
    const sqls = env.DB.prepare.mock.calls.map(([sql]) => String(sql))
    expect(sqls.some((sql) => /FROM\s+user_settings/i.test(sql))).toBe(false)
  })

  describe('/api/admin/ai/usage', () => {
    it('returns 403 for non-admin users', async () => {
      const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
      env.DB.first = vi.fn().mockResolvedValue({ is_admin: 0 })
      const res = await apiApp.request('/api/admin/ai/usage?range=24h', {}, env)
      expect(res.status).toBe(403)
    })

    it('returns 400 on an unknown or missing range', async () => {
      for (const query of ['?range=90d', '?range=24hours', '']) {
        const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
        env.DB.first = vi.fn().mockResolvedValue({ is_admin: 1 })
        const res = await apiApp.request(`/api/admin/ai/usage${query}`, {}, env)
        expect(res.status).toBe(400)
      }
    })

    it('serves each documented range with totals and per-user rows', async () => {
      for (const range of ['24h', '7d', '30d']) {
        const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
        env.DB.first = vi.fn().mockResolvedValueOnce({ is_admin: 1 }).mockResolvedValueOnce({
          calls: 12,
          input_tokens: 3400,
          output_tokens: 900,
          cached_tokens: 2100,
        })
        env.DB.all = vi.fn().mockResolvedValue({
          results: [
            {
              user_id: 'u2',
              email: 'b@c.com',
              calls: 7,
              input_tokens: 2000,
              output_tokens: 500,
              cached_tokens: 1500,
              last_used: '2026-11-01T02:00:00.000Z',
            },
            {
              user_id: 'u3',
              email: null,
              calls: 5,
              input_tokens: 1400,
              output_tokens: 400,
              cached_tokens: null,
              last_used: '2026-10-30T01:00:00.000Z',
            },
          ],
        })
        const res = await apiApp.request(`/api/admin/ai/usage?range=${range}`, {}, env)
        expect(res.status).toBe(200)
        const body = (await res.json()) as any
        expect(body.range).toBe(range)
        expect(new Date(body.since).toISOString()).toBe(body.since)
        expect(body.totals).toEqual({
          calls: 12,
          input_tokens: 3400,
          output_tokens: 900,
          cached_tokens: 2100,
          cache_hit_rate: 2100 / 3400,
        })
        // Reported cache → the rate; unreported cache → null, never 0.
        expect(body.users[0]).toEqual({
          user_id: 'u2',
          email: 'b@c.com',
          calls: 7,
          input_tokens: 2000,
          output_tokens: 500,
          cached_tokens: 1500,
          cache_hit_rate: 1500 / 2000,
          last_used: '2026-11-01T02:00:00.000Z',
        })
        expect(body.users[1].cache_hit_rate).toBeNull()
        expect(body.users[1].email).toBeNull()
      }
    })

    it('returns zeroed totals with null cache_hit_rate and no users when the range is empty', async () => {
      const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
      env.DB.first = vi.fn().mockResolvedValueOnce({ is_admin: 1 }).mockResolvedValueOnce(null)
      env.DB.all = vi.fn().mockResolvedValue({ results: [] })
      const res = await apiApp.request('/api/admin/ai/usage?range=24h', {}, env)
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.totals).toEqual({
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: null,
        cache_hit_rate: null,
      })
      expect(body.users).toEqual([])
    })

    it('returns 401 without auth props', async () => {
      const env = createMockEnv()
      const res = await apiApp.request('/api/admin/ai/usage?range=24h', {}, env)
      expect(res.status).toBe(401)
    })
  })

  it('/api/ai/chat returns TEST_MODE reply', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue(aiConfiguredRow())
    env.DB.all = vi.fn().mockResolvedValue({ results: [] })
    env.DB.run = vi.fn().mockResolvedValue(undefined)
    const res = await apiApp.request(
      '/api/ai/chat',
      {
        method: 'POST',
        body: JSON.stringify({ message: 'hello' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).reply).toContain('test')
  })

  it('/api/ai/chat returns 402 when AI not configured', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    // A settings row with a household but no assignment: empty means empty.
    env.DB.first = vi.fn().mockResolvedValue({ household_id: 'h1' })
    const res = await apiApp.request(
      '/api/ai/chat',
      {
        method: 'POST',
        body: JSON.stringify({ message: 'hi' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(402)
  })

  it('/api/ai/chat never caps household users (no usage gate, #353)', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue(aiConfiguredRow())
    env.DB.run = vi.fn().mockResolvedValue(undefined)
    const res = await apiApp.request(
      '/api/ai/chat',
      {
        method: 'POST',
        body: JSON.stringify({ message: 'hi' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).reply).toContain('test')
  })

  it('/api/ai/chat lets household-key users chat with usage recorded as an event', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue(aiConfiguredRow())
    env.DB.run = vi.fn().mockResolvedValue(undefined)
    const res = await apiApp.request(
      '/api/ai/chat',
      {
        method: 'POST',
        body: JSON.stringify({ message: 'hi' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).reply).toContain('test')
    expect(
      env.DB.prepare.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO ai_usage_events'))
    ).toBe(true)
  })

  it('/api/purchases/scan uses TEST_MODE fallback', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue(aiConfiguredRow())
    env.DB.run = vi.fn().mockResolvedValue(undefined)
    const file = new File(['x'], 'receipt.jpg', { type: 'image/jpeg' })
    const formData = new FormData()
    formData.append('image', file)
    const res = await apiApp.request('/api/purchases/scan', { method: 'POST', body: formData }, env)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).items.length).toBeGreaterThan(0)
  })

  it('/api/purchases/scan meters provider tokens on the error path', async () => {
    const env = createMockEnv({
      props: { userId: 'u1', householdId: 'h1' },
      TEST_MODE: 'false',
    })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce(aiConfiguredRow())
      .mockResolvedValueOnce(aiCapabilityRow({ preset: 'ollama', provider_id: 'p-ollama' }))
    env.DB.run = vi.fn().mockResolvedValue(undefined)
    // Provider responds with usage but empty content: the key owner is billed
    // for the input tokens even though the scan fails.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    })
    const file = new File(['x'], 'receipt.jpg', { type: 'image/jpeg' })
    const formData = new FormData()
    formData.append('image', file)
    const res = await apiApp.request('/api/purchases/scan', { method: 'POST', body: formData }, env)
    expect(res.status).toBe(502)
    // The failed call still records its event with the billed tokens.
    expect(
      env.DB.prepare.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO ai_usage_events'))
    ).toBe(true)
    expect(env.DB.bind.mock.calls.flat()).toEqual(expect.arrayContaining([100, 50, null, 'u1']))
  })

  it('/api/purchases/scan rejects missing image', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    const res = await apiApp.request(
      '/api/purchases/scan',
      { method: 'POST', headers: { 'Content-Type': 'multipart/form-data' } },
      env
    )
    expect(res.status).toBe(400)
  })

  it('/api/purchases/scan rejects missing AI config', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue({ household_id: 'h1' })
    const file = new File(['x'], 'receipt.jpg', { type: 'image/jpeg' })
    const formData = new FormData()
    formData.append('image', file)
    const res = await apiApp.request('/api/purchases/scan', { method: 'POST', body: formData }, env)
    expect(res.status).toBe(402)
  })

  it('/api/purchases creates a purchase', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ id: 's1' })
      .mockResolvedValueOnce({ id: 'loc1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'p1', store_id: 's1', date: '2026-07-26' })
    const res = await apiApp.request(
      '/api/purchases',
      {
        method: 'POST',
        body: JSON.stringify({
          store_id: 's1',
          date: '2026-07-26',
          items: [{ name: 'Milk', qty: 1, unit: 'L', price: 18500 }],
        }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(201)
  })

  it('/api/purchases returns 400 for invalid store', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue(null)
    const res = await apiApp.request(
      '/api/purchases',
      {
        method: 'POST',
        body: JSON.stringify({
          store_id: 'missing',
          date: '2026-07-26',
          items: [{ name: 'Milk', qty: 1, unit: 'L', price: 18500 }],
        }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(400)
  })

  it('/api/purchases lists purchases', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.all = vi
      .fn()
      .mockResolvedValueOnce({ results: [{ id: 'p1', date: '2026-07-26', created_at: 'x' }] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] })
    const res = await apiApp.request('/api/purchases', {}, env)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).purchases).toHaveLength(1)
  })

  it('/api/purchases accepts ?limit=N as a digit string (regression: Hono sends strings)', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.all = vi
      .fn()
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] })
    // The browser client sends limit as a string (query params have no types on
    // the wire) — it must coerce, not 400.
    const res = await apiApp.request('/api/purchases?limit=10', {}, env)
    expect(res.status).toBe(200)
    const bad = await apiApp.request('/api/purchases?limit=0', {}, env)
    expect(bad.status).toBe(400)
  })

  it('/api/purchases/:id returns a purchase', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ id: 'p1', store_id: null, date: '2026-07-26', total: 100 })
    env.DB.all = vi.fn().mockResolvedValueOnce({ results: [] })
    const res = await apiApp.request('/api/purchases/p1', {}, env)
    expect(res.status).toBe(200)
  })

  it('/api/purchases/:id/receipt streams image', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue({ receipt_image_key: 'receipts/h1/u1/key.jpg' })
    env.RECEIPTS.get = vi.fn().mockResolvedValue({
      blob: async () => new Blob(['x'], { type: 'image/jpeg' }),
      httpMetadata: { contentType: 'image/jpeg' },
    })
    const res = await apiApp.request('/api/purchases/p1/receipt', {}, env)
    expect(res.status).toBe(200)
  })

  it('/api/purchases/:id/receipt returns 404 when no key', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue({ receipt_image_key: null })
    const res = await apiApp.request('/api/purchases/p1/receipt', {}, env)
    expect(res.status).toBe(404)
  })

  it('/api/stock/:id updates stock', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({
        id: 's1',
        item_id: 'i1',
        qty: 2,
        unit: 'L',
        location_id: null,
        expiry_date: null,
        item_name: 'Milk',
      })
      .mockResolvedValueOnce({ id: 'loc1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 's1', name: 'Milk', qty: 3 })
    env.DB.run = vi.fn().mockResolvedValue(undefined)
    const res = await apiApp.request(
      '/api/stock/s1',
      {
        method: 'PATCH',
        body: JSON.stringify({ qty: 3, location_id: 'loc1', name: 'Milk' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
  })

  it('/api/stock/:id returns 404 when not found', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue(null)
    const res = await apiApp.request(
      '/api/stock/missing',
      {
        method: 'PATCH',
        body: JSON.stringify({ qty: 1 }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(404)
  })

  it('/api/plans/generate uses TEST_MODE fallback', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue(aiConfiguredRow({ currency: 'IDR' }))
    env.DB.all = vi.fn().mockResolvedValue({ results: [{ id: 's1', label: 'Indomaret' }] })
    const res = await apiApp.request('/api/plans/generate', { method: 'POST' }, env)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).items.length).toBeGreaterThan(0)
  })

  it('/api/plans/generate returns 402 when AI not configured', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue({ household_id: 'h1', currency: 'IDR' })
    const res = await apiApp.request('/api/plans/generate', { method: 'POST' }, env)
    expect(res.status).toBe(402)
  })

  it('/api/plans saves an active plan', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 's1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'pl1' })
    env.DB.all = vi.fn().mockResolvedValueOnce({ results: [] })
    const res = await apiApp.request(
      '/api/plans',
      {
        method: 'POST',
        body: JSON.stringify({
          items: [
            { name: 'Milk', qty: 1, unit: 'L', store_id: 's1', price_estimate: 18500, why: 'low' },
          ],
        }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(201)
  })

  // Capturing fake DB for the POST /api/plans route: records every prepared
  // statement's SQL and bound params so the plan_items INSERT payload can be
  // asserted. Bind order mirrors the route: (id, plan_id, item_id, store_id,
  // qty, unit, price_estimate, why, price_observation_id, created_at).
  function createCapturingPlansEnv(firstQueue: unknown[]) {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    const prepared: Array<{ sql: string; params: unknown[] }> = []
    env.DB.prepare = vi.fn((sql: string) => {
      const stmt: { sql: string; params: unknown[]; first: unknown; all: unknown; run: unknown } = {
        sql,
        params: [],
        first: env.DB.first,
        all: env.DB.all,
        run: env.DB.run,
      }
      prepared.push(stmt)
      return {
        bind: (...params: unknown[]) => {
          stmt.params = params
          return stmt
        },
      }
    }) as never
    env.DB.first = vi.fn()
    for (const value of firstQueue) env.DB.first.mockResolvedValueOnce(value)
    env.DB.all = vi.fn().mockResolvedValue({ results: [] })
    env.DB.batch = vi.fn(async (statements: Array<{ sql: string; params: unknown[] }>) => {
      prepared.push(...statements)
      return []
    })
    return { env, prepared }
  }

  it('/api/plans keeps a grounded price_observation_id that exists', async () => {
    const { env, prepared } = createCapturingPlansEnv([
      null, // no existing active plan
      { id: 'obs-1' }, // price_observations lookup hits
      null, // items lookup misses
      { id: 'pl1', household_id: 'h1', status: 'active' }, // plan re-read
    ])
    const res = await apiApp.request(
      '/api/plans',
      {
        method: 'POST',
        body: JSON.stringify({
          items: [{ name: 'Milk', qty: 1, unit: 'L', price_observation_id: 'obs-1' }],
        }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(201)
    const lookup = prepared.find((s) => s.sql.includes('SELECT id FROM price_observations'))
    expect(lookup?.params).toEqual(['obs-1'])
    const insert = prepared.find((s) => s.sql.includes('INSERT INTO plan_items'))
    expect(insert).toBeDefined()
    expect(insert!.params[8]).toBe('obs-1')
  })

  it('/api/plans nulls a bogus price_observation_id and still saves the plan', async () => {
    const { env, prepared } = createCapturingPlansEnv([
      null, // no existing active plan
      null, // price_observations lookup misses
      null, // items lookup misses
      { id: 'pl1', household_id: 'h1', status: 'active' }, // plan re-read
    ])
    const res = await apiApp.request(
      '/api/plans',
      {
        method: 'POST',
        body: JSON.stringify({
          items: [{ name: 'Milk', qty: 1, unit: 'L', price_observation_id: 'obs-bogus' }],
        }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(201)
    const lookup = prepared.find((s) => s.sql.includes('SELECT id FROM price_observations'))
    expect(lookup?.params).toEqual(['obs-bogus'])
    const insert = prepared.find((s) => s.sql.includes('INSERT INTO plan_items'))
    expect(insert).toBeDefined()
    expect(insert!.params[8]).toBeNull()
  })

  it('/api/plans accepts an explicit null price_observation_id (ungrounded item)', async () => {
    // The browser client sends null for ungrounded items; the schema must not
    // reject it, and no observation lookup should run for null.
    const { env, prepared } = createCapturingPlansEnv([
      null, // no existing active plan
      null, // items lookup misses
      { id: 'pl1', household_id: 'h1', status: 'active' }, // plan re-read
    ])
    const res = await apiApp.request(
      '/api/plans',
      {
        method: 'POST',
        body: JSON.stringify({
          items: [{ name: 'Milk', qty: 1, unit: 'L', price_observation_id: null }],
        }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(201)
    expect(
      prepared.find((s) => s.sql.includes('SELECT id FROM price_observations'))
    ).toBeUndefined()
    const insert = prepared.find((s) => s.sql.includes('INSERT INTO plan_items'))
    expect(insert).toBeDefined()
    expect(insert!.params[8]).toBeNull()
  })

  it('/api/plans/:id/items/:itemId updates item status', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pl1', status: 'active' })
      .mockResolvedValueOnce({ id: 'pi1', item_id: 'i1', qty: 1, unit: 'L', status: 'pending' })
      .mockResolvedValueOnce({ id: 'loc1' })
      .mockResolvedValueOnce(null)
    env.DB.all = vi.fn().mockResolvedValueOnce({ results: [] })
    const res = await apiApp.request(
      '/api/plans/pl1/items/pi1',
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'bought' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
  })

  it('/api/purchases/patterns returns patterns', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.all = vi.fn().mockResolvedValueOnce({ results: [] })
    const res = await apiApp.request('/api/purchases/patterns', {}, env)
    expect(res.status).toBe(200)
  })
})

describe('api routes edge cases', () => {
  it('returns 429 when rate limit exceeded', async () => {
    const env = createMockEnv({ RATE_LIMIT_WINDOW_MS: '1000', RATE_LIMIT_MAX_REQUESTS: '1' })
    await apiApp.request('/api/health', {}, env)
    const res = await apiApp.request('/api/health', {}, env)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
  })

  it('notFound falls back to ASSETS fetcher', async () => {
    const env = createMockEnv({
      ASSETS: { fetch: vi.fn().mockResolvedValue(new Response('asset')) },
    })
    const res = await apiApp.request('/unknown', {}, env)
    expect(await res.text()).toBe('asset')
  })

  it('unmatched /api path answers typed JSON 404, never the SPA shell (QA-F1)', async () => {
    const assets = { fetch: vi.fn().mockResolvedValue(new Response('<html>shell</html>')) }
    const env = createMockEnv({ ASSETS: assets })
    for (const path of ['/api/definitely-not-a-route', '/api/', '/api']) {
      const res = await apiApp.request(path, {}, env)
      expect(res.status, path).toBe(404)
      expect(res.headers.get('content-type'), path).toContain('application/json')
      expect(res.headers.get('cache-control'), path).toBe('private, no-cache')
      expect(await res.json(), path).toEqual({ error: 'Not found' })
    }
    expect(assets.fetch).not.toHaveBeenCalled()
  })

  it('bare /api goes through the GATEWAY to the JSON 404 — runWorkerFirst glob trap (QF-A1)', async () => {
    // The apiApp-level test above cannot catch the QF-A1 drift: bare `/api`
    // never reached apiApp at all (gateway dispatched on startsWith('/api/')
    // and the runWorkerFirst glob ['/api/*'] doesn't match the bare path), so
    // production answered the SPA shell while this app-level pin stayed
    // green. Drive the gateway itself, with an ASSETS fetcher that fails the
    // test if it is ever reached.
    const { gateway } = await import('../gateway.js')
    const assets = { fetch: vi.fn().mockResolvedValue(new Response('<html>shell</html>')) }
    const env = createMockEnv({ ASSETS: assets })
    const dispatchCtx = { waitUntil: vi.fn() }
    for (const path of ['/api', '/api/definitely-not-a-route']) {
      const res = await gateway.fetch(
        new Request(`https://rumaq.test${path}`),
        env as unknown as Parameters<typeof gateway.fetch>[1],
        dispatchCtx as unknown as Parameters<typeof gateway.fetch>[2]
      )
      expect(res.status, path).toBe(404)
      expect(res.headers.get('content-type'), path).toContain('application/json')
      expect(await res.json(), path).toEqual({ error: 'Not found' })
    }
    expect(assets.fetch).not.toHaveBeenCalled()
  })

  it('notFound returns 404 without ASSETS', async () => {
    const env = createMockEnv()
    const res = await apiApp.request('/unknown', {}, env)
    expect(res.status).toBe(404)
  })

  it('/api/purchases/scan rejects non-multipart content type', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    const res = await apiApp.request(
      '/api/purchases/scan',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      env
    )
    expect(res.status).toBe(400)
  })

  it('/api/purchases/scan rejects oversized image', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValue({ ai_provider: 'gemini', encrypted_ai_key: ENCRYPTED_KEY })
    const file = new File(['x'.repeat(6 * 1024 * 1024)], 'receipt.jpg', { type: 'image/jpeg' })
    const formData = new FormData()
    formData.append('image', file)
    const res = await apiApp.request('/api/purchases/scan', { method: 'POST', body: formData }, env)
    expect(res.status).toBe(400)
  })

  it('/api/settings returns 400 on invalid body', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    const res = await apiApp.request(
      '/api/settings',
      {
        method: 'PATCH',
        body: JSON.stringify({ ai_provider: 'invalid-provider' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(400)
  })

  it('/api/plans/:id/items/:itemId completes plan when all resolved', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pl1', status: 'active' })
      .mockResolvedValueOnce({ id: 'pi1', item_id: 'i1', qty: 1, unit: 'L', status: 'pending' })
      .mockResolvedValueOnce({ id: 'loc1' })
      .mockResolvedValueOnce(null)
    env.DB.all = vi.fn().mockResolvedValueOnce({ results: [{ status: 'bought' }] })
    const res = await apiApp.request(
      '/api/plans/pl1/items/pi1',
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'bought' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
  })

  it('/api/plans/:id/items/:itemId returns 404 when plan missing', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue(null)
    const res = await apiApp.request(
      '/api/plans/pl1/items/pi1',
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'bought' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(404)
  })

  it('/api/plans/:id/items/:itemId returns 400 when plan not active', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pl1', status: 'archived' })
      .mockResolvedValueOnce({ id: 'pi1', item_id: 'i1', qty: 1, unit: 'L', status: 'pending' })
    const res = await apiApp.request(
      '/api/plans/pl1/items/pi1',
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'bought' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(400)
  })
})

describe('api routes more branches', () => {
  it('/api/plans/:id/items/:itemId bought updates existing stock', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pl1', status: 'active' })
      .mockResolvedValueOnce({
        id: 'pi1',
        item_id: 'i1',
        qty: 1,
        unit: 'L',
        status: 'pending',
        price_estimate: 1000,
      })
      .mockResolvedValueOnce({ id: 'loc1' })
      .mockResolvedValueOnce({ id: 's1', qty: 2 })
      .mockResolvedValueOnce({ id: 'pi1', item_name: 'Milk' })
      .mockResolvedValueOnce({ id: 'pl1', status: 'completed' })
    env.DB.all = vi.fn().mockResolvedValue({ results: [] })
    const res = await apiApp.request(
      '/api/plans/pl1/items/pi1',
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'bought' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
  })

  it('/api/plans/:id/items/:itemId skipped completes plan', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pl1', status: 'active' })
      .mockResolvedValueOnce({ id: 'pi1', item_id: 'i1', qty: 1, unit: 'L', status: 'pending' })
    env.DB.all = vi.fn().mockResolvedValueOnce({ results: [{ status: 'skipped' }] })
    const res = await apiApp.request(
      '/api/plans/pl1/items/pi1',
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'skipped' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
  })

  it('/api/plans/:id/items/:itemId returns 500 on batch error', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pl1', status: 'active' })
      .mockResolvedValueOnce({ id: 'pi1', item_id: 'i1', qty: 1, unit: 'L', status: 'pending' })
    env.DB.all = vi.fn().mockResolvedValueOnce({ results: [{ status: 'pending' }] })
    env.DB.batch = vi.fn().mockRejectedValue(new Error('DB fail'))
    const res = await apiApp.request(
      '/api/plans/pl1/items/pi1',
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'bought' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(500)
  })

  it('/api/purchases filters by store, date, q and cursor', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.all = vi
      .fn()
      .mockResolvedValueOnce({ results: [{ id: 'p1', date: '2026-07-26', created_at: 'x' }] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [{ month: '2026-07', total: 100 }] })
    const res = await apiApp.request(
      '/api/purchases?store=s1&from=2026-07-01&to=2026-07-31&q=milk&cursor=2026-07-26|x',
      {},
      env
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).avg_per_month).toBe(100)
  })

  it('/api/purchases returns empty month totals when none', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.all = vi
      .fn()
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] })
    const res = await apiApp.request('/api/purchases', {}, env)
    expect(((await res.json()) as any).avg_per_month).toBe(0)
  })

  it('/api/purchases/scan rejects invalid image type', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValue({ ai_provider: 'gemini', encrypted_ai_key: ENCRYPTED_KEY })
    const file = new File(['x'], 'receipt.gif', { type: 'image/gif' })
    const formData = new FormData()
    formData.append('image', file)
    const res = await apiApp.request('/api/purchases/scan', { method: 'POST', body: formData }, env)
    expect(res.status).toBe(400)
  })
})

describe('api routes remaining branches', () => {
  it('/api/plans/generate matches existing items', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue(aiConfiguredRow({ currency: 'IDR' }))
    env.DB.all = vi.fn().mockResolvedValue({ results: [{ id: 's1', label: 'Indomaret' }] })
    const res = await apiApp.request('/api/plans/generate', { method: 'POST' }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ matched_item_name: string | null }> }
    expect(body.items[0].matched_item_name).toBeNull()
  })

  it('/api/plans/save matches and creates items', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 's1' })
      .mockResolvedValueOnce({ id: 'i1' })
      .mockResolvedValueOnce({ id: 'pl1' })
    env.DB.all = vi.fn().mockResolvedValueOnce({ results: [] })
    const res = await apiApp.request(
      '/api/plans',
      {
        method: 'POST',
        body: JSON.stringify({
          items: [
            { name: 'Milk', qty: 1, unit: 'L', store_id: 's1', price_estimate: 18500, why: 'low' },
          ],
        }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(201)
  })

  it('/api/plans/save returns 500 on batch error', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 's1' })
      .mockResolvedValueOnce(null)
    env.DB.batch = vi.fn().mockRejectedValue(new Error('DB fail'))
    const res = await apiApp.request(
      '/api/plans',
      {
        method: 'POST',
        body: JSON.stringify({
          items: [
            { name: 'Milk', qty: 1, unit: 'L', store_id: 's1', price_estimate: 18500, why: 'low' },
          ],
        }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(500)
  })

  it('/api/plans/:id/items/:itemId returns 404 when item not found', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pl1', status: 'active' })
      .mockResolvedValueOnce(null)
    const res = await apiApp.request(
      '/api/plans/pl1/items/missing',
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'bought' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(404)
  })
})

// Canonical product admin (#423). These pin the HTTP surface — auth chain,
// valibot bodies, and the typed-error → status/code mapping — by driving the
// REAL lib over sequenced fake-DB reads. The write semantics (guarded batch,
// alias approval, audit, index bumps) are pinned on real SQLite in
// canonical-products.test.ts.
describe('/api/admin/products', () => {
  // The shared in-memory limiter counts every request in this file under the
  // 'unknown' IP; lift the ceiling for this block so the auth/mapping matrix
  // cannot 429 after the rest of the suite's traffic.
  function productEnv(overrides: Record<string, unknown> = {}) {
    return createMockEnv({
      props: { userId: 'u1', householdId: 'h1' },
      RATE_LIMIT_MAX_REQUESTS: '10000',
      ...overrides,
    })
  }
  const NOW = '2026-11-07T00:00:00.000Z'

  function productRow(over: Record<string, unknown> = {}) {
    return {
      id: 'prod-1',
      product_key: 'beras--ramos--5-kg',
      name: 'Beras Ramos 5 kg',
      brand: null,
      unit: '5 kg',
      status: 'provisional',
      metadata_version: 1,
      first_seen_at: NOW,
      last_seen_at: NOW,
      updated_at: NOW,
      ...over,
    }
  }

  function auditRow(over: Record<string, unknown> = {}) {
    return {
      id: 'audit-1',
      product_id: 'prod-1',
      product_key: 'beras--ramos--5-kg',
      actor_user_id: 'u1',
      action: 'rename',
      old_name: 'Beras Lama',
      new_name: 'Beras Ramos 5 kg',
      reason: null,
      metadata_version_before: 1,
      metadata_version_after: 2,
      reverts_audit_id: null,
      created_at: NOW,
      ...over,
    }
  }

  function renameRequest(body: unknown) {
    return {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }
  }

  function revertRequest(body: unknown = {}) {
    return {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }
  }

  const PRODUCT_PATH = '/api/admin/products/beras--ramos--5-kg'
  // The static report path (#485) — registered before the :productKey route.
  const DUPLICATES_PATH = '/api/admin/products/duplicates'
  const RENAME_PATH = `${PRODUCT_PATH}/rename`
  const REVERT_PATH = `${PRODUCT_PATH}/audit/audit-1/revert`
  const APPROVE_PATH = `${PRODUCT_PATH}/aliases/alias-1/approve`
  const REJECT_PATH = `${PRODUCT_PATH}/aliases/alias-1/reject`
  // The bulk exact-name approval (#515) is a static catalog-wide path, not a
  // product leaf — but it must ride the same admin chain.
  const ALIAS_CANDIDATES_PATH = '/api/admin/products/aliases/candidates'
  const ALIAS_BULK_APPROVE_PATH = '/api/admin/products/aliases/bulk-approve'

  it('returns 401 without a session on every product admin route', async () => {
    const env = productEnv({ props: undefined })
    const calls: Array<[string, string, RequestInit]> = [
      ['GET', PRODUCT_PATH, {}],
      ['GET', DUPLICATES_PATH, {}],
      ['POST', RENAME_PATH, renameRequest({ canonicalName: 'X', expectedMetadataVersion: 1 })],
      ['POST', REVERT_PATH, revertRequest()],
      ['POST', APPROVE_PATH, {}],
      ['POST', REJECT_PATH, {}],
      ['GET', ALIAS_CANDIDATES_PATH, {}],
      ['POST', ALIAS_BULK_APPROVE_PATH, {}],
    ]
    for (const [method, path, init] of calls) {
      const res = await apiApp.request(path, { method, ...init }, env)
      expect(res.status).toBe(401)
    }
  })

  it('returns 403 for non-admin users on every product admin route', async () => {
    const env = productEnv()
    env.DB.first = vi.fn().mockResolvedValue({ is_admin: 0 })
    const calls: Array<[string, string, RequestInit]> = [
      ['GET', PRODUCT_PATH, {}],
      ['GET', DUPLICATES_PATH, {}],
      ['POST', RENAME_PATH, renameRequest({ canonicalName: 'X', expectedMetadataVersion: 1 })],
      ['POST', REVERT_PATH, revertRequest()],
      ['POST', APPROVE_PATH, {}],
      ['POST', REJECT_PATH, {}],
      ['GET', ALIAS_CANDIDATES_PATH, {}],
      ['POST', ALIAS_BULK_APPROVE_PATH, {}],
    ]
    for (const [method, path, init] of calls) {
      const res = await apiApp.request(path, { method, ...init }, env)
      expect(res.status).toBe(403)
    }
  })

  it('serves the read-only duplicate-name report with private no-cache headers', async () => {
    const env = productEnv()
    env.DB.first = vi.fn().mockResolvedValue({ is_admin: 1 })
    env.DB.all = vi
      .fn()
      .mockResolvedValueOnce({
        // The lib's group row carries the SQL-derived key (lower(name)) — the
        // same key the product rows below carry.
        results: [{ normalizedName: 'beras ramos 5 kg', productCount: 2 }],
      })
      .mockResolvedValueOnce({
        results: [
          {
            product_key: 'beras--ramos--5-kg--copy',
            name: 'beras ramos 5 kg',
            status: 'provisional',
            updated_at: NOW,
            groupKey: 'beras ramos 5 kg',
          },
          {
            product_key: 'beras--ramos--5-kg',
            name: 'Beras Ramos 5 kg',
            status: 'provisional',
            updated_at: NOW,
            groupKey: 'beras ramos 5 kg',
          },
        ],
      })
      .mockResolvedValueOnce({
        results: [
          { productKey: 'beras--ramos--5-kg', storeSlug: 'superindo', lastSeenAt: NOW },
          {
            productKey: 'beras--ramos--5-kg',
            storeSlug: 'lotte-mart',
            lastSeenAt: '2026-11-08T00:00:00.000Z',
          },
        ],
      })

    const res = await apiApp.request(DUPLICATES_PATH, {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toMatch(/private, no-cache/)
    // The static path wins over /api/admin/products/:productKey: the body is
    // the report, not a product identity for a product named 'duplicates'.
    expect(await res.json()).toEqual({
      limit: 200,
      truncated: false,
      groups: [
        {
          normalizedName: 'beras ramos 5 kg',
          displayName: 'beras ramos 5 kg',
          productCount: 2,
          products: [
            {
              productKey: 'beras--ramos--5-kg--copy',
              name: 'beras ramos 5 kg',
              status: 'provisional',
              updatedAt: NOW,
              stores: [],
              primaryStore: null,
            },
            {
              productKey: 'beras--ramos--5-kg',
              name: 'Beras Ramos 5 kg',
              status: 'provisional',
              updatedAt: NOW,
              stores: ['lotte-mart', 'superindo'],
              primaryStore: 'lotte-mart',
            },
          ],
        },
      ],
    })
    // The identity route (the one this static path must shadow) reads through
    // db.batch; a report that never batches is the report handler. The
    // read-only guarantee itself is pinned on real SQLite.
    expect(env.DB.batch).not.toHaveBeenCalled()
  })

  it('rejects a non-numeric or out-of-range duplicate-report limit with 400', async () => {
    for (const limit of ['0', 'abc', '501']) {
      const env = productEnv()
      env.DB.first = vi.fn().mockResolvedValue({ is_admin: 1 })
      const res = await apiApp.request(`${DUPLICATES_PATH}?limit=${limit}`, {}, env)
      expect(res.status).toBe(400)
      expect(env.DB.all).not.toHaveBeenCalled()
    }
  })

  it('returns 400 for a rename body missing the required fields', async () => {
    const env = productEnv()
    env.DB.first = vi.fn().mockResolvedValue({ is_admin: 1 })
    const res = await apiApp.request(RENAME_PATH, renameRequest({}), env)
    expect(res.status).toBe(400)
  })

  it('returns 400 for a blank, oversize, or control-character canonical name', async () => {
    for (const canonicalName of ['   ', 'x'.repeat(501), 'Beras\nRamos']) {
      const env = productEnv()
      env.DB.first = vi.fn().mockResolvedValue({ is_admin: 1 })
      const res = await apiApp.request(
        RENAME_PATH,
        renameRequest({ canonicalName, expectedMetadataVersion: 1 }),
        env
      )
      expect(res.status).toBe(400)
      if (canonicalName === '   ') {
        const body = (await res.json()) as { error: string }
        expect(body.error).toMatch(/blank/i)
      }
    }
  })

  it('returns 400 for an oversize or newline-carrying revert reason', async () => {
    for (const reason of ['x'.repeat(201), 'bad\nreason']) {
      const env = productEnv()
      env.DB.first = vi.fn().mockResolvedValue({ is_admin: 1 })
      const res = await apiApp.request(REVERT_PATH, revertRequest({ reason }), env)
      expect(res.status).toBe(400)
    }
  })

  it('serves the product identity payload with private no-cache headers', async () => {
    const env = productEnv()
    env.DB.first = vi.fn().mockResolvedValue({ is_admin: 1 })
    env.DB.batch = vi.fn().mockResolvedValue([
      { results: [productRow()] },
      {
        results: [
          {
            id: 'alias-1',
            name: 'Beras Ramos',
            store_slug: 'superindo',
            status: 'candidate',
            source: 'ocr',
            first_seen_at: NOW,
            last_seen_at: NOW,
          },
        ],
      },
      { results: [{ observations: 3, stores: 2 }] },
      { results: [auditRow()] },
    ])

    const res = await apiApp.request(PRODUCT_PATH, {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toMatch(/private, no-cache/)
    const body = (await res.json()) as any
    expect(body.product).toMatchObject({
      id: 'prod-1',
      productKey: 'beras--ramos--5-kg',
      name: 'Beras Ramos 5 kg',
      status: 'provisional',
      metadataVersion: 1,
    })
    expect(body.aliases).toEqual([
      {
        id: 'alias-1',
        name: 'Beras Ramos',
        storeSlug: 'superindo',
        status: 'candidate',
        source: 'ocr',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ])
    expect(body.stats).toEqual({ observations: 3, stores: 2 })
    expect(body.audit).toEqual([
      expect.objectContaining({
        id: 'audit-1',
        action: 'rename',
        oldName: 'Beras Lama',
        metadataVersionBefore: 1,
        metadataVersionAfter: 2,
      }),
    ])
  })

  it('returns 404 for an unknown product identity', async () => {
    const env = productEnv()
    env.DB.first = vi.fn().mockResolvedValue({ is_admin: 1 })
    env.DB.batch = vi.fn().mockResolvedValue([])
    const res = await apiApp.request(PRODUCT_PATH, {}, env)
    expect(res.status).toBe(404)
  })

  it('renames through the HTTP layer and returns {product, warnings, audit, indexVersion}', async () => {
    const env = productEnv()
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ is_admin: 1 })
      .mockResolvedValueOnce(productRow())
    env.DB.all = vi
      .fn()
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] })
    env.DB.batch = vi
      .fn()
      .mockResolvedValueOnce([
        { meta: { changes: 1 } },
        { meta: { changes: 2 } },
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
      ])
      .mockResolvedValueOnce([
        { results: [productRow({ name: 'Beras Ramos Premium', metadata_version: 2 })] },
        {
          results: [
            auditRow({ new_name: 'Beras Ramos Premium', metadata_version_after: 2, reason: 'fix' }),
          ],
        },
        { results: [{ version: 1 }] },
      ])

    const res = await apiApp.request(
      RENAME_PATH,
      renameRequest({
        canonicalName: 'Beras Ramos Premium',
        expectedMetadataVersion: 1,
        reason: 'fix',
      }),
      env
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toMatch(/private, no-cache/)
    const body = (await res.json()) as any
    expect(body.product).toMatchObject({ name: 'Beras Ramos Premium', metadataVersion: 2 })
    expect(body.warnings).toEqual([])
    expect(body.indexVersion).toBe(1)
    expect(body.audit).toHaveLength(1)
    expect(body.audit[0]).toMatchObject({ action: 'rename', reason: 'fix' })
    expect(env.DB.batch).toHaveBeenCalledTimes(2)
  })

  it('maps a duplicate canonical name to 409 duplicate_name with conflicts[] and writes nothing', async () => {
    const env = productEnv()
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ is_admin: 1 })
      .mockResolvedValueOnce(productRow())
    env.DB.all = vi.fn().mockResolvedValueOnce({
      results: [{ productKey: 'gula--gulaku--1-kg', name: 'Gula Pasir', source: 'product' }],
    })

    const res = await apiApp.request(
      RENAME_PATH,
      renameRequest({ canonicalName: 'Gula Pasir', expectedMetadataVersion: 1 }),
      env
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'duplicate_name',
      conflicts: [{ productKey: 'gula--gulaku--1-kg', name: 'Gula Pasir', source: 'product' }],
    })
    expect(env.DB.batch).not.toHaveBeenCalled()
  })

  it('maps a similar name to 409 similar_name with warnings[] and writes nothing', async () => {
    const env = productEnv()
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ is_admin: 1 })
      .mockResolvedValueOnce(productRow())
    env.DB.all = vi
      .fn()
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({
        results: [{ productKey: 'beras--ramos--5-kg-super', name: 'Beras Ramos 5 kg Super' }],
      })
      .mockResolvedValueOnce({ results: [] })

    const res = await apiApp.request(
      RENAME_PATH,
      renameRequest({ canonicalName: 'Beras Ramos 5 kg Super Extra', expectedMetadataVersion: 1 }),
      env
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'similar_name',
      warnings: [
        {
          productKey: 'beras--ramos--5-kg-super',
          name: 'Beras Ramos 5 kg Super',
          similarity: 0.833,
        },
      ],
    })
    expect(env.DB.batch).not.toHaveBeenCalled()
  })

  it('maps a stale expectedMetadataVersion to 409 stale_product with current{name, metadataVersion}', async () => {
    const env = productEnv()
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ is_admin: 1 })
      .mockResolvedValueOnce(productRow({ metadata_version: 2 }))

    const res = await apiApp.request(
      RENAME_PATH,
      renameRequest({ canonicalName: 'Beras Ramos Premium', expectedMetadataVersion: 1 }),
      env
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'stale_product',
      current: { name: 'Beras Ramos 5 kg', metadataVersion: 2 },
    })
    expect(env.DB.batch).not.toHaveBeenCalled()
  })

  it('returns 404 when renaming an unknown product', async () => {
    const env = productEnv()
    env.DB.first = vi.fn().mockResolvedValueOnce({ is_admin: 1 }).mockResolvedValueOnce(null)
    const res = await apiApp.request(
      RENAME_PATH,
      renameRequest({ canonicalName: 'Beras Ramos Premium', expectedMetadataVersion: 1 }),
      env
    )
    expect(res.status).toBe(404)
  })

  it('reverts the latest rename and returns the mutation envelope', async () => {
    const env = productEnv()
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ is_admin: 1 })
      .mockResolvedValueOnce(productRow({ name: 'Beras Ramos Premium', metadata_version: 2 }))
      .mockResolvedValueOnce({
        id: 'audit-1',
        product_id: 'prod-1',
        action: 'rename',
        old_name: 'Beras Ramos 5 kg',
        new_name: 'Beras Ramos Premium',
        metadata_version_after: 2,
      })
    env.DB.batch = vi
      .fn()
      .mockResolvedValueOnce([
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
      ])
      .mockResolvedValueOnce([
        { results: [productRow({ name: 'Beras Ramos 5 kg', metadata_version: 3 })] },
        {
          results: [
            auditRow({
              id: 'audit-2',
              action: 'revert',
              old_name: 'Beras Ramos Premium',
              new_name: 'Beras Ramos 5 kg',
              metadata_version_before: 2,
              metadata_version_after: 3,
              reverts_audit_id: 'audit-1',
            }),
          ],
        },
        { results: [{ version: 2 }] },
      ])

    const res = await apiApp.request(REVERT_PATH, revertRequest({ reason: 'wrong label' }), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toMatch(/private, no-cache/)
    const body = (await res.json()) as any
    expect(body.product).toMatchObject({ name: 'Beras Ramos 5 kg', metadataVersion: 3 })
    expect(body.indexVersion).toBe(2)
    expect(body.audit[0]).toMatchObject({
      action: 'revert',
      revertsAuditId: 'audit-1',
      metadataVersionBefore: 2,
      metadataVersionAfter: 3,
    })
  })

  it('maps a non-latest or already-compensated rename to 409 stale_revert', async () => {
    const env = productEnv()
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ is_admin: 1 })
      .mockResolvedValueOnce(productRow({ name: 'Beras Ramos Premium', metadata_version: 2 }))
      .mockResolvedValueOnce({
        id: 'audit-1',
        product_id: 'prod-1',
        action: 'rename',
        old_name: 'Beras Ramos 5 kg',
        new_name: 'Beras Ramos Premium',
        metadata_version_after: 1,
      })

    const res = await apiApp.request(REVERT_PATH, revertRequest(), env)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'stale_revert' })
    expect(env.DB.batch).not.toHaveBeenCalled()
  })

  it('returns 404 for an unknown audit entry or an audit entry of another product', async () => {
    for (const target of [
      null,
      {
        id: 'audit-1',
        product_id: 'prod-other',
        action: 'rename',
        old_name: 'X',
        new_name: 'Y',
        metadata_version_after: 2,
      },
    ]) {
      const env = productEnv()
      env.DB.first = vi
        .fn()
        .mockResolvedValueOnce({ is_admin: 1 })
        .mockResolvedValueOnce(productRow())
        .mockResolvedValueOnce(target)
      const res = await apiApp.request(REVERT_PATH, revertRequest(), env)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'Audit entry not found' })
      expect(env.DB.batch).not.toHaveBeenCalled()
    }
  })

  it('returns 404 when reverting on an unknown product', async () => {
    const env = productEnv()
    env.DB.first = vi.fn().mockResolvedValueOnce({ is_admin: 1 }).mockResolvedValueOnce(null)
    const res = await apiApp.request(REVERT_PATH, revertRequest(), env)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Product not found' })
  })
})

// Candidate alias decisions (#489). The write semantics (CAS, receipt,
// approve-only index bump, exactly-once under a race) are pinned on real
// SQLite in canonical-products.test.ts; these tests pin the HTTP surface —
// the admin chain, the bodyless contract, the typed-error → status/code
// mapping, and the cache header.
describe('/api/admin/products/:productKey/aliases/:aliasId/approve|reject', () => {
  const PRODUCT_PATH = '/api/admin/products/beras--ramos--5-kg'
  const APPROVE_PATH = `${PRODUCT_PATH}/aliases/alias-1/approve`
  const REJECT_PATH = `${PRODUCT_PATH}/aliases/alias-1/reject`
  const NOW = '2026-11-07T00:00:00.000Z'

  function aliasEnv() {
    return createMockEnv({
      props: { userId: 'u1', householdId: 'h1' },
      RATE_LIMIT_MAX_REQUESTS: '10000',
    })
  }

  function productRow() {
    return {
      id: 'prod-1',
      product_key: 'beras--ramos--5-kg',
      name: 'Beras Ramos 5 kg',
      brand: null,
      unit: '5 kg',
      status: 'provisional',
      metadata_version: 1,
      first_seen_at: NOW,
      last_seen_at: NOW,
      updated_at: NOW,
    }
  }

  function aliasRow(over: Record<string, unknown> = {}) {
    return {
      id: 'alias-1',
      name: 'Beras Ramos',
      store_slug: 'superindo',
      status: 'candidate',
      source: 'ocr',
      first_seen_at: NOW,
      last_seen_at: NOW,
      ...over,
    }
  }

  // The pre-check reads (admin, product, alias) then the write batch
  // (`writeStatements` statements), then the read-back batch (decided alias +
  // index version).
  function decisionEnv(decidedAlias: Record<string, unknown>, writeStatements: number) {
    const env = aliasEnv()
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ is_admin: 1 })
      .mockResolvedValueOnce(productRow())
      .mockResolvedValueOnce(aliasRow())
    env.DB.batch = vi
      .fn()
      .mockResolvedValueOnce(
        Array.from({ length: writeStatements }, () => ({ meta: { changes: 1 } }))
      )
      .mockResolvedValueOnce([{ results: [decidedAlias] }, { results: [{ version: 4 }] }])
    return env
  }

  it('approves an alias and returns {alias, indexVersion} with private no-cache headers', async () => {
    const env = decisionEnv(aliasRow({ status: 'approved' }), 3)
    const res = await apiApp.request(APPROVE_PATH, { method: 'POST' }, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toMatch(/private, no-cache/)
    expect(await res.json()).toEqual({
      alias: {
        id: 'alias-1',
        name: 'Beras Ramos',
        storeSlug: 'superindo',
        status: 'approved',
        source: 'ocr',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      indexVersion: 4,
    })
    // One write batch + one read-back batch; nothing else touches the DB.
    expect(env.DB.batch).toHaveBeenCalledTimes(2)

    // Approve is the three-statement batch: CAS, receipt, canonical-index bump.
    const writeStatements = (env.DB.batch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(writeStatements).toHaveLength(3)
  })

  it('rejects an alias and returns the unchanged index version', async () => {
    const env = decisionEnv(aliasRow({ status: 'rejected' }), 2)
    const res = await apiApp.request(REJECT_PATH, { method: 'POST' }, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toMatch(/private, no-cache/)

    const body = (await res.json()) as any
    expect(body.alias).toMatchObject({
      id: 'alias-1',
      status: 'rejected',
      storeSlug: 'superindo',
    })
    expect(body.indexVersion).toBe(4)

    // The reject batch is two statements — the CAS and the receipt. There is
    // no bump statement to gate, which is the "no index bump on reject" rule
    // at the SQL boundary.
    const writeStatements = (env.DB.batch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(writeStatements).toHaveLength(2)
  })

  it('returns 404 for an unknown product and for an alias of another product', async () => {
    const unknownProduct = aliasEnv()
    unknownProduct.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ is_admin: 1 })
      .mockResolvedValueOnce(null)
    const missingProduct = await apiApp.request(APPROVE_PATH, { method: 'POST' }, unknownProduct)
    expect(missingProduct.status).toBe(404)
    expect(await missingProduct.json()).toEqual({ error: 'Product not found' })

    for (const path of [APPROVE_PATH, REJECT_PATH]) {
      const foreignAlias = aliasEnv()
      // The pre-check's join misses: the alias id exists, but under another
      // product. Same 404 shape, so the route cannot confirm the id exists.
      foreignAlias.DB.first = vi
        .fn()
        .mockResolvedValueOnce({ is_admin: 1 })
        .mockResolvedValueOnce(productRow())
        .mockResolvedValueOnce(null)
      const res = await apiApp.request(path, { method: 'POST' }, foreignAlias)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'Alias not found' })
      expect(foreignAlias.DB.batch).not.toHaveBeenCalled()
    }
  })

  it('maps an already-decided alias to 409 alias_state with the current status', async () => {
    for (const status of ['approved', 'rejected']) {
      for (const path of [APPROVE_PATH, REJECT_PATH]) {
        const env = aliasEnv()
        env.DB.first = vi
          .fn()
          .mockResolvedValueOnce({ is_admin: 1 })
          .mockResolvedValueOnce(productRow())
          .mockResolvedValueOnce(aliasRow({ status }))
        const res = await apiApp.request(path, { method: 'POST' }, env)
        expect(res.status).toBe(409)
        expect(await res.json()).toEqual({ error: 'alias_state', currentStatus: status })
        expect(env.DB.batch).not.toHaveBeenCalled()
      }
    }
  })
})

// Bulk exact-name alias approval (#515, follow-up to #489). The write semantics
// (exact-match-only, receipt per approval, one bump, idempotency, chunking) are
// pinned on real SQLite in canonical-products.test.ts; these tests pin the HTTP
// surface — the counts read, the bodyless receipt, the 500 that keeps a partial
// run honest, and the cache header. 401/403 ride the product block's matrix.
describe('/api/admin/products/aliases/candidates|bulk-approve', () => {
  const COUNTS_PATH = '/api/admin/products/aliases/candidates'
  const BULK_PATH = '/api/admin/products/aliases/bulk-approve'

  function bulkEnv() {
    return createMockEnv({
      props: { userId: 'u1', householdId: 'h1' },
      RATE_LIMIT_MAX_REQUESTS: '10000',
    })
  }

  function candidateRow(id: string) {
    return { id, productKey: 'beras--ramos--5-kg' }
  }

  it('serves the candidate counts with private no-cache headers and writes nothing', async () => {
    const env = bulkEnv()
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ is_admin: 1 })
      .mockResolvedValueOnce({ candidates: 1973, exactCandidates: 42 })

    const res = await apiApp.request(COUNTS_PATH, {}, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toMatch(/private, no-cache/)
    expect(await res.json()).toEqual({ candidates: 1973, exactCandidates: 42 })
    // Read-only: the panel's counts never write or bump.
    expect(env.DB.batch).not.toHaveBeenCalled()
  })

  it('approves exact-name aliases and returns the run receipt', async () => {
    const env = bulkEnv()
    env.DB.first = vi.fn().mockResolvedValue({ is_admin: 1 })
    env.DB.all = vi
      .fn()
      .mockResolvedValue({ results: [candidateRow('alias-1'), candidateRow('alias-2')] })
    env.DB.batch = vi
      .fn()
      // One chunk: two aliases x (CAS + receipt).
      .mockResolvedValueOnce([
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
      ])
      // Tail: one bump, the version read, the remaining-candidate count.
      .mockResolvedValueOnce([
        { meta: { changes: 1 } },
        { results: [{ version: 9 }] },
        { results: [{ candidates: 4 }] },
      ])

    const res = await apiApp.request(BULK_PATH, { method: 'POST' }, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toMatch(/private, no-cache/)
    expect(await res.json()).toEqual({
      exactCandidates: 2,
      approved: 2,
      remainingCandidates: 4,
      indexVersion: 9,
    })
    expect(env.DB.batch).toHaveBeenCalledTimes(2)
    const writeStatements = (env.DB.batch as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(writeStatements).toHaveLength(4)
    const tailStatements = (env.DB.batch as ReturnType<typeof vi.fn>).mock.calls[1][0]
    // The single bump is in the tail, not per alias — that is the "bump once"
    // rule at the SQL boundary.
    expect(tailStatements).toHaveLength(3)
  })

  it('accepts an empty JSON body as well as no body', async () => {
    const env = bulkEnv()
    env.DB.first = vi.fn().mockResolvedValue({ is_admin: 1 })
    env.DB.all = vi.fn().mockResolvedValue({ results: [] })
    env.DB.batch = vi
      .fn()
      .mockResolvedValueOnce([{ results: [{ version: 3 }] }, { results: [{ candidates: 0 }] }])

    const res = await apiApp.request(
      BULK_PATH,
      {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )

    expect(res.status).toBe(200)
    // Nothing to approve: no bump statement, so the tail is just the two reads.
    expect(await res.json()).toEqual({
      exactCandidates: 0,
      approved: 0,
      remainingCandidates: 0,
      indexVersion: 3,
    })
  })

  it('answers 500 bulk_approve_failed with the count reached when a chunk fails', async () => {
    const env = bulkEnv()
    env.DB.first = vi.fn().mockResolvedValue({ is_admin: 1 })
    env.DB.all = vi.fn().mockResolvedValue({ results: [candidateRow('alias-1')] })
    env.DB.batch = vi
      .fn()
      .mockRejectedValueOnce(new Error('D1 unavailable'))
      // The failure path still reads the version + remaining count.
      .mockResolvedValueOnce([{ results: [{ version: 4 }] }, { results: [{ candidates: 1 }] }])

    const res = await apiApp.request(BULK_PATH, { method: 'POST' }, env)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'bulk_approve_failed',
      approved: 0,
      indexVersion: 4,
      remainingCandidates: 1,
    })
  })
})
