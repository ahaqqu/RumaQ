import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ApiError, getMe, logout as apiLogout } from '../api'

// A confirmed 401 is resolved to a successful null result instead of an
// error: the logged-out state then overwrites any persisted authenticated
// cache on the next persist, and AuthGate's `me?.user` check sees null.
// Network failures still throw so offline loads keep the cached shell.
async function fetchMe() {
  try {
    return await getMe()
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null
    throw err
  }
}

const meQueryOptions = {
  queryKey: ['me'],
  queryFn: fetchMe,
  retry: false,
  staleTime: 1000 * 60 * 5,
  // The persisted cache can hold a session that no longer exists (it is only
  // revalidated when stale, and the smoke test can clear the cookie via the
  // logout URL without touching the cache), so re-check on every page load.
  refetchOnMount: 'always',
}

export function useMe() {
  return useQuery(meQueryOptions)
}

export function useMeQueryOptions() {
  return meQueryOptions
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
