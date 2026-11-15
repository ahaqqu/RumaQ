import { createFileRoute } from '@tanstack/react-router'
import { Prices } from '../pages/Prices.jsx'
import { RouteError } from '../components/RouteError.jsx'
import { PRICE_ROUTE_VIEWS } from '../lib/pricesHelpers.js'

function RouteComponent() {
  return <Prices />
}

export const Route = createFileRoute('/prices')({
  // ?view=brochures selects the user brochure gallery (issue #673); any other
  // value or absence means the Products explorer. Retired values (the old
  // ?view=promos) are not recognized — validateSearch drops them and the page
  // silently lands on Products (hard removal, no redirects). A #productKey
  // hash overrides the view param (stronger intent), also enforced in the
  // page shell.
  validateSearch: ({ view }) => ({
    view: PRICE_ROUTE_VIEWS.includes(view) ? view : undefined,
  }),
  component: RouteComponent,
  errorComponent: RouteError,
})
