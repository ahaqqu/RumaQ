import { createFileRoute } from '@tanstack/react-router'
import { AdminCatalog } from '../pages/AdminCatalog.jsx'
import { RouteError } from '../components/RouteError.jsx'
import { ADMIN_CATALOG_TABS } from '../lib/pricesHelpers.js'

function RouteComponent() {
  return <AdminCatalog />
}

export const Route = createFileRoute('/admin/catalog')({
  // ?tab=products|brochures-qa|promos selects the catalog section (issue
  // #673); any other value or absence means Products. The retired brochures
  // tab value is not recognized — validateSearch drops it and the page
  // silently lands on Products (hard removal, no redirects). A #productKey
  // hash overrides the tab (stronger intent) — enforced in the page shell.
  validateSearch: ({ tab }) => ({
    tab: ADMIN_CATALOG_TABS.includes(tab) ? tab : undefined,
  }),
  component: RouteComponent,
  errorComponent: RouteError,
})
