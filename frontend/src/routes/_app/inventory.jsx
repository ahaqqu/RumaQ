import { createFileRoute } from '@tanstack/react-router'
import { Inventory } from '../../pages/Inventory.jsx'
import { RouteError } from '../../components/RouteError.jsx'

export const Route = createFileRoute('/_app/inventory')({
  component: Inventory,
  errorComponent: RouteError,
})
