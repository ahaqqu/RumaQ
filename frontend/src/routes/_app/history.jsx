import { createFileRoute } from '@tanstack/react-router'
import { useApp } from '../../context/AppContext.jsx'
import { History } from '../../pages/History.jsx'
import { RouteError } from '../../components/RouteError.jsx'

function RouteComponent() {
  const { setAssistantOpen } = useApp()

  return <History askAssistant={() => setAssistantOpen(true)} />
}

export const Route = createFileRoute('/_app/history')({
  component: RouteComponent,
  errorComponent: RouteError,
})
