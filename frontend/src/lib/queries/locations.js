import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getLocations, createLocation, deleteLocation } from '../api'

export function useLocations() {
  return useQuery({
    queryKey: ['locations'],
    queryFn: () => getLocations(),
    staleTime: 1000 * 60 * 5,
  })
}

export function useCreateLocation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: createLocation,
    onMutate: async (label) => {
      await queryClient.cancelQueries({ queryKey: ['locations'] })
      const previous = queryClient.getQueryData(['locations'])
      queryClient.setQueryData(['locations'], (old) => {
        if (!old?.locations) return old
        const tempId = `optimistic-${Date.now()}`
        return {
          ...old,
          locations: [...old.locations, { id: tempId, label }],
        }
      })
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(['locations'], context.previous)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['locations'] })
    },
  })
}

export function useDeleteLocation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: deleteLocation,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['locations'] })
      const previous = queryClient.getQueryData(['locations'])
      queryClient.setQueryData(['locations'], (old) => {
        if (!old?.locations) return old
        return {
          ...old,
          locations: old.locations.filter((loc) => loc.id !== id),
        }
      })
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(['locations'], context.previous)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['locations'] })
    },
  })
}
