import type { AuthProps } from '../types.js'
import { describe, it, expect, vi } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'

function createMockEnv() {
  return {
    DB: {
      prepare: vi.fn().mockReturnThis(),
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
      batch: vi.fn().mockResolvedValue([]),
    },
    RECEIPTS: {},
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    WORKER_JWT_SECRET: 'test-secret',
    WORKER_ENCRYPTION_KEY: 'test-enc-key',
    PAGES_ORIGIN: 'http://localhost:5173' as string,
    EMAIL_AUTH_ENABLED: 'false' as string,
    ASSETS: undefined as unknown as Fetcher,
    props: undefined as AuthProps | undefined,
  }
}

describe('apiApp (cached routes)', () => {
  it('/api/health returns ok with public cache headers', async () => {
    const res = await apiApp.request('/api/health', {}, createMockEnv())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
    expect(res.headers.get('Cache-Control')).toMatch(/public/)
    expect(res.headers.get('Cache-Control')).toMatch(/max-age=60/)
  })

  it('/api/me returns 401 without props', async () => {
    const res = await apiApp.request('/api/me', {}, createMockEnv())
    expect(res.status).toBe(401)
  })

  it('/api/stock returns 401 without props', async () => {
    const res = await apiApp.request('/api/stock', {}, createMockEnv())
    expect(res.status).toBe(401)
  })

  it('/api/auth/email-status returns public cache headers', async () => {
    const env = createMockEnv()
    env.EMAIL_AUTH_ENABLED = 'false'
    const res = await apiApp.request('/api/auth/email-status', {}, env)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ enabled: false })
    expect(res.headers.get('Cache-Control')).toMatch(/public/)
    expect(res.headers.get('Cache-Control')).toMatch(/max-age=60/)
  })

  it('/api/me returns user data with valid props', async () => {
    const env = createMockEnv()
    env.props = { userId: 'user-123', householdId: 'house-456' }
    env.DB.prepare = vi.fn().mockReturnThis()
    env.DB.bind = vi.fn().mockReturnThis()
    env.DB.first = vi.fn().mockResolvedValueOnce({
      id: 'user-123',
      email: 'a@b.com',
      name: 'Alice',
      picture: null,
    })

    const res = await apiApp.request('/api/me', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user: { email: string } }
    expect(body.user.email).toBe('a@b.com')
    expect(res.headers.get('Cache-Control')).toMatch(/private, no-cache/)
  })

  it('/api/stock returns stock list with valid props', async () => {
    const env = createMockEnv()
    env.props = { userId: 'user-123', householdId: 'house-456' }
    env.DB.prepare = vi.fn().mockReturnThis()
    env.DB.bind = vi.fn().mockReturnThis()
    env.DB.all = vi.fn().mockResolvedValue({ results: [{ id: 's1', name: 'Test' }] })

    const res = await apiApp.request('/api/stock', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { stock: unknown[] }
    expect(body.stock).toHaveLength(1)
    expect(res.headers.get('Cache-Control')).toMatch(/private, no-cache/)
  })

  it('/api/stock filters by location and query', async () => {
    const env = createMockEnv()
    env.props = { userId: 'user-123', householdId: 'house-456' }
    env.DB.prepare = vi.fn().mockReturnThis()
    env.DB.bind = vi.fn().mockReturnThis()
    env.DB.all = vi.fn().mockResolvedValue({ results: [] })

    const res = await apiApp.request('/api/stock?location=kulkas&q=susu', {}, env)
    expect(res.status).toBe(200)
  })

  it('cors allows localhost origin', async () => {
    const res = await apiApp.request(
      '/api/health',
      {
        headers: { Origin: 'http://localhost:5173' },
      },
      createMockEnv()
    )
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })

  it('cors rejects unknown origins in production', async () => {
    const env = createMockEnv()
    env.PAGES_ORIGIN = 'https://custom.pages.dev'
    const res = await apiApp.request(
      '/api/health',
      {
        headers: { Origin: 'https://evil.com' },
      },
      env
    )
    expect(res.headers.get('access-control-allow-origin')).toBe('null')
  })

  it('cors rejects unknown origins when PAGES_ORIGIN is not set', async () => {
    const env = createMockEnv()
    env.PAGES_ORIGIN = ''
    const res = await apiApp.request(
      '/api/health',
      {
        headers: { Origin: 'https://test.com' },
      },
      env
    )
    expect(res.headers.get('access-control-allow-origin')).toBe('null')
  })

  it('cors allows branch previews under the configured Pages hostname', async () => {
    const env = createMockEnv()
    env.PAGES_ORIGIN = 'https://custom.pages.dev'
    const res = await apiApp.request(
      '/api/health',
      {
        headers: { Origin: 'https://branch.custom.pages.dev' },
      },
      env
    )
    expect(res.headers.get('access-control-allow-origin')).toBe('https://branch.custom.pages.dev')
  })

  it('cors rejects unrelated pages.dev origins', async () => {
    const env = createMockEnv()
    env.PAGES_ORIGIN = 'https://custom.pages.dev'
    const res = await apiApp.request(
      '/api/health',
      {
        headers: { Origin: 'https://other-project.pages.dev' },
      },
      env
    )
    expect(res.headers.get('access-control-allow-origin')).toBe('null')
  })

  it('error responses have private no-cache Cache-Control', async () => {
    const env = createMockEnv()
    env.props = { userId: 'user-123', householdId: 'house-456' }
    env.DB.prepare = vi.fn().mockReturnThis()
    env.DB.bind = vi.fn().mockReturnThis()
    env.DB.first = vi.fn().mockRejectedValue(new Error('DB error'))

    const res = await apiApp.request('/api/me', {}, env)
    expect(res.status).toBe(500)
    expect(res.headers.get('Cache-Control')).toMatch(/private, no-cache/)
  })
})
