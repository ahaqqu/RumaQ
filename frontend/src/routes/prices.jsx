import { createFileRoute } from '@tanstack/react-router'
import { Prices } from '../pages/Prices.jsx'
import { RouteError } from '../components/RouteError.jsx'
import { PRICE_ROUTE_VIEWS } from '../lib/pricesHelpers.js'

function RouteComponent() {
  return <Prices />
}

export const Route = createFileRoute('/prices')({
  // ?view=promos selects the promo catalog (issue #292); any other value or
  // absence means the Products explorer. ?view=brochures is retired (#631)
  // but stays valid so the old deep link can redirect instead of 404ing — the
  // page shell owns that redirect. A #productKey hash overrides the view
  // param (stronger intent), also enforced in the page shell.
  validateSearch: ({ view }) => ({
    view: PRICE_ROUTE_VIEWS.includes(view) ? view : undefined,
  }),
  component: RouteComponent,
  errorComponent: RouteError,
})
