import { useQuery } from '@tanstack/react-query'
import { emailAuthStatus } from '../api'

const emailAuthStatusQueryOptions = {
  queryKey: ['email-auth-status'],
  queryFn: emailAuthStatus,
  staleTime: 1000 * 60 * 5,
}

export function useEmailAuthStatus() {
  return useQuery(emailAuthStatusQueryOptions)
}
