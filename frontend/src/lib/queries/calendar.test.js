import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import {
  useCalendar,
  useCreateCalendarEvent,
  useUpdateCalendarEvent,
  useDeleteCalendarEvent,
} from './calendar.js'
import { getCalendar, createCalendarEvent, patchCalendarEvent, deleteCalendarEvent } from '../api'

vi.mock('../api', () => ({
  getCalendar: vi.fn(),
  createCalendarEvent: vi.fn(),
  patchCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
}))

function createWrapper(queryClient) {
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

// The month window rides the query key as its own filter dimension (the
// tasks/documents pattern) — paging months re-fetches against the scoped
// endpoint.
describe('useCalendar', () => {
  it('passes the window to the endpoint and rides it in the query key', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    getCalendar.mockResolvedValue({ entries: [] })
    const { result } = renderHook(() => useCalendar({ from: '2026-11-01', to: '2026-11-30' }), {
      wrapper: createWrapper(queryClient),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(getCalendar.mock.calls[0][0]).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    expect(
      queryClient.getQueryData(['calendar', { from: '2026-11-01', to: '2026-11-30' }])
    ).toEqual({ entries: [] })
  })
})

describe('calendar mutations', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // Two month windows seeded — the bare base key must reach both (the
    // whole-cache invalidation discipline: an event edit changes every month
    // view the user can flip back to).
    queryClient.setQueryData(['calendar', { from: '2026-11-01', to: '2026-11-30' }], {
      entries: [{ id: 'e1' }],
    })
    queryClient.setQueryData(['calendar', { from: '2026-12-01', to: '2026-12-31' }], {
      entries: [],
    })
    vi.clearAllMocks()
  })

  it('create sends the payload and invalidates every month window on settle', async () => {
    createCalendarEvent.mockResolvedValue({ event: { id: 'e2' } })
    const { result } = renderHook(() => useCreateCalendarEvent(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () =>
      result.current.mutate({
        title: 'Mudik checklist',
        date: '2026-12-18',
        time: null,
        visibility: 'members',
        member_ids: ['m-anak'],
      })
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(createCalendarEvent).toHaveBeenCalledWith({
      title: 'Mudik checklist',
      date: '2026-12-18',
      time: null,
      visibility: 'members',
      member_ids: ['m-anak'],
    })
    expect(
      queryClient.getQueryState(['calendar', { from: '2026-11-01', to: '2026-11-30' }])
        .isInvalidated
    ).toBe(true)
    expect(
      queryClient.getQueryState(['calendar', { from: '2026-12-01', to: '2026-12-31' }])
        .isInvalidated
    ).toBe(true)
  })

  it('update patches the id + payload and invalidates on settle', async () => {
    patchCalendarEvent.mockResolvedValue({ event: { id: 'e1' } })
    const { result } = renderHook(() => useUpdateCalendarEvent(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () =>
      result.current.mutate({ id: 'e1', payload: { title: 'Updated', time: null } })
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(patchCalendarEvent).toHaveBeenCalledWith('e1', { title: 'Updated', time: null })
    expect(
      queryClient.getQueryState(['calendar', { from: '2026-11-01', to: '2026-11-30' }])
        .isInvalidated
    ).toBe(true)
  })

  it('delete removes by id and invalidates on settle — failure included', async () => {
    deleteCalendarEvent.mockResolvedValue(null)
    const { result } = renderHook(() => useDeleteCalendarEvent(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ id: 'e1' }))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(deleteCalendarEvent).toHaveBeenCalledWith('e1')
    expect(
      queryClient.getQueryState(['calendar', { from: '2026-11-01', to: '2026-11-30' }])
        .isInvalidated
    ).toBe(true)

    deleteCalendarEvent.mockRejectedValue(new Error('refused'))
    await act(async () => result.current.mutate({ id: 'e1' }))
    await waitFor(() => expect(result.current.isError).toBe(true))
    // onSettled fires on failure too — every view reconciles, no stale state.
    expect(
      queryClient.getQueryState(['calendar', { from: '2026-12-01', to: '2026-12-31' }])
        .isInvalidated
    ).toBe(true)
  })
})
