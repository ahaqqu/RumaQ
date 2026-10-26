import { createFileRoute } from '@tanstack/react-router'
import { Prices } from '../pages/Prices.jsx'
import { RouteError } from '../components/RouteError.jsx'

function RouteComponent() {
  return <Prices />
}

export const Route = createFileRoute('/prices')({
  component: RouteComponent,
  errorComponent: RouteError,
})
