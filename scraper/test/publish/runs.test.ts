// Run-report client tests — derived runs URL, bearer auth, no-op when
// unconfigured, and one retry before giving up. postRunReport is an Effect —
// driven through Effect.runPromise.

import { describe, expect, it, vi } from 'vite-plus/test'
import { Effect } from 'effect'

import { deriveRunsUrl, postRunReport } from '../../src/publish/runs.js'
import type { RunReport } from '@rumaq/contract'

const report: RunReport = {
  schemaVersion: 1,
  runStartedAt: '2026-10-26T23:00:05Z',
  finishedAt: '2026-10-26T23:04:11Z',
  exitCode: 0,
  status: 'success',
  stage: 'done',
  perStore: {
    superindo: {
      pagesFound: 2,
      newImages: 1,
      existingImages: 1,
      skipped: 0,
      itemsExtracted: 7,
      itemsRejected: 0,
    },
  },
  match: null,
  publish: { mode: 'published', accepted: 7, skipped: 0 },
  error: null,
}

describe('deriveRunsUrl', () => {
  it('swaps the prices path segment for runs', () => {
    expect(deriveRunsUrl('https://api.example.com/api/internal/ingest/prices')).toBe(
      'https://api.example.com/api/internal/ingest/runs'
    )
  })

  it('leaves unrelated URLs untouched', () => {
    expect(deriveRunsUrl('https://api.example.com/other')).toBe('https://api.example.com/other')
  })
})

describe('postRunReport', () => {
  it('posts the report with the bearer secret to the derived runs URL', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await Effect.runPromise(
      postRunReport(report, {
        ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
        ingestSecret: 's3cret',
        fetch: fetchMock,
        sleep: () => Promise.resolve(),
      })
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.example.com/api/internal/ingest/runs')
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer s3cret')
    expect(JSON.parse(init!.body as string)).toEqual(report)
  })

  it('honors an explicit runsUrl override', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await Effect.runPromise(
      postRunReport(report, {
        ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
        ingestSecret: 's3cret',
        runsUrl: 'https://api.example.com/custom/runs',
        fetch: fetchMock,
        sleep: () => Promise.resolve(),
      })
    )
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.example.com/custom/runs')
  })

  it('is a no-op when no ingest config is available', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    await Effect.runPromise(postRunReport(report, { fetch: fetchMock }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retries once on a server error, then surfaces the failure', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }))
    const sleeps: number[] = []
    const exit = await Effect.runPromiseExit(
      postRunReport(report, {
        ingestUrl: 'https://api.example.com/api/internal/ingest/prices',
        ingestSecret: 's3cret',
        fetch: fetchMock,
        sleep: (ms) => {
          sleeps.push(ms)
          return Promise.resolve()
        },
      })
    )
    expect(exit._tag).toBe('Failure')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleeps).toHaveLength(1)
  })
})
