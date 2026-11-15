import { createFileRoute } from '@tanstack/react-router'
import { AdminAiUsage } from '../../pages/AdminAiUsage.jsx'
import { RouteError } from '../../components/RouteError.jsx'

function RouteComponent() {
  return <AdminAiUsage />
}

export const Route = createFileRoute('/_app/admin/ai-usage')({
  component: RouteComponent,
  errorComponent: RouteError,
})
