import { Hono } from 'hono'
import { describe, it, expect } from 'vite-plus/test'
import { createCors } from '../cors.js'
import { createMockEnv, type MockEnv } from './support/env.js'

function makeApp() {
  const app = new Hono<{ Bindings: MockEnv }>()
  app.use('*', createCors())
  app.get('/ping', (c) => c.text('pong'))
  return app
}

function makeEnv(pagesOrigin?: string) {
  // Explicit undefined override keeps the "PAGES_ORIGIN unset" fallback path testable.
  return createMockEnv({ PAGES_ORIGIN: pagesOrigin })
}

describe('createCors', () => {
  it('reflects the exact configured origin', async () => {
    const app = makeApp()
    const res = await app.request(
      '/ping',
      { headers: { Origin: 'https://rumaq.pages.dev' } },
      makeEnv('https://rumaq.pages.dev')
    )
    expect(res.headers.get('access-control-allow-origin')).toBe('https://rumaq.pages.dev')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('allows the default pages.dev origin when PAGES_ORIGIN is unset', async () => {
    const app = makeApp()
    const res = await app.request(
      '/ping',
      { headers: { Origin: 'https://rumaq.pages.dev' } },
      makeEnv()
    )
    expect(res.headers.get('access-control-allow-origin')).toBe('https://rumaq.pages.dev')
  })

  it.each(['http://localhost:5173', 'http://localhost:8788'])(
    'allows local dev origin %s',
    async (origin) => {
      const app = makeApp()
      const res = await app.request('/ping', { headers: { Origin: origin } }, makeEnv())
      expect(res.headers.get('access-control-allow-origin')).toBe(origin)
    }
  )

  it('allows branch previews under the configured pages.dev hostname', async () => {
    const app = makeApp()
    const res = await app.request(
      '/ping',
      { headers: { Origin: 'https://rumaq-api-feat-x.rumaq.pages.dev' } },
      makeEnv('https://rumaq.pages.dev')
    )
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://rumaq-api-feat-x.rumaq.pages.dev'
    )
  })

  it.each([
    ['https://evil.com', 'https://rumaq.pages.dev'],
    ['https://other-project.pages.dev', 'https://rumaq.pages.dev'],
    ['https://rumaq.pages.dev.evil.com', 'https://rumaq.pages.dev'],
  ])('rejects unknown origin %s', async (origin, pagesOrigin) => {
    const app = makeApp()
    const res = await app.request('/ping', { headers: { Origin: origin } }, makeEnv(pagesOrigin))
    expect(res.headers.get('access-control-allow-origin')).toBe('null')
  })

  it('rejects unknown origins even when PAGES_ORIGIN is unset', async () => {
    const app = makeApp()
    const res = await app.request('/ping', { headers: { Origin: 'https://test.com' } }, makeEnv())
    expect(res.headers.get('access-control-allow-origin')).toBe('null')
  })

  it('falls back to rejection when PAGES_ORIGIN is malformed', async () => {
    const app = makeApp()
    const res = await app.request(
      '/ping',
      { headers: { Origin: 'https://rumaq.pages.dev' } },
      makeEnv('not a url')
    )
    expect(res.headers.get('access-control-allow-origin')).toBe('null')
  })

  it('answers preflight requests with allow-origin and allow-methods', async () => {
    const app = makeApp()
    const res = await app.request(
      '/ping',
      { method: 'OPTIONS', headers: { Origin: 'https://rumaq.pages.dev' } },
      makeEnv('https://rumaq.pages.dev')
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://rumaq.pages.dev')
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('never mirrors an arbitrary origin as allow-origin', async () => {
    const app = makeApp()
    const res = await app.request(
      '/ping',
      { headers: { Origin: 'https://attacker.example' } },
      makeEnv('https://rumaq.pages.dev')
    )
    const acao = res.headers.get('access-control-allow-origin')
    expect(acao === 'null' || acao === 'https://rumaq.pages.dev').toBe(true)
    expect(acao).not.toBe('https://attacker.example')
  })
})
