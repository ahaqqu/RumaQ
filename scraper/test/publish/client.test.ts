// Publish client tests — dry-run file output, bearer auth, retry/backoff,
// and fail-fast on credential rejection. publishPayload is an Effect —
// driven through Effect.runPromise.

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vite-plus/test'
import { Effect } from 'effect'

import { exitError } from '../helpers.js'

import { publishPayload, PublishRejected } from '../../src/publish/client.js'
import type { IngestPayload } from '../../src/publish/payload.js'

const payload: IngestPayload = {
  schemaVersion: 1,
  scrapedAt: '2026-10-24T23:00:05Z',
  stores: [{ slug: 'superindo', name: 'Superindo', region: 'jakarta', website: null }],
  items: [
    {
      productKey: 'gula-pasir----',
      name: 'Gula Pasir',
      brand: null,
      unit: null,
      category: null,
      storeSlug: 'superindo',
      price: 15000,
      effectiveUnitPrice: null,
      promoType: null,
      promoLabel: null,
      validFrom: null,
      validUntil: null,
      observedDate: '2026-10-24',
      matchMethod: 'solo',
      matchConfidence: 1.0,
      brochureUrl: null,
    },
  ],
}

async function tempStateDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'rumaq-publish-'))
}

describe('publishPayload — dry-run', () => {
  it('writes the payload as JSON into the state dir', async () => {
    const stateDir = await tempStateDir()
    const result = await Effect.runPromise(publishPayload(payload, { stateDir, dryRun: true }))
    expect(result.mode).toBe('dry-run')
    expect(result.payloadFile).toBeDefined()
    const written = JSON.parse(await readFile(result.payloadFile!, 'utf8'))
    expect(written).toEqual(payload)
  })
})

describe('publishPayload — POST', () => {
  it('sends the bearer secret and parses the ingest response', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ accepted: 1, productsCreated: 1, observationsUpserted: 1, skipped: 0 }),
          { status: 200 }
        )
    )
    const result = await Effect.runPromise(
      publishPayload(payload, {
        stateDir: await tempStateDir(),
        dryRun: false,
        ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
        ingestSecret: 's3cret',
        fetch: fetchMock,
        sleep: async () => {},
      })
    )
    expect(result.mode).toBe('published')
    expect(result.response?.accepted).toBe(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.example.com/api/internal/ingest/prices')
    expect(init!.method).toBe('POST')
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer s3cret')
    expect(JSON.parse(init!.body as string)).toEqual(payload)
  })

  it('retries server errors with backoff, then succeeds', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      if (calls < 3) return new Response('boom', { status: 500 })
      return new Response(
        JSON.stringify({ accepted: 0, productsCreated: 0, observationsUpserted: 0, skipped: 0 }),
        { status: 200 }
      )
    })
    const sleep = vi.fn(async () => {})
    const result = await Effect.runPromise(
      publishPayload(payload, {
        stateDir: await tempStateDir(),
        dryRun: false,
        ingestUrl: 'https://api.example.com/ingest',
        ingestSecret: 's3cret',
        fetch: fetchMock,
        sleep,
        retries: 3,
        backoffMs: 1,
      })
    )
    expect(result.mode).toBe('published')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('fails fast on 401 with PublishRejected, without retrying', async () => {
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }))
    const sleep = vi.fn(async () => {})
    const failure = await Effect.runPromiseExit(
      publishPayload(payload, {
        stateDir: await tempStateDir(),
        dryRun: false,
        ingestUrl: 'https://api.example.com/ingest',
        ingestSecret: 'wrong',
        fetch: fetchMock,
        sleep,
        retries: 3,
        backoffMs: 1,
      })
    )
    expect(failure._tag).toBe('Failure')
    expect(exitError(failure)).toBeInstanceOf(PublishRejected)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('fails fast on other permanent 4xx (404) without retrying', async () => {
    const fetchMock = vi.fn(async () => new Response('no such route', { status: 404 }))
    const sleep = vi.fn(async () => {})
    await expect(
      Effect.runPromise(
        publishPayload(payload, {
          stateDir: await tempStateDir(),
          dryRun: false,
          ingestUrl: 'https://api.example.com/wrong-ingest-route',
          ingestSecret: 's3cret',
          fetch: fetchMock,
          sleep,
          retries: 3,
          backoffMs: 1,
        })
      )
    ).rejects.toThrow('HTTP 404')
    expect(fetchMock).toHaveBeenCalledTimes(1) // a dead route never succeeds on retry
    expect(sleep).not.toHaveBeenCalled()
  })

  it('still retries 429 — it is a backoff signal, not a permanent failure', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      return calls < 2
        ? new Response('slow down', { status: 429 })
        : new Response(
            JSON.stringify({
              accepted: 1,
              productsCreated: 1,
              observationsUpserted: 1,
              skipped: 0,
            }),
            { status: 200 }
          )
    })
    const sleep = vi.fn(async () => {})
    const result = await Effect.runPromise(
      publishPayload(payload, {
        stateDir: await tempStateDir(),
        dryRun: false,
        ingestUrl: 'https://api.example.com/ingest',
        ingestSecret: 's3cret',
        fetch: fetchMock,
        sleep,
        retries: 3,
        backoffMs: 1,
      })
    )
    expect(result.mode).toBe('published')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('times out a stalled ingest POST as a retryable PublishError', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const sleep = vi.fn(async () => {})
    await expect(
      Effect.runPromise(
        publishPayload(payload, {
          stateDir: await tempStateDir(),
          dryRun: false,
          ingestUrl: 'https://api.example.com/ingest',
          ingestSecret: 's3cret',
          fetch: fetchMock,
          sleep,
          timeoutMs: 5,
          retries: 2,
          backoffMs: 1,
        })
      )
    ).rejects.toThrow('Ingest POST failed')
    // Timeout aborts surface as PublishError (not a defect) and retry with a
    // fresh signal per attempt.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('requires URL and secret from options or env', async () => {
    const stateDir = await tempStateDir()
    await expect(
      Effect.runPromise(
        publishPayload(payload, {
          stateDir,
          dryRun: false,
          fetch: vi.fn(async () => new Response()),
          sleep: async () => {},
        })
      )
    ).rejects.toThrow('RUMAQ_INGEST_URL not set')

    await expect(
      Effect.runPromise(
        publishPayload(payload, {
          stateDir,
          dryRun: false,
          ingestUrl: 'https://api.example.com/ingest',
          fetch: vi.fn(async () => new Response()),
          sleep: async () => {},
        })
      )
    ).rejects.toThrow('RUMAQ_INGEST_SECRET not set')
  })
})
