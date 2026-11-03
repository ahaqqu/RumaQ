import { createFileRoute } from '@tanstack/react-router'
import { Documents } from '../pages/Documents.jsx'
import { RouteError } from '../components/RouteError.jsx'

function RouteComponent() {
  return <Documents />
}

export const Route = createFileRoute('/documents')({
  component: RouteComponent,
  errorComponent: RouteError,
})
