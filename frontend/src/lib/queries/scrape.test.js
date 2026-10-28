import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { useScrapeEvents, useTriggerScrape } from './scrape.js'
import { getScrapeEvents, createScrape } from '../api'

vi.mock('../api', () => ({
  getScrapeStores: vi.fn(),
  createScrape: vi.fn(),
  getScrapeCommands: vi.fn(),
  getScrapeEvents: vi.fn(),
}))

const COMMANDS_KEY = ['scrape', 'commands']

function mockCommand(overrides = {}) {
  return {
    id: 'cmd-1',
    stores: ['superindo'],
    status: 'running',
    createdBy: 'op@rumaq.dev',
    createdAt: '2026-10-29T01:00:00.000Z',
    pickedUpAt: '2026-10-29T01:00:05.000Z',
    finishedAt: null,
    exitCode: null,
    error: null,
    logTruncated: false,
    ...overrides,
  }
}

function createWrapper(queryClient) {
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

describe('useScrapeEvents', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    vi.clearAllMocks()
  })

  it('fetches the full log first (no afterSeq), then polls incrementally', async () => {
    getScrapeEvents.mockResolvedValueOnce({
      events: [
        { seq: 0, ts: '2026-10-29T01:00:06.000Z', level: 'info', message: 'starting run' },
        { seq: 1, ts: '2026-10-29T01:01:00.000Z', level: 'info', message: 'store superindo ok' },
      ],
      truncated: false,
    })

    const { result } = renderHook(() => useScrapeEvents(mockCommand()), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    // Absent afterSeq = full log (seq > -1 server-side).
    expect(getScrapeEvents).toHaveBeenCalledWith(
      'cmd-1',
      { afterSeq: undefined },
      expect.anything()
    )

    getScrapeEvents.mockResolvedValueOnce({
      events: [{ seq: 2, ts: '2026-10-29T01:02:00.000Z', level: 'error', message: 'boom' }],
      truncated: false,
    })
    await act(async () => {
      await result.current.refetch()
    })
    // Incremental poll: only the delta after the last seen seq.
    expect(getScrapeEvents).toHaveBeenLastCalledWith('cmd-1', { afterSeq: 1 }, expect.anything())
    // The merge lands in the cache (the observer snapshot can lag in act).
    const cacheKey = ['scrape', 'commands', 'cmd-1', 'events']
    await waitFor(() =>
      expect(queryClient.getQueryData(cacheKey).events.map((event) => event.seq)).toEqual([0, 1, 2])
    )
  })

  it('keeps the truncated flag once the server reported a dropped log head', async () => {
    getScrapeEvents.mockResolvedValueOnce({ events: [], truncated: true })

    const { result } = renderHook(() => useScrapeEvents(mockCommand()), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data.truncated).toBe(true)

    getScrapeEvents.mockResolvedValueOnce({ events: [], truncated: false })
    await act(async () => {
      await result.current.refetch()
    })
    const cacheKey = ['scrape', 'commands', 'cmd-1', 'events']
    await waitFor(() => expect(queryClient.getQueryData(cacheKey).truncated).toBe(true))
  })

  it('catches up one final poll when the command leaves the active set', async () => {
    getScrapeEvents.mockResolvedValue({
      events: [{ seq: 0, ts: '2026-10-29T01:00:06.000Z', level: 'info', message: 'line' }],
      truncated: false,
    })

    const { result, rerender } = renderHook(({ command }) => useScrapeEvents(command), {
      initialProps: { command: mockCommand({ status: 'running' }) },
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(getScrapeEvents).toHaveBeenCalledTimes(1)

    rerender({ command: mockCommand({ status: 'success', finishedAt: '2026-10-29T01:02:00Z' }) })

    // The finish may land between two polls — the catch-up invalidation makes
    // sure the log tail (often the error line) is fetched exactly once more.
    await waitFor(() => expect(getScrapeEvents).toHaveBeenCalledTimes(2))
    expect(getScrapeEvents).toHaveBeenLastCalledWith('cmd-1', { afterSeq: 0 }, expect.anything())
  })
})

describe('useTriggerScrape', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(COMMANDS_KEY, { commands: [] })
    vi.clearAllMocks()
  })

  it('queues the selected stores and invalidates the command feed on settle', async () => {
    createScrape.mockResolvedValue({ id: 'cmd-2' })

    const { result } = renderHook(() => useTriggerScrape(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      result.current.mutate(['superindo', 'astro'])
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(createScrape).toHaveBeenCalledWith(['superindo', 'astro'])
    expect(queryClient.getQueryState(COMMANDS_KEY).isInvalidated).toBe(true)
  })
})
