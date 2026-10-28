import { useQuery } from '@tanstack/react-query'
import { getHome } from '../api'

export function useHome() {
  return useQuery({
    queryKey: ['home'],
    // The queryFn receives a { signal } context; passing it through verbatim
    // makes the client build a Request with a non-AbortSignal and throw.
    queryFn: ({ signal }) => getHome(signal),
  })
}
