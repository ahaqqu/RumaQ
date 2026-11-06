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

  it('/api/settings rejects a non-HTTPS custom base URL', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    const res = await apiApp.request(
      '/api/settings',
      {
        method: 'PATCH',
        body: JSON.stringify({ ai_base_url: 'http://api.example.com/v1' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(400)
  })

  it('/api/settings rejects an unparseable custom base URL', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    const res = await apiApp.request(
      '/api/settings',
      {
        method: 'PATCH',
        body: JSON.stringify({ ai_base_url: 'not a url' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(400)
  })

  it('/api/settings strips trailing slashes from the custom base URL', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    const res = await apiApp.request(
      '/api/settings',
      {
        method: 'PATCH',
        body: JSON.stringify({ ai_base_url: 'https://api.example.com/v1/' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
    const bound = env.DB.bind.mock.calls.flat()
    expect(bound).toContain('https://api.example.com/v1')
  })

  it('/api/settings stores the thinking level and clears it with an empty string', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    const res = await apiApp.request(
      '/api/settings',
      {
        method: 'PATCH',
        body: JSON.stringify({ ai_thinking_level: 'high' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
    expect(env.DB.bind.mock.calls.flat()).toContain('high')

    const clear = await apiApp.request(
      '/api/settings',
      {
        method: 'PATCH',
        body: JSON.stringify({ ai_thinking_level: '' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(clear.status).toBe(200)
    expect(env.DB.bind.mock.calls.flat()).toContain(null)
  })

  it('/api/settings rejects a thinking level outside the enum', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    const res = await apiApp.request(
      '/api/settings',
      {
        method: 'PATCH',
        body: JSON.stringify({ ai_thinking_level: 'extreme' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(400)
  })

  it('/api/settings rejects a model name outside the safe charset', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    const res = await apiApp.request(
      '/api/settings',
      {
        method: 'PATCH',
        body: JSON.stringify({ ai_model: 'gemini-flash?tool=code_execution' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(400)
  })

  it('/api/settings accepts ollama-style model names', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    const res = await apiApp.request(
      '/api/settings',
      {
        method: 'PATCH',
        body: JSON.stringify({ ai_model: 'glm-5.3-flash' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
    expect(env.DB.bind.mock.calls.flat()).toContain('glm-5.3-flash')
  })

  it('/api/settings stores encrypted ai_key', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue({
      motion_preference: 'standard',
      language: 'en',
      ai_provider: 'openai',
      persona_user_role: null,
      persona_ai_role: null,
      persona_enabled: 0,
      theme_hue: null,
      encrypted_ai_key: 'v1:abc',
    })
    const res = await apiApp.request(
      '/api/settings',
      {
        method: 'PATCH',
        body: JSON.stringify({ ai_key: 'sk-test', ai_provider: 'openai' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).has_ai_key).toBe(true)
  })

  it('/api/ai/chat succeeds on the server key regardless of usage volume (cap removed, #353)', async () => {
    // The daily cap was removed unconditionally: even the shared server key
    // never gates a call. The call still records an ai_usage_events row.
    const env = createMockEnv({
      props: { userId: 'u1', householdId: 'h1' },
      RUMAQ_SERVER_AI_PROVIDER: 'openai',
      RUMAQ_SERVER_AI_KEY: 'sk-server',
    })
    env.DB.first = vi.fn().mockResolvedValueOnce({
      ai_provider: null,
      encrypted_ai_key: null,
      persona_enabled: 0,
      persona_user_role: null,
      persona_ai_role: null,
    })
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

  it('/api/ai/usage sums today events with no cap fields (#353)', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({
        ai_provider: 'gemini',
        ai_base_url: null,
        ai_model: null,
        ai_thinking_level: null,
        encrypted_ai_key: ENCRYPTED_KEY,
      })
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
      provider: 'gemini',
      key_source: 'user',
    })
  })

  it('/api/ai/usage reports zeroed usage when there are no events today (no row creation)', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ ai_provider: 'gemini', encrypted_ai_key: ENCRYPTED_KEY })
      .mockResolvedValueOnce(null)
    const res = await apiApp.request('/api/ai/usage', {}, env)
    const body = (await res.json()) as any
    expect(body).toEqual({
      used: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: null,
      provider: 'gemini',
      key_source: 'user',
    })
    // Read-only: no counter row is inserted anymore.
    expect(env.DB.prepare.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO'))).toBe(
      false
    )
  })

  it('/api/ai/usage reports server key source when user has no own key', async () => {
    const env = createMockEnv({
      props: { userId: 'u1', householdId: 'h1' },
      RUMAQ_SERVER_AI_PROVIDER: 'gemini',
      RUMAQ_SERVER_AI_KEY: 'sk-server',
    })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ ai_provider: null, encrypted_ai_key: null })
      .mockResolvedValueOnce(null)
    const res = await apiApp.request('/api/ai/usage', {}, env)
    const body = (await res.json()) as any
    expect(body.key_source).toBe('server')
    expect(body.provider).toBe('gemini')
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

  it('/api/ai-key/test validates key from settings', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue({ encrypted_ai_key: ENCRYPTED_KEY })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    const res = await apiApp.request(
      '/api/ai-key/test',
      {
        method: 'POST',
        body: JSON.stringify({ provider: 'openai' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(200)
  })

  it('/api/ai-key/test returns 400 when no key saved', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue({ encrypted_ai_key: null })
    const res = await apiApp.request(
      '/api/ai-key/test',
      {
        method: 'POST',
        body: JSON.stringify({ provider: 'openai' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(400)
  })

  it('/api/ai/chat returns TEST_MODE reply', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValue({
      ai_provider: 'gemini',
      encrypted_ai_key: ENCRYPTED_KEY,
      persona_enabled: 0,
      persona_user_role: null,
      persona_ai_role: null,
    })
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
    env.DB.first = vi
      .fn()
      .mockResolvedValue({ ai_provider: null, encrypted_ai_key: null, persona_enabled: 0 })
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

  it('/api/ai/chat never caps server-key users (no usage gate, #353)', async () => {
    const env = createMockEnv({
      props: { userId: 'u1', householdId: 'h1' },
      RUMAQ_SERVER_AI_PROVIDER: 'gemini',
      RUMAQ_SERVER_AI_KEY: 'sk-server',
    })
    env.DB.first = vi.fn().mockResolvedValueOnce({
      ai_provider: null,
      encrypted_ai_key: null,
      persona_enabled: 0,
      persona_user_role: null,
      persona_ai_role: null,
    })
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

  it('/api/ai/chat lets own-key users chat with usage recorded as an event', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi.fn().mockResolvedValueOnce({
      ai_provider: 'gemini',
      ai_base_url: null,
      ai_model: null,
      ai_thinking_level: null,
      encrypted_ai_key: ENCRYPTED_KEY,
      persona_enabled: 0,
      persona_user_role: null,
      persona_ai_role: null,
    })
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
    env.DB.first = vi
      .fn()
      .mockResolvedValue({ ai_provider: 'gemini', encrypted_ai_key: ENCRYPTED_KEY })
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
      .mockResolvedValueOnce({ ai_provider: 'ollama', encrypted_ai_key: ENCRYPTED_KEY })
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
    env.DB.first = vi.fn().mockResolvedValue({ ai_provider: null, encrypted_ai_key: null })
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
    env.DB.first = vi.fn().mockResolvedValue({
      ai_provider: 'gemini',
      encrypted_ai_key: ENCRYPTED_KEY,
      currency: 'IDR',
    })
    env.DB.all = vi.fn().mockResolvedValue({ results: [{ id: 's1', label: 'Indomaret' }] })
    const res = await apiApp.request('/api/plans/generate', { method: 'POST' }, env)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).items.length).toBeGreaterThan(0)
  })

  it('/api/plans/generate returns 402 when AI not configured', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValue({ ai_provider: null, encrypted_ai_key: null, currency: 'IDR' })
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
    env.DB.first = vi.fn().mockResolvedValue({
      ai_provider: 'gemini',
      encrypted_ai_key: ENCRYPTED_KEY,
      currency: 'IDR',
    })
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
  const RENAME_PATH = `${PRODUCT_PATH}/rename`
  const REVERT_PATH = `${PRODUCT_PATH}/audit/audit-1/revert`

  it('returns 401 without a session on every product admin route', async () => {
    const env = productEnv({ props: undefined })
    const calls: Array<[string, string, RequestInit]> = [
      ['GET', PRODUCT_PATH, {}],
      ['POST', RENAME_PATH, renameRequest({ canonicalName: 'X', expectedMetadataVersion: 1 })],
      ['POST', REVERT_PATH, revertRequest()],
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
      ['POST', RENAME_PATH, renameRequest({ canonicalName: 'X', expectedMetadataVersion: 1 })],
      ['POST', REVERT_PATH, revertRequest()],
    ]
    for (const [method, path, init] of calls) {
      const res = await apiApp.request(path, { method, ...init }, env)
      expect(res.status).toBe(403)
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
