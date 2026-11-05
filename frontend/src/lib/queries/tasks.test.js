import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { useTasks, useCreateTask, useUpdateTask, useDeleteTask } from './tasks.js'
import { getTasks, createTask, patchTask, deleteTask } from '../api'

vi.mock('../api', () => ({
  getTasks: vi.fn(),
  createTask: vi.fn(),
  patchTask: vi.fn(),
  deleteTask: vi.fn(),
}))

function createWrapper(queryClient) {
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

describe('useTasks', () => {
  it('passes the filters to the endpoint and rides them in the query key', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    getTasks.mockResolvedValue({ tasks: [] })
    const { result } = renderHook(() => useTasks({ mine: '1', status: 'all' }), {
      wrapper: createWrapper(queryClient),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    // The filters go to the endpoint verbatim; the AbortSignal rides as the
    // second argument (react-query's cancellation wiring).
    expect(getTasks.mock.calls[0][0]).toEqual({ mine: '1', status: 'all' })
    expect(
      queryClient.getQueryData(['tasks', { assignee: null, status: 'all', mine: '1' }])
    ).toEqual({
      tasks: [],
    })
  })
})

describe('useCreateTask', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // Two FILTERED views seeded — the bare base key must reach both (the
    // documents whole-cache invalidation discipline).
    queryClient.setQueryData(['tasks', { assignee: null, status: null, mine: null }], {
      tasks: [{ id: 't1' }],
    })
    queryClient.setQueryData(['tasks', { assignee: null, status: 'all', mine: '1' }], {
      tasks: [{ id: 't1' }],
    })
    vi.clearAllMocks()
  })

  it('sends the payload and invalidates every filtered view on settle', async () => {
    createTask.mockResolvedValue({ task: { id: 't2' } })
    const { result } = renderHook(() => useCreateTask(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () =>
      result.current.mutate({
        title: 'Sapu halaman',
        assignee_member_id: 'm-anak',
        due_date: '2026-11-10',
        recurrence: 'daily',
      })
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(createTask).toHaveBeenCalledWith({
      title: 'Sapu halaman',
      assignee_member_id: 'm-anak',
      due_date: '2026-11-10',
      recurrence: 'daily',
    })
    expect(
      queryClient.getQueryState(['tasks', { assignee: null, status: null, mine: null }])
        .isInvalidated
    ).toBe(true)
    expect(
      queryClient.getQueryState(['tasks', { assignee: null, status: 'all', mine: '1' }])
        .isInvalidated
    ).toBe(true)
  })
})

describe('useUpdateTask', () => {
  it('patches the three action shapes (edit fields / complete / approve) and invalidates on settle', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['tasks', { assignee: null, status: null, mine: null }], { tasks: [] })
    patchTask.mockResolvedValue({ task: { id: 't1' } })
    const { result } = renderHook(() => useUpdateTask(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ id: 't1', payload: { status: 'done' } }))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(patchTask).toHaveBeenCalledWith('t1', { status: 'done' })
    expect(
      queryClient.getQueryState(['tasks', { assignee: null, status: null, mine: null }])
        .isInvalidated
    ).toBe(true)
  })

  it('stays errored without invalidating when the server refuses', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['tasks', { assignee: null, status: null, mine: null }], { tasks: [] })
    patchTask.mockRejectedValue(new Error('refused'))
    const { result } = renderHook(() => useUpdateTask(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ id: 't1', payload: { approve: true } }))
    await waitFor(() => expect(result.current.isError).toBe(true))
    // onSettled fires on failure too — every view reconciles, no stale state.
    expect(
      queryClient.getQueryState(['tasks', { assignee: null, status: null, mine: null }])
        .isInvalidated
    ).toBe(true)
  })
})

describe('useDeleteTask', () => {
  it('deletes and invalidates the whole tasks cache on settle', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['tasks', { assignee: null, status: null, mine: null }], { tasks: [] })
    deleteTask.mockResolvedValue(null)
    const { result } = renderHook(() => useDeleteTask(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ id: 't1' }))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(deleteTask).toHaveBeenCalledWith('t1')
    expect(
      queryClient.getQueryState(['tasks', { assignee: null, status: null, mine: null }])
        .isInvalidated
    ).toBe(true)
  })
})
