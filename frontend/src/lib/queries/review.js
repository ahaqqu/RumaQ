import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getReviewItems, decideReviewItem, undoReviewDecision } from '../api'

// Match review queue queries (issue #294). The list is a work queue that
// drains top-down, so pagination is a plain offset append ("Load more") —
// last_flagged_at mutates via upsert, which rules out a cursor anyway.

export const REVIEW_PAGE_SIZE = 50

// Counts + filteredTotal are exact server-side GROUP BYs, identical on every
// page — reading them from the FIRST page keeps them stable as pages append
// and across filter switches.
export function selectReviewPageData(data) {
  const first = data?.pages?.[0] ?? {}
  return {
    items: (data?.pages ?? []).flatMap((page) => page?.items ?? []),
    counts: first.counts ?? { pending: 0, approved: 0, rejected: 0 },
    filteredTotal: first.filteredTotal ?? 0,
  }
}

export function useReviewItems(status = 'pending') {
  return useInfiniteQuery({
    queryKey: ['review', status],
    queryFn: ({ signal, pageParam }) =>
      getReviewItems({ status, limit: REVIEW_PAGE_SIZE, offset: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + (page?.items?.length ?? 0), 0)
      const total = lastPage?.filteredTotal ?? 0
      return loaded < total ? loaded : undefined
    },
    select: selectReviewPageData,
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
    ({ id, decision }) => decideReviewItem(id, decision),
    (vars) => vars.decision
  )
}

export function useUndoReview() {
  return useReviewDecisionMutation(
    ({ id }) => undoReviewDecision(id),
    () => 'pending'
  )
}
