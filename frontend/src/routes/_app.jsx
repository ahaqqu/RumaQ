import { Outlet, createFileRoute } from '@tanstack/react-router'
import { AppShell } from '../components/AppShell.jsx'

// Pathless layout route (#674): every authenticated app surface nests here,
// so they all render inside AppShell, while chrome-less routes (the brochure
// viewer, routes/brochures.view.jsx) stay OUTSIDE this directory and render
// without the shell. Pathless: it contributes no URL segment — the routes'
// fullPath values are unchanged (/prices, /admin/catalog, ...), only their
// route IDs gain the /_app prefix.
function RouteComponent() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}

export const Route = createFileRoute('/_app')({
  component: RouteComponent,
})
