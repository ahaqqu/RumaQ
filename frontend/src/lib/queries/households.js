import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getHouseholds,
  createHousehold,
  renameHousehold,
  activateHousehold,
  getHouseholdMembers,
  updateHouseholdMember,
  removeHouseholdMember,
  leaveHousehold,
  getHouseholdInvite,
  createHouseholdInvite,
  joinHousehold,
} from '../api'

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

export function useUpdateHouseholdMember(id) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, payload }) => updateHouseholdMember(id, userId, payload),
    onMutate: async ({ userId, payload }) => {
      const key = ['household-members', id]
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData(key)
      queryClient.setQueryData(key, (old) =>
        old
          ? {
              ...old,
              members: old.members.map((m) => (m.user_id === userId ? { ...m, ...payload } : m)),
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

export function useRemoveHouseholdMember() {
  const queryClient = useQueryClient()
  const revalidateEverything = useRevalidateEverything()
  return useMutation({
    mutationFn: ({ id, userId }) => removeHouseholdMember(id, userId),
    onMutate: async ({ id, userId }) => {
      const key = ['household-members', id]
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData(key)
      queryClient.setQueryData(key, (old) =>
        old ? { ...old, members: old.members.filter((m) => m.user_id !== userId) } : old
      )
      return { previous }
    },
    onError: (_err, vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(['household-members', vars.id], context.previous)
      }
    },
    onSettled: () => {
      // Member counts on the households list change; a removed member's own
      // session falls back to another household.
      queryClient.invalidateQueries({ queryKey: HOUSEHOLDS_KEY })
      revalidateEverything()
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
  const revalidateEverything = useRevalidateEverything()
  return useMutation({
    mutationFn: (code) => joinHousehold(code),
    onSettled: () => {
      revalidateEverything()
    },
  })
}
