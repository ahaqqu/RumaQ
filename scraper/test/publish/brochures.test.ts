// uploadBrochure unit tests (issue #293): URL derivation, bearer/content-type
// headers, and the failure taxonomy shared with publish/client.ts — 401/403
// PublishRejected, permanent 4xx (404/400/413/415) fatal, 5xx and transport
// errors retryable, dry-run a no-op, missing config a typed failure.

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import { exitError } from '../helpers.js'

import {
  DEFAULT_BROCHURE_TIMEOUT_MS,
  brochureObjectUrl,
  deriveBrochuresBase,
  uploadBrochure,
  type BrochureUploadTarget,
} from '../../src/publish/brochures.js'
import { PublishConfigError, PublishHttpStatus, PublishRejected } from '../../src/publish/client.js'

const noSleep = async () => {}

const target: BrochureUploadTarget = {
  storeSlug: 'lotte-mart',
  date: '20261029',
  filename: 'page_1_2ad1c95b.jpg',
  contentType: 'image/jpeg',
}

const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

function okFetch(counts: { attempts: number }) {
  return async (url: string, init?: RequestInit) => {
    counts.attempts++
    expect(url).toBe('https://api.example.com/api/internal/brochures/lotte-mart/20261029/page_1_2ad1c95b.jpg')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer s3cret')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('image/jpeg')
    expect(init?.method).toBe('PUT')
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
}

describe('deriveBrochuresBase / brochureObjectUrl', () => {
  it('derives the brochures base from the ingest URL origin', () => {
    expect(deriveBrochuresBase('https://rumaq.ahaqqu.com/api/internal/ingest/prices')).toBe(
      'https://rumaq.ahaqqu.com/api/internal/brochures'
    )
    // No marker → treat the whole value as the base (agent.ts precedent).
    expect(deriveBrochuresBase('https://rumaq.ahaqqu.com')).toBe(
      'https://rumaq.ahaqqu.com/api/internal/brochures'
    )
  })

  it('builds the relative same-origin object URL from the key segments', () => {
    expect(brochureObjectUrl(target)).toBe(
      '/api/brochures/lotte-mart/20261029/page_1_2ad1c95b.jpg'
    )
  })
})

describe('uploadBrochure', () => {
  const options = {
    ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
    ingestSecret: 's3cret',
    dryRun: false,
    sleep: noSleep,
  }

  it('PUTs the bytes with bearer auth and the detected content type', async () => {
    const counts = { attempts: 0 }
    const exit = await Effect.runPromiseExit(
      uploadBrochure(bytes, target, { ...options, fetch: okFetch(counts) })
    )
    expect(exit._tag).toBe('Success')
    expect(counts.attempts).toBe(1)
  })

  it('percent-encodes odd filename characters on the endpoint path', async () => {
    let url = ''
    const exit = await Effect.runPromiseExit(
      uploadBrochure(bytes, { ...target, filename: 'page (1).jpg' }, {
        ...options,
        fetch: async (u: string) => {
          url = u
          return new Response('{}', { status: 200 })
        },
      })
    )
    expect(exit._tag).toBe('Success')
    expect(url).toBe(
      'https://api.example.com/api/internal/brochures/lotte-mart/20261029/page%20(1).jpg'
    )
  })

  it('fails fast on 401 with PublishRejected, without retrying', async () => {
    const counts = { attempts: 0 }
    const failure = await Effect.runPromiseExit(
      uploadBrochure(bytes, target, {
        ...options,
        fetch: async () => {
          counts.attempts++
          return new Response('nope', { status: 401 })
        },
      })
    )
    expect(failure._tag).toBe('Failure')
    expect(exitError(failure)).toBeInstanceOf(PublishRejected)
    expect(counts.attempts).toBe(1)
  })

  it('fails fast on permanent 4xx (404 wrong URL — deploy order) without retrying', async () => {
    const counts = { attempts: 0 }
    const failure = await Effect.runPromiseExit(
      uploadBrochure(bytes, target, {
        ...options,
        fetch: async () => {
          counts.attempts++
          return new Response('not found', { status: 404 })
        },
      })
    )
    expect(failure._tag).toBe('Failure')
    const error = exitError(failure) as PublishHttpStatus
    expect(error).toBeInstanceOf(PublishHttpStatus)
    expect(error.status).toBe(404)
    expect(counts.attempts).toBe(1)
  })

  it('retries 5xx with backoff, then succeeds', async () => {
    const counts = { attempts: 0 }
    const exit = await Effect.runPromiseExit(
      uploadBrochure(bytes, target, {
        ...options,
        fetch: async () => {
          counts.attempts++
          if (counts.attempts < 3) return new Response('r2 down', { status: 500 })
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        },
      })
    )
    expect(exit._tag).toBe('Success')
    expect(counts.attempts).toBe(3)
  })

  it('is a no-op in dry-run — the fetch is never called', async () => {
    let called = false
    const exit = await Effect.runPromiseExit(
      uploadBrochure(bytes, target, {
        ...options,
        dryRun: true,
        fetch: async () => {
          called = true
          return new Response('{}', { status: 200 })
        },
      })
    )
    expect(exit._tag).toBe('Success')
    expect(called).toBe(false)
  })

  it('fails with PublishConfigError when the ingest URL or secret is missing', async () => {
    const failure = await Effect.runPromiseExit(
      uploadBrochure(bytes, target, { ...options, ingestUrl: undefined })
    )
    expect(failure._tag).toBe('Failure')
    expect(exitError(failure)).toBeInstanceOf(PublishConfigError)

    const secretFailure = await Effect.runPromiseExit(
      uploadBrochure(bytes, target, { ...options, ingestSecret: undefined })
    )
    expect(secretFailure._tag).toBe('Failure')
    expect(exitError(secretFailure)).toBeInstanceOf(PublishConfigError)
  })

  it('documents the default per-attempt timeout (60s, matching the ingest POST)', () => {
    expect(DEFAULT_BROCHURE_TIMEOUT_MS).toBe(60_000)
  })
})
