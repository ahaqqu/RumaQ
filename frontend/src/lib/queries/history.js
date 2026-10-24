import { useQuery, useMutation } from '@tanstack/react-query'
import { getPurchases, getPurchasePatterns, sendChatMessage } from '../api'

export function useHistory(filters = {}) {
  return useQuery({
    queryKey: ['purchases', filters],
    queryFn: () => getPurchases(filters),
    staleTime: 1000 * 60,
  })
}

export function usePurchasePatterns() {
  return useQuery({
    queryKey: ['purchase-patterns'],
    queryFn: () => getPurchasePatterns(),
    staleTime: 1000 * 60 * 5,
  })
}

export function useSendChatMessage() {
  return useMutation({
    mutationFn: ({ message, history }) => sendChatMessage(message, history),
  })
}
