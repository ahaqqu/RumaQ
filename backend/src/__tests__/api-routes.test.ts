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
    const res = await apiApp.request('/api/home', {}, env)
    expect(((await res.json()) as any).total_items).toBe(5)
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

  it('/api/ai/chat returns 429 with Retry-After when the server key hits the daily cap', async () => {
    // The daily usage cap applies to the shared server key only; BYO user
    // keys are uncapped (ai-access.ts). This covers the HTTP wiring (status
    // + header) that the integration suite no longer reaches end-to-end.
    const env = createMockEnv({
      props: { userId: 'u1', householdId: 'h1' },
      RUMAQ_SERVER_AI_PROVIDER: 'openai',
      RUMAQ_SERVER_AI_KEY: 'sk-server',
    })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce(null) // user_settings: no user key -> server key path
      .mockResolvedValueOnce({ id: 'usage-1', used: 20, daily_limit: 20 }) // ai_usage
    const res = await apiApp.request(
      '/api/ai/chat',
      {
        method: 'POST',
        body: JSON.stringify({ message: 'hello' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
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

  it('/api/ai/usage returns usage', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValue({ id: 'u1', used: 5, daily_limit: 20, provider: 'gemini' })
    const res = await apiApp.request('/api/ai/usage', {}, env)
    expect(((await res.json()) as any).used).toBe(5)
  })

  it('/api/ai/usage creates new row when missing', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({ ai_provider: 'gemini', encrypted_ai_key: null })
      .mockResolvedValueOnce(null)
    const res = await apiApp.request('/api/ai/usage', {}, env)
    const body = (await res.json()) as any
    expect(body.used).toBe(0)
    expect(body.key_source).toBe('user')
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

  it('/api/ai/chat returns 429 when server-key usage limit reached', async () => {
    const env = createMockEnv({
      props: { userId: 'u1', householdId: 'h1' },
      RUMAQ_SERVER_AI_PROVIDER: 'gemini',
      RUMAQ_SERVER_AI_KEY: 'sk-server',
    })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({
        ai_provider: null,
        encrypted_ai_key: null,
        persona_enabled: 0,
        persona_user_role: null,
        persona_ai_role: null,
      })
      .mockResolvedValueOnce({ id: 'u1', used: 20, daily_limit: 20 })
    const res = await apiApp.request(
      '/api/ai/chat',
      {
        method: 'POST',
        body: JSON.stringify({ message: 'hi' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )
    expect(res.status).toBe(429)
  })

  it('/api/ai/chat lets own-key users continue past the daily limit', async () => {
    const env = createMockEnv({ props: { userId: 'u1', householdId: 'h1' } })
    env.DB.first = vi
      .fn()
      .mockResolvedValueOnce({
        ai_provider: 'gemini',
        ai_base_url: null,
        ai_model: null,
        ai_thinking_level: null,
        encrypted_ai_key: ENCRYPTED_KEY,
        persona_enabled: 0,
        persona_user_role: null,
        persona_ai_role: null,
      })
      .mockResolvedValueOnce({ id: 'u1', used: 20, daily_limit: 20 })
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
