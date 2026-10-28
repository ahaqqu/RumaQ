import { useQuery } from '@tanstack/react-query'
import { getAiUsage } from '../api'

export function useUsage() {
  return useQuery({
    queryKey: ['ai-usage'],
    // The queryFn receives a { signal } context; passing it through verbatim
    // makes the client build a Request with a non-AbortSignal and throw.
    queryFn: ({ signal }) => getAiUsage(signal),
    staleTime: 1000 * 60,
  })
}
