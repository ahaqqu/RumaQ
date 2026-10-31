import { useQuery } from '@tanstack/react-query'
import { getAiUsage, getAdminAiUsage } from '../api'

export function useUsage() {
  return useQuery({
    queryKey: ['ai-usage'],
    // The queryFn receives a { signal } context; passing it through verbatim
    // makes the client build a Request with a non-AbortSignal and throw.
    queryFn: ({ signal }) => getAiUsage(signal),
    staleTime: 1000 * 60,
  })
}

// Admin AI usage analytics (issue #353) — totals + per-user breakdown over a
// ts-exact recent range. Each range is its own cache entry so switching is
// instant once a range has been loaded.
export function useAdminAiUsage(range) {
  return useQuery({
    queryKey: ['admin-ai-usage', range],
    queryFn: ({ signal }) => getAdminAiUsage(range, signal),
    staleTime: 1000 * 60,
  })
}
