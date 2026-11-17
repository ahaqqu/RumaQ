import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getReviewItems,
  decideReviewItem,
  undoReviewDecision,
  getReviewMode,
  setReviewMode,
  evaluateReviewItems,
  acknowledgeTaxonomy,
} from '../api'

// Match review queue queries (issue #294). The list is a work queue that
// drains top-down, so pagination is a plain offset append ("Load more") —
// last_flagged_at mutates via upsert, which rules out a cursor anyway.

export const REVIEW_PAGE_SIZE = 50

// Counts + filteredTotal are exact server-side GROUP BYs, identical on every
// page — reading them from the FIRST page keeps them stable as pages append
// and across filter switches. Issue #628 adds `pendingByReason`: the pending
// total's split by flag reason, whole-queue and therefore filter-independent
// too (the same first-page read serves it).
export function selectReviewPageData(data) {
  const first = data?.pages?.[0] ?? {}
  return {
    items: (data?.pages ?? []).flatMap((page) => page?.items ?? []),
    counts: first.counts ?? {
      pending: 0,
      approved: 0,
      rejected: 0,
      pendingByReason: { price_ratio: 0, verifier_unresolved: 0, taxonomy: 0 },
    },
    filteredTotal: first.filteredTotal ?? 0,
  }
}

/**
 * The queue list. `reason` (issue #628) narrows the list to one flag reason
 * and rides the query key — null/omitted is "every reason", a distinct cache
 * entry from each filtered view, so switching never shows another filter's
 * pages. The counts stay whole-queue on the server; only the list changes.
 */
export function useReviewItems(status = 'pending', reason = null) {
  return useInfiniteQuery({
    queryKey: ['review', status, reason],
    queryFn: ({ signal, pageParam }) =>
      getReviewItems(
        { status, reason: reason ?? undefined, limit: REVIEW_PAGE_SIZE, offset: pageParam },
        signal
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + (page?.items?.length ?? 0), 0)
      const total = lastPage?.filteredTotal ?? 0
      return loaded < total ? loaded : undefined
    },
    select: selectReviewPageData,
  })
}

// AI review mode (issue #484). Global server state, not a per-item slice: the
// route is admin-only, so `enabled` keeps the query from firing for a
// non-admin view that is about to render the forbidden state.
export const REVIEW_MODE_KEY = ['review-mode']

export function useReviewMode({ enabled = true } = {}) {
  return useQuery({
    queryKey: REVIEW_MODE_KEY,
    queryFn: ({ signal }) => getReviewMode(signal),
    enabled,
    staleTime: 1000 * 60,
  })
}

// The switch persists the mode (PUT) and seeds the returned shape into the
// cache. The queue invalidates too: switching to `auto` kicks a bounded
// server-side sweep, and the list must show whatever it decided.
export function useSetReviewMode() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (mode) => setReviewMode(mode),
    onSuccess: (data) => {
      if (data) queryClient.setQueryData(REVIEW_MODE_KEY, data)
      queryClient.invalidateQueries({ queryKey: ['review'] })
    },
  })
}

// The bounded on-demand evaluation (≤10 items, server-enforced). Verdicts are
// cached forever, so re-running never re-bills an item that already has one.
export function useEvaluateReview() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (limit) => evaluateReviewItems(limit),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['review'] })
    },
  })
}

// The current-user read for the actor stamp (audit L6): the ['me'] cache is
// always present while the queue is open (AuthGate mounts it). plugins.js
// spells this key locally the same way.
const ME_KEY = ['me']

function bumpCount(counts, status, delta) {
  if (!counts || delta === 0) return counts
  const next = Math.max(0, (counts[status] ?? 0) + delta)
  if (next === counts[status]) return counts
  return { ...counts, [status]: next }
}

function bumpPendingByReason(counts, reason, delta) {
  if (!counts?.pendingByReason || !reason || delta === 0) return counts
  const next = Math.max(0, (counts.pendingByReason[reason] ?? 0) + delta)
  if (next === counts.pendingByReason[reason]) return counts
  return {
    ...counts,
    pendingByReason: { ...counts.pendingByReason, [reason]: next },
  }
}

/**
 * The ONE optimistic write for decide AND undo (audit M2/L6): flips the
 * matching row in every ['review'] cache entry AND moves the derived slices
 * the header paints — the whole-queue `counts`, the `pendingByReason` split,
 * and the per-list `filteredTotal` — so the pending badge and the visible
 * rows agree from the first frame instead of contradicting each other until
 * the settle refetch. A page without counts (a cache the server predates the
 * field in) is left unchanged. The actor is stamped from the caller's ['me']
 * cache; undo clears it again. Returns the snapshot map the mutation's
 * onError rolls back with.
 *
 * `nextStatus` is the row's optimistic outcome ('approved' | 'rejected' for a
 * decide, 'pending' for an undo) — passed in because the two mutations
 * resolve it differently.
 */
export function patchReviewCaches(queryClient, vars, nextStatus) {
  const previous = new Map()
  // Provenance mirrors the server rule: an assisted decision is ai_assist, a
  // plain one is human, and an undone row has no source.
  const nextSource = nextStatus === 'pending' ? null : vars.agreement ? 'ai_assist' : 'human'
  const nextDecidedAt = nextStatus === 'pending' ? null : new Date().toISOString()
  const me = queryClient.getQueryData(ME_KEY)
  const decidedBy = nextStatus === 'pending' ? null : (me?.user?.id ?? null)

  // The transition is discovered once, from the first cache entry that holds
  // the row — every entry shares the whole-queue counts, so a filtered view
  // that does not contain the row still moves its badge truthfully.
  let fromStatus = null
  let rowReason = null
  for (const [, value] of queryClient.getQueriesData({ queryKey: ['review'] })) {
    for (const page of value?.pages ?? []) {
      const row = (page.items ?? []).find((item) => item.id === vars.id)
      if (row) {
        fromStatus = row.status
        rowReason = row.reason ?? null
        break
      }
    }
    if (fromStatus) break
  }

  // The derived slices only move when the row actually changes list. A
  // re-fired identical mutation (a double-click inside the optimistic
  // window, before the re-render disables the buttons) finds the row already
  // in nextStatus — moving the counts again would double-decrement
  // filteredTotal and clamp counts until the settle refetch.
  const flips = fromStatus !== null && fromStatus !== nextStatus

  for (const [key, value] of queryClient.getQueriesData({ queryKey: ['review'] })) {
    previous.set(key, value)
    queryClient.setQueryData(key, (data) => {
      if (!data?.pages) return data
      // The cache key is ['review', status, reason]. filteredTotal is
      // per-list: the row leaves the `from` list and enters the `to` list
      // (when the list's reason filter matches the row's), and the `all`
      // list keeps it — its total never moves on a status flip.
      const [, listStatus, listReason] = key
      const rowMatchesReason = !listReason || rowReason === null || rowReason === listReason
      const totalDelta =
        listStatus === 'all' || !flips
          ? 0
          : listStatus === fromStatus && rowMatchesReason
            ? -1
            : listStatus === nextStatus && rowMatchesReason
              ? 1
              : 0
      return {
        ...data,
        pages: data.pages.map((page) => {
          let counts = page.counts
          if (counts && flips) {
            counts = bumpCount(counts, fromStatus, -1)
            counts = bumpCount(counts, nextStatus, 1)
            if (fromStatus === 'pending') counts = bumpPendingByReason(counts, rowReason, -1)
            if (nextStatus === 'pending') counts = bumpPendingByReason(counts, rowReason, 1)
          }
          return {
            ...page,
            items: (page.items ?? []).map((item) =>
              item.id === vars.id
                ? {
                    ...item,
                    status: nextStatus,
                    decidedAt: nextDecidedAt,
                    decidedBy,
                    decidedSource: nextSource,
                  }
                : item
            ),
            ...(counts !== page.counts ? { counts } : {}),
            ...(totalDelta !== 0
              ? { filteredTotal: Math.max(0, (page.filteredTotal ?? 0) + totalDelta) }
              : {}),
          }
        }),
      }
    })
  }
  return previous
}

// Optimistic verdict with rollback; every ['review'] query (all filters)
// invalidates on settle so the server state wins. resolveStatus maps the
// mutation vars to the row's optimistic status ('approved' | 'rejected' for
// a decide, 'pending' for an undo).
function useReviewDecisionMutation(mutationFn, resolveStatus) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ['review'] })
      const nextStatus = resolveStatus(vars)
      // M2: ONE patch writes the row AND every derived slice the header
      // paints (audit 2026-11-16 L6/C6) — the pending badge used to
      // contradict the visible rows until the settle refetch.
      const previous = patchReviewCaches(queryClient, vars, nextStatus)
      return { previous }
    },
    onError: (_error, _vars, context) => {
      if (!context?.previous) return
      for (const [key, value] of context.previous) {
        queryClient.setQueryData(key, value)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['review'] })
    },
  })
}

export function useDecideReview() {
  return useReviewDecisionMutation(
    ({ id, decision, agreement }) => decideReviewItem(id, decision, agreement),
    (vars) => vars.decision
  )
}

export function useUndoReview() {
  return useReviewDecisionMutation(
    ({ id }) => undoReviewDecision(id),
    () => 'pending'
  )
}

// #626: bulk-acknowledge every pending taxonomy self-pair. No optimistic
// write — the ack flips potentially hundreds of rows server-side, and the
// response's acknowledged/remaining belongs to a refetch, not a guess.
// Invalidating the ['review'] prefix refreshes the identity queue, the
// taxonomy page and the whole-queue counts together.
export function useAcknowledgeTaxonomy() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => acknowledgeTaxonomy(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['review'] })
    },
  })
}
