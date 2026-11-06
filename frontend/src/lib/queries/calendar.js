import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getCalendar, createCalendarEvent, patchCalendarEvent, deleteCalendarEvent } from '../api'

// Household calendar (ahaqqu/RumaQ#430) — server-state for the shared family
// calendar. The read is the UNION view (stored events + derived document
// deadlines); the month window is part of the query key, so paging months
// re-fetches against the scoped endpoint (server-side filtering — the tasks/
// documents pattern).

const CALENDAR_KEY = ['calendar']

// The BARE base key for invalidations (the tasks/documents precedent):
// react-query prefix-matches array keys, so invalidating ['calendar'] reaches
// EVERY month window — an event edit is visible in the grid, the day list,
// and any other month the user flips back to.
export const CALENDAR_BASE_KEY = CALENDAR_KEY

export function calendarQueryKey(filters = {}) {
  const { from, to } = filters
  return [CALENDAR_KEY[0], { from: from ?? null, to: to ?? null }]
}

export function useCalendar(filters = {}) {
  const { from, to } = filters
  return useQuery({
    queryKey: calendarQueryKey({ from, to }),
    queryFn: ({ signal }) => getCalendar({ from, to }, signal),
    staleTime: 1000 * 30,
  })
}

// Create: free-text title + real date (+ optional HH:MM time), visibility
// 'all' (default) or 'members' with a non-empty member_ids audience. The
// backend validates every reference against the household; the client just
// sends the shape.
export function useCreateCalendarEvent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload) => createCalendarEvent(payload),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: CALENDAR_KEY })
    },
  })
}

export function useUpdateCalendarEvent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }) => patchCalendarEvent(id, payload),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: CALENDAR_KEY })
    },
  })
}

export function useDeleteCalendarEvent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }) => deleteCalendarEvent(id),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: CALENDAR_KEY })
    },
  })
}
