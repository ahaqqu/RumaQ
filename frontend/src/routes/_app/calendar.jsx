import { createFileRoute } from '@tanstack/react-router'
import { Calendar } from '../../pages/Calendar.jsx'
import { RouteError } from '../../components/RouteError.jsx'

function RouteComponent() {
  return <Calendar />
}

export const Route = createFileRoute('/_app/calendar')({
  component: RouteComponent,
  errorComponent: RouteError,
})
