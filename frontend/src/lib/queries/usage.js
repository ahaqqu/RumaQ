import { useQuery } from '@tanstack/react-query'
import { getAiUsage } from '../api'

export function useUsage() {
  return useQuery({
    queryKey: ['ai-usage'],
    queryFn: getAiUsage,
    staleTime: 1000 * 60,
  })
}
