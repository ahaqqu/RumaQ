import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getTasks, createTask, patchTask, deleteTask } from '../api'

// Household tasks (ahaqqu/RumaQ#429) — server-state for the family task
// board and the per-member "My tasks" view. Both ride the same endpoint; the
// filter pair (mine/assignee + status) is part of the query key, so switching
// views re-fetches against the scoped endpoint (server-side filtering — the
// documents pattern).

const TASKS_KEY = ['tasks']

// The BARE base key for invalidations (the documents review-delta precedent):
// react-query prefix-matches array keys, so invalidating ['tasks'] reaches
// EVERY filtered view — a completion is visible on the household board AND in
// "My tasks", and both must refresh on settle.
export const TASKS_BASE_KEY = TASKS_KEY

export function tasksQueryKey(filters = {}) {
  const { assignee, status, mine } = filters
  return [TASKS_KEY[0], { assignee: assignee ?? null, status: status ?? null, mine: mine ?? null }]
}

export function useTasks(filters = {}) {
  const { assignee, status, mine } = filters
  return useQuery({
    queryKey: tasksQueryKey({ assignee, status, mine }),
    queryFn: ({ signal }) => getTasks({ assignee, status, mine }, signal),
    staleTime: 1000 * 30,
  })
}

// Create: free-text title + optional assignee (any household member, both
// modes), due date, recurrence. The backend derives needs_approval from the
// assignee's mode — the client never sends it.
export function useCreateTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload) => createTask(payload),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: TASKS_KEY })
    },
  })
}

// The one PATCH endpoint, three actions: edit fields; complete
// ({ status: 'done' }); approve ({ approve: true }). Recurring tasks roll
// their due date forward server-side and come back still open — the whole
// cache invalidates on settle so every view reconciles.
export function useUpdateTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }) => patchTask(id, payload),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: TASKS_KEY })
    },
  })
}

export function useDeleteTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }) => deleteTask(id),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: TASKS_KEY })
    },
  })
}
