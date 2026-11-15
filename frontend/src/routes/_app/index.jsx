import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useApp } from '../../context/AppContext.jsx'
import { Home } from '../../pages/Home.jsx'
import { RouteError } from '../../components/RouteError.jsx'

function RouteComponent() {
  const navigate = useNavigate()
  const { setAssistantOpen } = useApp()

  return (
    <Home
      setView={(view) => navigate({ to: `/${view === 'home' ? '' : view}` })}
      askAssistant={() => setAssistantOpen(true)}
    />
  )
}

export const Route = createFileRoute('/_app/')({
  component: RouteComponent,
  errorComponent: RouteError,
})
