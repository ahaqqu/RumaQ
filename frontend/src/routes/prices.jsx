import { createFileRoute } from '@tanstack/react-router'
import { Prices } from '../pages/Prices.jsx'
import { RouteError } from '../components/RouteError.jsx'

function RouteComponent() {
  return <Prices />
}

export const Route = createFileRoute('/prices')({
  // ?view=promos|brochures selects a catalog view (issues #292/#293); any
  // other value or absence means the Products explorer. A #productKey hash
  // overrides the view param (stronger intent) — enforced in the page shell.
  validateSearch: ({ view }) => ({
    view: view === 'promos' || view === 'brochures' ? view : undefined,
  }),
  component: RouteComponent,
  errorComponent: RouteError,
})
