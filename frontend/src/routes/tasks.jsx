import { createFileRoute } from '@tanstack/react-router'
import { Tasks } from '../pages/Tasks.jsx'
import { RouteError } from '../components/RouteError.jsx'

function RouteComponent() {
  return <Tasks />
}

export const Route = createFileRoute('/tasks')({
  component: RouteComponent,
  errorComponent: RouteError,
})
