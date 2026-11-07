import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  assignAiCapability,
  clearAiCapability,
  createAiProvider,
  deleteAiProvider,
  getAiCapabilities,
  getAiPresets,
  getAiProviders,
  testAiProvider,
  updateAiProvider,
} from '../api'

// AI gateway settings (ahaqqu/RumaQ#523 P3, plan §4.4). Two server-state slices —
// the household's providers and its capability assignments — plus the preset
// catalog. Every write invalidates BOTH slices: a provider edit can change an
// effective model (the capability inherits `default_model`) and a delete clears
// assignments, so they are one consistency unit even though they are two reads.

const AI_SETTINGS_KEY = ['ai-settings']

export const aiProvidersQueryKey = [...AI_SETTINGS_KEY, 'providers']

export function useAiProviders() {
  return useQuery({
    queryKey: aiProvidersQueryKey,
    queryFn: getAiProviders,
    staleTime: 1000 * 30,
  })
}

export function useAiPresets() {
  return useQuery({
    queryKey: [...AI_SETTINGS_KEY, 'presets'],
    queryFn: getAiPresets,
    // The catalog is static data (lib/ai/presets.ts); one fetch per session.
    staleTime: Infinity,
  })
}

export function useAiCapabilities() {
  return useQuery({
    queryKey: [...AI_SETTINGS_KEY, 'capabilities'],
    queryFn: getAiCapabilities,
    staleTime: 1000 * 30,
  })
}

function useInvalidateAiSettings() {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: AI_SETTINGS_KEY })
    // The settings payload carries the same household AI block; a mutation must
    // not leave a stale copy behind (Plan/Assistant read `ai_status` from it).
    queryClient.invalidateQueries({ queryKey: ['settings'] })
  }
}

export function useCreateAiProvider() {
  const invalidate = useInvalidateAiSettings()
  return useMutation({
    mutationFn: createAiProvider,
    onSuccess: invalidate,
  })
}

export function useUpdateAiProvider() {
  const invalidate = useInvalidateAiSettings()
  return useMutation({
    mutationFn: ({ id, payload }) => updateAiProvider(id, payload),
    onSuccess: invalidate,
  })
}

export function useDeleteAiProvider() {
  const invalidate = useInvalidateAiSettings()
  return useMutation({
    mutationFn: deleteAiProvider,
    onSuccess: invalidate,
  })
}

/**
 * The connection test is a POST but changes nothing server-side, so it is a
 * mutation only to get per-call pending state; it does not invalidate.
 */
export function useTestAiProvider() {
  return useMutation({ mutationFn: testAiProvider })
}

export function useAssignAiCapability() {
  const invalidate = useInvalidateAiSettings()
  return useMutation({
    mutationFn: ({ capability, payload }) => assignAiCapability(capability, payload),
    onSuccess: invalidate,
  })
}

export function useClearAiCapability() {
  const invalidate = useInvalidateAiSettings()
  return useMutation({
    mutationFn: clearAiCapability,
    onSuccess: invalidate,
  })
}
