import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getReviewItems,
  decideReviewItem,
  undoReviewDecision,
  getReviewMode,
  setReviewMode,
  evaluateReviewItems,
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
      const previous = new Map()
      const nextStatus = resolveStatus(vars)
      // Provenance mirrors the server rule: an assisted decision is
      // ai_assist, a plain one is human, and an undone row has no source.
      const nextSource = nextStatus === 'pending' ? null : vars.agreement ? 'ai_assist' : 'human'
      for (const [key, value] of queryClient.getQueriesData({ queryKey: ['review'] })) {
        previous.set(key, value)
        queryClient.setQueryData(key, (data) => {
          if (!data?.pages) return data
          return {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: (page.items ?? []).map((item) =>
                item.id === vars.id
                  ? {
                      ...item,
                      status: nextStatus,
                      decidedAt: nextStatus === 'pending' ? null : new Date().toISOString(),
                      decidedBy: null,
                      decidedSource: nextSource,
                    }
                  : item
              ),
            })),
          }
        })
      }
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
