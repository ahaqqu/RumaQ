import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getStores, createStore, deleteStore } from '../api'

export function useStores() {
  return useQuery({
    queryKey: ['stores'],
    queryFn: () => getStores(),
    staleTime: 1000 * 60 * 5,
  })
}

export function useCreateStore() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: createStore,
    onMutate: async (label) => {
      await queryClient.cancelQueries({ queryKey: ['stores'] })
      const previous = queryClient.getQueryData(['stores'])
      queryClient.setQueryData(['stores'], (old) => {
        if (!old?.stores) return old
        const tempId = `optimistic-${Date.now()}`
        return {
          ...old,
          stores: [...old.stores, { id: tempId, label }],
        }
      })
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(['stores'], context.previous)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['stores'] })
    },
  })
}

export function useDeleteStore() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: deleteStore,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['stores'] })
      const previous = queryClient.getQueryData(['stores'])
      queryClient.setQueryData(['stores'], (old) => {
        if (!old?.stores) return old
        return {
          ...old,
          stores: old.stores.filter((store) => store.id !== id),
        }
      })
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(['stores'], context.previous)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['stores'] })
    },
  })
}
