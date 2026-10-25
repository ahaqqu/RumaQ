// Tier-1 fetch ladder tests: default headers, retries, cookie jar, and the
// browser-tier guard (port of the behavior in haqita base_scraper.py).
// Fetcher methods are Effects — driven through Effect.runPromise.

import { describe, expect, it, vi } from 'vite-plus/test'
import { Effect } from 'effect'

import { exitError } from '../helpers.js'

import { createFetcher, DEFAULT_HEADERS } from '../../src/fetch/strategy.js'
import type { StoreConfig } from '../../src/config.js'

const plainStore: StoreConfig = {
  slug: 'superindo',
  name: 'Superindo',
  kind: 'brochure',
  strategy: 'plain',
  region: 'jakarta',
  maxPages: 40,
  proxyEnv: 'SUPERINDO_PROXY_URL',
}

const browserStore: StoreConfig = { ...plainStore, slug: 'lotte-mart', strategy: 'browser' }

function htmlResponse(html: string, headers: Record<string, string> = {}): Response {
  return new Response(html, { status: 200, headers })
}

describe('createFetcher', () => {
  it('sends realistic Chrome headers', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      htmlResponse('<html></html>')
    )
    const fetcher = createFetcher(plainStore, { fetch: fetchMock, sleep: async () => {} })
    await Effect.runPromise(fetcher.fetchHtml('https://www.superindo.co.id/promosi/'))
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    expect(headers['User-Agent']).toBe(DEFAULT_HEADERS['User-Agent'])
    expect(headers['Accept-Language']).toBe('id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7')
  })

  it('retries with exponential backoff and succeeds', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      if (calls < 3) return new Response('nope', { status: 500 })
      return htmlResponse('<html>ok</html>')
    })
    const sleep = vi.fn(async () => {})
    const fetcher = createFetcher(plainStore, { fetch: fetchMock, sleep, retries: 3, backoffMs: 1 })
    const html = await Effect.runPromise(fetcher.fetchHtml('https://example.com/'))
    expect(html).toBe('<html>ok</html>')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('gives up after retries and fails with the last HTTP error', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 503 }))
    const fetcher = createFetcher(plainStore, {
      fetch: fetchMock,
      sleep: async () => {},
      retries: 2,
      backoffMs: 1,
    })
    await expect(Effect.runPromise(fetcher.fetchHtml('https://example.com/'))).rejects.toThrow(
      'HTTP 503'
    )
    expect(fetchMock).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
  })

  it('fails fast on permanent 4xx without burning the retry ladder', async () => {
    const fetchMock = vi.fn(async () => new Response('gone', { status: 404 }))
    const sleep = vi.fn(async () => {})
    const fetcher = createFetcher(plainStore, { fetch: fetchMock, sleep, retries: 3, backoffMs: 1 })
    await expect(Effect.runPromise(fetcher.fetchHtml('https://example.com/'))).rejects.toThrow(
      'HTTP 404'
    )
    expect(fetchMock).toHaveBeenCalledTimes(1) // 404 can never succeed on retry
    expect(sleep).not.toHaveBeenCalled()
  })

  it('still retries 429 — it is a backoff signal, not a permanent failure', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      return calls < 2
        ? new Response('slow down', { status: 429 })
        : htmlResponse('<html>ok</html>')
    })
    const sleep = vi.fn(async () => {})
    const fetcher = createFetcher(plainStore, { fetch: fetchMock, sleep, retries: 3, backoffMs: 1 })
    const html = await Effect.runPromise(fetcher.fetchHtml('https://example.com/'))
    expect(html).toBe('<html>ok</html>')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('times out stalled peers as a retryable transport error', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const sleep = vi.fn(async () => {})
    const fetcher = createFetcher(plainStore, {
      fetch: fetchMock,
      sleep,
      timeoutMs: 5,
      retries: 2,
      backoffMs: 1,
    })
    await expect(Effect.runPromise(fetcher.fetchHtml('https://example.com/'))).rejects.toThrow(
      'Fetch failed'
    )
    // Timeout aborts surface as FetchTransport (not a defect) — retried with a
    // fresh signal per attempt.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('persists cookies from responses into subsequent requests', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response('<html></html>', {
          status: 200,
          headers: { 'set-cookie': 'session=abc123; Path=/; HttpOnly' },
        })
      }
      return htmlResponse('<html></html>')
    })
    const fetcher = createFetcher(plainStore, { fetch: fetchMock, sleep: async () => {} })
    await Effect.runPromise(fetcher.fetchHtml('https://example.com/first'))
    await Effect.runPromise(fetcher.fetchHtml('https://example.com/second'))
    const secondHeaders = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<
      string,
      string
    >
    expect(secondHeaders.Cookie).toBe('session=abc123')
  })

  it('fails with BrowserTierRequired for browser stores instead of wasting plain fetches', async () => {
    const fetchMock = vi.fn(async () => htmlResponse('<html></html>'))
    const fetcher = createFetcher(browserStore, { fetch: fetchMock, sleep: async () => {} })
    const failure = await Effect.runPromiseExit(fetcher.fetchHtml('https://www.lottemart.co.id/'))
    expect(failure._tag).toBe('Failure')
    expect(exitError(failure)).toMatchObject({ _tag: 'BrowserTierRequired' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still allows image downloads for browser stores (images are usually unblocked CDNs)', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
    )
    const fetcher = createFetcher(browserStore, { fetch: fetchMock, sleep: async () => {} })
    const downloaded = await Effect.runPromise(
      fetcher.fetchBytes('https://cdn.example.com/img.jpg')
    )
    expect(Array.from(downloaded.bytes)).toEqual([1, 2, 3])
    expect(downloaded.contentType).toBe('image/jpeg')
  })

  it('fetchBytes rejects a non-image content-type without retrying', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response('<html>blocked</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
    )
    const fetcher = createFetcher(plainStore, { fetch: fetchMock, sleep: async () => {} })
    await expect(
      Effect.runPromise(fetcher.fetchBytes('https://example.com/img.jpg'))
    ).rejects.toThrow('Non-image content-type "text/html"')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fetchBytes accepts image, octet-stream, and missing content-types', async () => {
    for (const contentType of ['image/jpeg', 'application/octet-stream', null]) {
      const headers: Record<string, string> = {}
      if (contentType) headers['content-type'] = contentType
      const fetchMock = vi.fn(
        async (_url: string, _init?: RequestInit) =>
          new Response(new Uint8Array([9]), { status: 200, headers })
      )
      const fetcher = createFetcher(plainStore, { fetch: fetchMock, sleep: async () => {} })
      const downloaded = await Effect.runPromise(
        fetcher.fetchBytes('https://cdn.example.com/img.jpg')
      )
      expect(Array.from(downloaded.bytes)).toEqual([9])
      expect(downloaded.contentType).toBe(contentType)
    }
  })

  it('routes through the store proxy when the env var is set', async () => {
    process.env.SUPERINDO_PROXY_URL = 'http://proxy:8080'
    try {
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit & { proxy?: string }) =>
        htmlResponse('<html></html>')
      )
      const fetcher = createFetcher(plainStore, { fetch: fetchMock, sleep: async () => {} })
      await Effect.runPromise(fetcher.fetchHtml('https://example.com/'))
      const init = fetchMock.mock.calls[0]![1] as RequestInit & { proxy?: string }
      expect(init.proxy).toBe('http://proxy:8080')
    } finally {
      delete process.env.SUPERINDO_PROXY_URL
    }
  })
})
