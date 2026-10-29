import { createFileRoute } from '@tanstack/react-router'
import { AdminReview } from '../pages/AdminReview.jsx'
import { RouteError } from '../components/RouteError.jsx'

function RouteComponent() {
  return <AdminReview />
}

export const Route = createFileRoute('/admin/review')({
  component: RouteComponent,
  errorComponent: RouteError,
})
