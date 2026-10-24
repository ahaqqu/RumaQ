import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getSettings, patchSettings } from '../api'

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
    staleTime: 1000 * 60 * 5,
  })
}

export function useUpdateSettings() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: patchSettings,
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: ['settings'] })
      const previous = queryClient.getQueryData(['settings'])
      queryClient.setQueryData(['settings'], (old) => (old ? { ...old, ...payload } : old))
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(['settings'], context.previous)
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['settings'], data)
    },
  })
}
