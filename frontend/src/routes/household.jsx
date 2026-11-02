import { createFileRoute } from '@tanstack/react-router'
import { Household } from '../pages/Household.jsx'
import { RouteError } from '../components/RouteError.jsx'

function RouteComponent() {
  return <Household />
}

export const Route = createFileRoute('/household')({
  // ?code=XXXX comes from a shared invite link; the page pre-fills its join
  // input with it (the join itself stays an explicit click).
  validateSearch: ({ code }) => ({
    code: typeof code === 'string' && code.length > 0 ? code : undefined,
  }),
  component: RouteComponent,
  errorComponent: RouteError,
})
