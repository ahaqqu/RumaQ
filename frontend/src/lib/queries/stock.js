import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getStock, patchStock } from '../api'

export function useStock({ location, q } = {}) {
  return useQuery({
    queryKey: ['stock', { location, q }],
    queryFn: () => getStock({ location, q }),
  })
}

export function useUpdateStock() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }) => patchStock(id, payload),
    onMutate: async ({ id, payload }) => {
      await queryClient.cancelQueries({ queryKey: ['stock'] })
      const previous = queryClient.getQueriesData({ queryKey: ['stock'] })
      queryClient.setQueriesData({ queryKey: ['stock'] }, (old) => {
        if (!old?.stock) return old
        return {
          ...old,
          stock: old.stock.map((item) => (item.id === id ? { ...item, ...payload } : item)),
        }
      })
      return { previous }
    },
    onError: (_err, _vars, context) => {
      context?.previous?.forEach(([key, data]) => {
        queryClient.setQueryData(key, data)
      })
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['stock'] })
      queryClient.invalidateQueries({ queryKey: ['home'] })
    },
  })
}
