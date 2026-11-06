import { createFileRoute } from '@tanstack/react-router'
import { Documents } from '../pages/Documents.jsx'
import { RouteError } from '../components/RouteError.jsx'
import { PluginGate } from '../plugins/PluginGate.jsx'

function RouteComponent() {
  // The documents route is plugin-owned (#436): a disabled household gets
  // the calm disabled empty state instead of the page — the backend gate
  // 404s the plugin's API either way, so a rendered page would only fetch
  // errors (plan §4.5: the gate is the route contribution).
  return (
    <PluginGate plugin="documents">
      <Documents />
    </PluginGate>
  )
}

export const Route = createFileRoute('/documents')({
  component: RouteComponent,
  errorComponent: RouteError,
})
