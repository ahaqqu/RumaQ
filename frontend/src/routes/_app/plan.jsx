import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useApp } from '../../context/AppContext.jsx'
import { Plan } from '../../pages/Plan.jsx'
import { RouteError } from '../../components/RouteError.jsx'

function RouteComponent() {
  const navigate = useNavigate()
  const { setAssistantOpen } = useApp()

  return (
    <Plan
      askAssistant={() => setAssistantOpen(true)}
      setView={(view) => navigate({ to: `/${view === 'home' ? '' : view}` })}
    />
  )
}

export const Route = createFileRoute('/_app/plan')({
  component: RouteComponent,
  errorComponent: RouteError,
})
