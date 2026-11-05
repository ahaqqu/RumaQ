import { describe, it, expect, vi } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import { gateway } from '../gateway.js'
import { createMockEnv } from './support/env.js'
import { utcIsoDate } from '../lib/documents.js'

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

  it('/api/me maps users.is_admin to isAdmin in both directions', async () => {
    const makeEnv = (isAdmin: number) => {
      const env = createMockEnv()
      env.props = { userId: 'user-123', householdId: 'house-456' }
      env.DB.prepare = vi.fn().mockReturnThis()
      env.DB.bind = vi.fn().mockReturnThis()
      env.DB.first = vi.fn().mockResolvedValueOnce({
        id: 'user-123',
        email: 'a@b.com',
        name: 'Alice',
        picture: null,
        is_admin: isAdmin,
      })
      return env
    }

    const admin = await apiApp.request('/api/me', {}, makeEnv(1))
    const adminBody = (await admin.json()) as { user: { isAdmin?: boolean; is_admin?: number } }
    expect(adminBody.user.isAdmin).toBe(true)

    const regular = await apiApp.request('/api/me', {}, makeEnv(0))
    const regularBody = (await regular.json()) as {
      user: { isAdmin?: boolean; is_admin?: number }
    }
    expect(regularBody.user.isAdmin).toBe(false)

    // The raw column never leaks into the JSON.
    expect(adminBody.user.is_admin).toBeUndefined()
    expect(regularBody.user.is_admin).toBeUndefined()
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

  // Behavior matrix lives in cors.test.ts (unit level, against createCors
  // directly); this single test proves the middleware is wired into apiApp.
  it('cors middleware is wired into apiApp', async () => {
    const allowed = await apiApp.request(
      '/api/health',
      { headers: { Origin: 'http://localhost:5173' } },
      createMockEnv()
    )
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')

    const env = createMockEnv({ PAGES_ORIGIN: 'https://custom.pages.dev' })
    const rejected = await apiApp.request(
      '/api/health',
      { headers: { Origin: 'https://evil.com' } },
      env
    )
    expect(rejected.headers.get('access-control-allow-origin')).toBe('null')
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

describe('worker scheduled handler (1-year AI usage retention, #353)', () => {
  it('sweeps ai_usage_events older than 365 days via waitUntil', async () => {
    const env = createMockEnv()
    env.DB.prepare = vi.fn().mockReturnThis()
    env.DB.bind = vi.fn().mockReturnThis()
    ;(env.DB as unknown as { run: unknown }).run = vi.fn().mockResolvedValue(undefined)
    ;(env.DB as unknown as { all: unknown }).all = vi.fn().mockResolvedValue({ results: [] })
    const waitUntil = vi.fn()
    const ctx = { waitUntil } as unknown as ExecutionContext

    await gateway.scheduled(
      {} as ScheduledController,
      env as unknown as Parameters<typeof gateway.scheduled>[1],
      ctx
    )

    expect(waitUntil).toHaveBeenCalledTimes(2)
    expect(env.DB.prepare).toHaveBeenCalledWith('DELETE FROM ai_usage_events WHERE ts < ?')
    expect(env.DB.bind).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/))
  })

  it('piggybacks the document expiry reminder sweep on the same tick (#426)', async () => {
    const env = createMockEnv()
    env.DB.prepare = vi.fn().mockReturnThis()
    env.DB.bind = vi.fn().mockReturnThis()
    ;(env.DB as unknown as { run: unknown }).run = vi.fn().mockResolvedValue(undefined)
    // The due-set pass reads the expiry-bearing rows (SELECT ... WHERE
    // expires_on IS NOT NULL) and logs a summary only when the set is
    // non-empty — v1 renders in-app, so the sweep's artifact is the log line.
    // The fixture expiry is TODAY (distance 0, inside any window), so the
    // due-ness holds against the real clock whatever day it runs.
    const allSpy = vi.fn().mockResolvedValue({
      results: [
        {
          id: 'doc-1',
          household_id: 'h1',
          name: 'KTP Bapak',
          expires_on: utcIsoDate(new Date()),
          remind_days_before: 30,
        },
      ],
    })
    ;(env.DB as unknown as { all: unknown }).all = allSpy
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const waitUntil = vi.fn()
    const ctx = { waitUntil } as unknown as ExecutionContext

    await gateway.scheduled(
      {} as ScheduledController,
      env as unknown as Parameters<typeof gateway.scheduled>[1],
      ctx
    )

    expect(waitUntil).toHaveBeenCalledTimes(2)
    expect(env.DB.prepare).toHaveBeenCalledWith(
      expect.stringContaining('WHERE expires_on IS NOT NULL')
    )
    // Let the waitUntil promises settle, then assert the due-set report ran.
    const tasks = waitUntil.mock.calls.map((call) => call[0]) as Promise<unknown>[]
    await Promise.all(tasks)
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('renewal reminders: 1 document(s) due across 1 household(s)')
    )
    logSpy.mockRestore()
  })
})
