import { useQuery } from '@tanstack/react-query'
import { getHome } from '../api'

export function useHome() {
  return useQuery({
    queryKey: ['home'],
    queryFn: getHome,
  })
}
