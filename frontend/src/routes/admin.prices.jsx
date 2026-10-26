import { createFileRoute } from '@tanstack/react-router'
import { AdminPrices } from '../pages/AdminPrices.jsx'
import { RouteError } from '../components/RouteError.jsx'

function RouteComponent() {
  return <AdminPrices />
}

export const Route = createFileRoute('/admin/prices')({
  component: RouteComponent,
  errorComponent: RouteError,
})
