import { createFileRoute } from '@tanstack/react-router'
import { AdminScrape } from '../pages/AdminScrape.jsx'
import { RouteError } from '../components/RouteError.jsx'

function RouteComponent() {
  return <AdminScrape />
}

export const Route = createFileRoute('/admin/scrape')({
  component: RouteComponent,
  errorComponent: RouteError,
})
