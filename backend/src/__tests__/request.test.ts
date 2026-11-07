import { describe, it, expect } from 'vite-plus/test'
import { getRequestOrigin } from '../lib/request.js'

// The CSRF origin guard (ahaqqu/RumaQ#528) compares the browser's Origin
// against this value, so it must be a syntactically valid, port-correct
// origin — not just "close enough" for a redirect URI.

function context(url: string, headers: Record<string, string> = {}) {
  return { url, header: (name: string) => headers[name] }
}

describe('getRequestOrigin', () => {
  it('falls back to the request URL origin with no proxy headers', () => {
    expect(getRequestOrigin(context('https://rumaq.ahaqqu.com/api/locations'))).toBe(
      'https://rumaq.ahaqqu.com'
    )
  })

  it('reconstructs the public origin from X-Forwarded-Host and -Proto', () => {
    expect(
      getRequestOrigin(
        context('http://worker/api/locations', {
          'X-Forwarded-Host': 'rumaq.ahaqqu.com',
          'X-Forwarded-Proto': 'https',
        })
      )
    ).toBe('https://rumaq.ahaqqu.com')
  })

  it('uses X-Forwarded-Port when the forwarded host carries no port', () => {
    expect(
      getRequestOrigin(
        context('http://worker:8787/api/locations', {
          'X-Forwarded-Host': 'localhost',
          'X-Forwarded-Port': '3000',
          'X-Forwarded-Proto': 'http',
        })
      )
    ).toBe('http://localhost:3000')
  })

  it('never appends a second port when the forwarded host already carries one', () => {
    // The Docker harness sends both headers (automation/tests/local/api/…):
    // before #528 this produced `localhost:3000:3000`, which `new URL()`
    // rejects — the guard would then fail every same-origin request.
    expect(
      getRequestOrigin(
        context('http://worker:8787/api/locations', {
          'X-Forwarded-Host': 'localhost:3000',
          'X-Forwarded-Port': '3000',
          'X-Forwarded-Proto': 'http',
        })
      )
    ).toBe('http://localhost:3000')
  })

  it('falls back to the request URL port for a port-less forwarded host', () => {
    expect(
      getRequestOrigin(
        context('http://worker:8787/api/locations', {
          'X-Forwarded-Host': 'localhost',
          'X-Forwarded-Proto': 'http',
        })
      )
    ).toBe('http://localhost:8787')
  })
})
