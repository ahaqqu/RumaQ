import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getPlans, generatePlan, savePlan, updatePlanItem } from '../api'

export function usePlans(status = 'active') {
  return useQuery({
    queryKey: ['plans', status],
    queryFn: () => getPlans(status),
    staleTime: 1000 * 60,
  })
}

export function useGeneratePlan() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: generatePlan,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans'] })
    },
  })
}

export function useSavePlan() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: savePlan,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans'] })
    },
  })
}

export function useUpdatePlanItem() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ planId, itemId, status }) => updatePlanItem(planId, itemId, status),
    onMutate: async ({ planId, itemId, status }) => {
      await queryClient.cancelQueries({ queryKey: ['plans'] })
      const previous = queryClient.getQueriesData({ queryKey: ['plans'] })
      queryClient.setQueriesData({ queryKey: ['plans'] }, (old) => {
        if (!old?.plans) return old
        return {
          ...old,
          plans: old.plans.map((plan) => {
            if (plan.id !== planId) return plan
            return {
              ...plan,
              items: plan.items.map((item) => (item.id === itemId ? { ...item, status } : item)),
            }
          }),
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
      queryClient.invalidateQueries({ queryKey: ['plans'] })
      queryClient.invalidateQueries({ queryKey: ['stock'] })
      queryClient.invalidateQueries({ queryKey: ['home'] })
    },
  })
}
