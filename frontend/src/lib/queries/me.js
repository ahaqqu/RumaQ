import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getMe, logout as apiLogout } from '../api'

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: getMe,
    retry: false,
    staleTime: 1000 * 60 * 5,
  })
}

export function useMeQueryOptions() {
  return {
    queryKey: ['me'],
    queryFn: getMe,
    retry: false,
    staleTime: 1000 * 60 * 5,
  }
}

export function useLogout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      queryClient.clear()
      apiLogout()
    },
  })
}
