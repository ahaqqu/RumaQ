import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import {
  useCreateHousehold,
  useRenameHousehold,
  useActivateHousehold,
  useUpdateHouseholdMember,
  useRemoveHouseholdMember,
  useCreateHouseholdInvite,
  useJoinHousehold,
} from './households.js'
import { useMe } from './me.js'
import {
  createHousehold,
  renameHousehold,
  activateHousehold,
  updateHouseholdMember,
  removeHouseholdMember,
  createHouseholdInvite,
  joinHousehold,
} from '../api'

vi.mock('../api', () => ({
  getHouseholds: vi.fn(),
  createHousehold: vi.fn(),
  renameHousehold: vi.fn(),
  activateHousehold: vi.fn(),
  getHouseholdMembers: vi.fn(),
  updateHouseholdMember: vi.fn(),
  removeHouseholdMember: vi.fn(),
  leaveHousehold: vi.fn(),
  getHouseholdInvite: vi.fn(),
  createHouseholdInvite: vi.fn(),
  joinHousehold: vi.fn(),
}))

// The remove hook reads the session (useMe) to detect a self-removal — the
// one case that must sweep the whole cache (review B6).
vi.mock('./me.js', () => ({ useMe: vi.fn() }))

const HOUSEHOLDS_KEY = ['households']
const MEMBERS_KEY = ['household-members', 'h1']
const INVITE_KEY = ['household-invite', 'h1']

function createWrapper(queryClient) {
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

const HOUSEHOLDS = {
  households: [
    { id: 'h1', name: 'Keluarga Putri', role: 'owner', member_count: 4, is_active: true },
    { id: 'h2', name: 'Rumah Bunda', role: 'member', member_count: 2, is_active: false },
  ],
}

describe('useRenameHousehold', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(HOUSEHOLDS_KEY, HOUSEHOLDS)
    vi.clearAllMocks()
  })

  it('renames optimistically before the server responds', async () => {
    let resolveRename
    renameHousehold.mockReturnValue(new Promise((resolve) => (resolveRename = resolve)))

    const { result } = renderHook(() => useRenameHousehold(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ id: 'h1', name: 'Baru' }))

    expect(queryClient.getQueryData(HOUSEHOLDS_KEY).households[0].name).toBe('Baru')

    await act(async () => resolveRename({ household: { id: 'h1', name: 'Baru' } }))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  it('rolls back the rename when the mutation fails', async () => {
    renameHousehold.mockRejectedValue(new Error('fail'))
    const { result } = renderHook(() => useRenameHousehold(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ id: 'h1', name: 'Baru' }))
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(queryClient.getQueryData(HOUSEHOLDS_KEY).households[0].name).toBe('Keluarga Putri')
  })
})

describe('useCreateHousehold', () => {
  it('invalidates the households list on settle', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(HOUSEHOLDS_KEY, HOUSEHOLDS)
    createHousehold.mockResolvedValue({ household: { id: 'h3', name: 'Kedua' } })
    const { result } = renderHook(() => useCreateHousehold(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate('Kedua'))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(queryClient.getQueryState(HOUSEHOLDS_KEY).isInvalidated).toBe(true)
  })
})

describe('useActivateHousehold', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(HOUSEHOLDS_KEY, HOUSEHOLDS)
    vi.clearAllMocks()
  })

  it('moves the active flag optimistically to the chosen household', async () => {
    let resolveActivate
    activateHousehold.mockReturnValue(new Promise((resolve) => (resolveActivate = resolve)))

    const { result } = renderHook(() => useActivateHousehold(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate('h2'))

    const cached = queryClient.getQueryData(HOUSEHOLDS_KEY)
    expect(cached.households.find((h) => h.id === 'h1').is_active).toBe(false)
    expect(cached.households.find((h) => h.id === 'h2').is_active).toBe(true)

    await act(async () => resolveActivate({ active_household_id: 'h2' }))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  it('rolls back when the activation fails', async () => {
    activateHousehold.mockRejectedValue(new Error('fail'))
    const { result } = renderHook(() => useActivateHousehold(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate('h2'))
    await waitFor(() => expect(result.current.isError).toBe(true))
    const cached = queryClient.getQueryData(HOUSEHOLDS_KEY)
    expect(cached.households.find((h) => h.id === 'h1').is_active).toBe(true)
    expect(cached.households.find((h) => h.id === 'h2').is_active).toBe(false)
  })
})

describe('useUpdateHouseholdMember', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(MEMBERS_KEY, {
      members: [{ user_id: 'u2', display_name: null, birth_date: null }],
    })
    vi.clearAllMocks()
  })

  it('patches the member optimistically and rolls back on failure', async () => {
    updateHouseholdMember.mockRejectedValue(new Error('fail'))
    const { result } = renderHook(() => useUpdateHouseholdMember('h1'), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () =>
      result.current.mutate({ userId: 'u2', payload: { display_name: 'Putri' } })
    )
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(queryClient.getQueryData(MEMBERS_KEY).members[0].display_name).toBeNull()
  })

  it('keeps the optimistic patch when the server confirms', async () => {
    let resolveUpdate
    updateHouseholdMember.mockReturnValue(new Promise((resolve) => (resolveUpdate = resolve)))
    const { result } = renderHook(() => useUpdateHouseholdMember('h1'), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () =>
      result.current.mutate({ userId: 'u2', payload: { display_name: 'Putri' } })
    )
    expect(queryClient.getQueryData(MEMBERS_KEY).members[0].display_name).toBe('Putri')
    await act(async () => resolveUpdate({ member: { user_id: 'u2', display_name: 'Putri' } }))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })
})

describe('useRemoveHouseholdMember', () => {
  it('removes optimistically and invalidates households (member counts) on settle', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(MEMBERS_KEY, {
      members: [
        { user_id: 'u1', display_name: null },
        { user_id: 'u2', display_name: 'Putri' },
      ],
    })
    queryClient.setQueryData(HOUSEHOLDS_KEY, HOUSEHOLDS)
    removeHouseholdMember.mockResolvedValue({ ok: true })
    useMe.mockReturnValue({ data: { user: { id: 'u1' } } })

    const { result } = renderHook(() => useRemoveHouseholdMember(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ id: 'h1', userId: 'u2' }))
    expect(queryClient.getQueryData(MEMBERS_KEY).members).toHaveLength(1)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(queryClient.getQueryState(HOUSEHOLDS_KEY).isInvalidated).toBe(true)
  })

  it('sweeps the whole cache only when the caller removed themselves', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(MEMBERS_KEY, { members: [{ user_id: 'u2', display_name: 'P' }] })
    queryClient.setQueryData(HOUSEHOLDS_KEY, HOUSEHOLDS)
    queryClient.setQueryData(['stock'], { stock: [] })
    removeHouseholdMember.mockResolvedValue({ ok: true })
    useMe.mockReturnValue({ data: { user: { id: 'u1' } } })

    const { result } = renderHook(() => useRemoveHouseholdMember(), {
      wrapper: createWrapper(queryClient),
    })
    // Removing someone else: scoped keys only, other views untouched.
    await act(async () => result.current.mutate({ id: 'h1', userId: 'u2' }))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(queryClient.getQueryState(HOUSEHOLDS_KEY).isInvalidated).toBe(true)
    expect(queryClient.getQueryState(MEMBERS_KEY).isInvalidated).toBe(true)
    expect(queryClient.getQueryState(['stock']).isInvalidated).toBe(false)

    // Self-removal (owner removed via API): every household-scoped view
    // changed for them — the full sweep is justified.
    await act(async () => result.current.mutate({ id: 'h1', userId: 'u1' }))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(queryClient.getQueryState(['stock']).isInvalidated).toBe(true)
  })

  it('rolls back the removal on failure', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(MEMBERS_KEY, { members: [{ user_id: 'u2', display_name: 'Putri' }] })
    removeHouseholdMember.mockRejectedValue(new Error('fail'))
    useMe.mockReturnValue({ data: { user: { id: 'u1' } } })

    const { result } = renderHook(() => useRemoveHouseholdMember(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ id: 'h1', userId: 'u2' }))
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(queryClient.getQueryData(MEMBERS_KEY).members).toHaveLength(1)
  })
})

describe('useCreateHouseholdInvite', () => {
  it('seeds the invite cache with the fresh code', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(INVITE_KEY, { invite: null })
    createHouseholdInvite.mockResolvedValue({
      invite: { id: 'inv1', code: 'ABC2345678', expires_at: '2026-11-10 00:00:00' },
    })

    const { result } = renderHook(() => useCreateHouseholdInvite('h1'), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(queryClient.getQueryData(INVITE_KEY).invite.code).toBe('ABC2345678')
  })
})

describe('useJoinHousehold', () => {
  it('invalidates the households list only (join never switches the active household)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(HOUSEHOLDS_KEY, HOUSEHOLDS)
    queryClient.setQueryData(['stock'], { stock: [] })
    joinHousehold.mockResolvedValue({
      household: { id: 'h9', name: 'Baru' },
      already_member: false,
    })

    const { result } = renderHook(() => useJoinHousehold(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate('ABC2345678'))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(queryClient.getQueryState(HOUSEHOLDS_KEY).isInvalidated).toBe(true)
    // The active household is unchanged by a join — scoped views stay valid
    // until the user explicitly switches (review B6).
    expect(queryClient.getQueryState(['stock']).isInvalidated).toBe(false)
  })
})
