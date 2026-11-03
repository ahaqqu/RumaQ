import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getHouseholds,
  createHousehold,
  renameHousehold,
  activateHousehold,
  getHouseholdMembers,
  createHouseholdMember,
  updateHouseholdMember,
  removeHouseholdMember,
  leaveHousehold,
  getHouseholdInvite,
  createHouseholdInvite,
  joinHousehold,
} from '../api'
import { useMe } from './me.js'

const HOUSEHOLDS_KEY = ['households']

// Switching the active household (or leaving one) changes what every
// household-scoped view shows — inventory, plans, purchases, history, home —
// so the settle hook invalidates the whole cache rather than enumerating keys.
function useRevalidateEverything() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries()
}

export function useHouseholds() {
  return useQuery({
    queryKey: HOUSEHOLDS_KEY,
    queryFn: ({ signal }) => getHouseholds(signal),
    staleTime: 1000 * 30,
  })
}

export function useCreateHousehold() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name) => createHousehold(name),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: HOUSEHOLDS_KEY })
    },
  })
}

export function useRenameHousehold() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }) => renameHousehold(id, name),
    onMutate: async ({ id, name }) => {
      await queryClient.cancelQueries({ queryKey: HOUSEHOLDS_KEY })
      const previous = queryClient.getQueryData(HOUSEHOLDS_KEY)
      queryClient.setQueryData(HOUSEHOLDS_KEY, (old) =>
        old
          ? { ...old, households: old.households.map((h) => (h.id === id ? { ...h, name } : h)) }
          : old
      )
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(HOUSEHOLDS_KEY, context.previous)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: HOUSEHOLDS_KEY })
    },
  })
}

export function useActivateHousehold() {
  const queryClient = useQueryClient()
  const revalidateEverything = useRevalidateEverything()
  return useMutation({
    mutationFn: (id) => activateHousehold(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: HOUSEHOLDS_KEY })
      const previous = queryClient.getQueryData(HOUSEHOLDS_KEY)
      queryClient.setQueryData(HOUSEHOLDS_KEY, (old) =>
        old
          ? {
              ...old,
              households: old.households.map((h) => ({ ...h, is_active: h.id === id })),
            }
          : old
      )
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(HOUSEHOLDS_KEY, context.previous)
      }
    },
    onSettled: () => {
      // Everything household-scoped re-reads against the new active id.
      revalidateEverything()
    },
  })
}

export function useHouseholdMembers(id) {
  return useQuery({
    queryKey: ['household-members', id],
    queryFn: ({ signal }) => getHouseholdMembers(id, signal),
    enabled: Boolean(id),
  })
}

// Member-addressed mutations key on the surrogate member id (#388) —
// profile-only members have no user_id, and the row keeps its identity when
// an account is attached later.
export function useUpdateHouseholdMember(id) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ memberId, payload }) => updateHouseholdMember(id, memberId, payload),
    onMutate: async ({ memberId, payload }) => {
      const key = ['household-members', id]
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData(key)
      queryClient.setQueryData(key, (old) =>
        old
          ? {
              ...old,
              members: old.members.map((m) => (m.id === memberId ? { ...m, ...payload } : m)),
            }
          : old
      )
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(['household-members', id], context.previous)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['household-members', id] })
    },
  })
}

// Creates a profile-only member (Mode B, #388) — a person with no account.
export function useCreateHouseholdMember(id) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload) => createHouseholdMember(id, payload),
    onSettled: () => {
      // The roster gains a row and the household's member_count grows.
      queryClient.invalidateQueries({ queryKey: HOUSEHOLDS_KEY })
      queryClient.invalidateQueries({ queryKey: ['household-members', id] })
    },
  })
}

export function useRemoveHouseholdMember() {
  const queryClient = useQueryClient()
  const revalidateEverything = useRevalidateEverything()
  const { data: me } = useMe()
  return useMutation({
    mutationFn: ({ id, memberId }) => removeHouseholdMember(id, memberId),
    onMutate: async ({ id, memberId }) => {
      const key = ['household-members', id]
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData(key)
      queryClient.setQueryData(key, (old) =>
        old ? { ...old, members: old.members.filter((m) => m.id !== memberId) } : old
      )
      return { previous }
    },
    onError: (_err, vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(['household-members', vars.id], context.previous)
      }
    },
    onSettled: (_data, _err, vars) => {
      // Removing someone else changes only the roster and the list's member
      // counts — the caller's other cached data is untouched (review B6).
      queryClient.invalidateQueries({ queryKey: HOUSEHOLDS_KEY })
      queryClient.invalidateQueries({ queryKey: ['household-members', vars.id] })
      // The full sweep is for the rare case the caller removed a member
      // LINKED TO THEMSELVES (every household-scoped view just changed for
      // them). Profile-only members have no session to strand.
      if (me?.user?.id && vars.selfUserId === me.user.id) {
        revalidateEverything()
      }
    },
  })
}

export function useLeaveHousehold() {
  const revalidateEverything = useRevalidateEverything()
  return useMutation({
    mutationFn: (id) => leaveHousehold(id),
    onSettled: () => {
      revalidateEverything()
    },
  })
}

export function useHouseholdInvite(id) {
  return useQuery({
    queryKey: ['household-invite', id],
    queryFn: ({ signal }) => getHouseholdInvite(id, signal),
    enabled: Boolean(id),
    staleTime: 1000 * 30,
  })
}

export function useCreateHouseholdInvite(id) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => createHouseholdInvite(id),
    onSuccess: (data) => {
      queryClient.setQueryData(['household-invite', id], data)
    },
  })
}

export function useJoinHousehold() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (code) => joinHousehold(code),
    onSettled: () => {
      // Joining adds a membership and nothing else: the active household is
      // switched explicitly afterwards, so only the list is stale (review B6).
      queryClient.invalidateQueries({ queryKey: HOUSEHOLDS_KEY })
    },
  })
}
