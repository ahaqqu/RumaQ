import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AddFromReceipt } from '../../pages/AddFromReceipt.jsx'
import { RouteError } from '../../components/RouteError.jsx'

function RouteComponent() {
  const navigate = useNavigate()

  return <AddFromReceipt onDone={() => navigate({ to: '/inventory' })} />
}

export const Route = createFileRoute('/_app/add')({
  component: RouteComponent,
  errorComponent: RouteError,
})
