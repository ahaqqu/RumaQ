import { useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getScrapeStores, createScrape, getScrapeCommands, getScrapeEvents } from '../api'

// One run at a time — a pending/running command blocks new ones (and flips
// every consumer into its fast polling cadence).
const ACTIVE_STATUSES = new Set(['pending', 'running'])

export function useScrapeStores() {
  return useQuery({
    queryKey: ['scrape', 'stores'],
    queryFn: ({ signal }) => getScrapeStores(signal),
    staleTime: 1000 * 60 * 10,
  })
}

// Fast (5s) while any command is pending/running so a queued trigger shows up
// promptly; slow (60s) idling otherwise — mirrors usePriceRuns.
export function useScrapeCommands() {
  return useQuery({
    queryKey: ['scrape', 'commands'],
    queryFn: ({ signal }) => getScrapeCommands({ limit: 20 }, signal),
    refetchInterval: (query) => {
      const commands = query.state.data?.commands ?? []
      const active = commands.some((command) => ACTIVE_STATUSES.has(command.status))
      return active ? 1000 * 5 : 1000 * 60
    },
  })
}

// The log accumulates in the cache: the first fetch omits afterSeq (full log,
// including the server-side truncated tail); later polls send
// afterSeq=<last seen seq> so only fresh lines cross the wire.
export function useScrapeEvents(command) {
  const queryClient = useQueryClient()
  const commandId = command?.id
  const active = Boolean(commandId && ACTIVE_STATUSES.has(command.status))
  const wasActive = useRef(false)

  const query = useQuery({
    queryKey: ['scrape', 'commands', commandId, 'events'],
    enabled: Boolean(commandId),
    refetchInterval: active ? 1000 * 2 : false,
    staleTime: active ? 1000 : 1000 * 60,
    queryFn: async ({ signal, queryKey }) => {
      const previous = queryClient.getQueryData(queryKey)
      const events = previous?.events ?? []
      const lastSeq = events.length > 0 ? events[events.length - 1].seq : undefined
      const feed = await getScrapeEvents(commandId, { afterSeq: lastSeq }, signal)
      if (!previous) return feed
      return {
        events: [...events, ...(feed?.events ?? [])],
        truncated: Boolean(previous.truncated) || Boolean(feed?.truncated),
      }
    },
  })

  // The agent posts every event before the terminal finish, so a command can
  // go terminal between two polls — one catch-up fetch guarantees the log
  // tail (often the error line) lands before polling stops.
  useEffect(() => {
    if (active) {
      wasActive.current = true
    } else if (wasActive.current) {
      wasActive.current = false
      queryClient.invalidateQueries({ queryKey: ['scrape', 'commands', commandId, 'events'] })
    }
  }, [active, commandId, queryClient])

  return query
}

export function useTriggerScrape() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (stores) => createScrape(stores),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['scrape', 'commands'] })
    },
  })
}
