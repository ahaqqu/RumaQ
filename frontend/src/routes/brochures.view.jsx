import { createFileRoute } from '@tanstack/react-router'
import { BrochureViewerPage } from '../pages/BrochureViewerPage.jsx'
import { RouteError } from '../components/RouteError.jsx'
import { resolveBrochureViewerSearch } from '../lib/pricesHelpers.js'

function RouteComponent() {
  return <BrochureViewerPage />
}

// The chrome-less brochure viewer (#674): /brochures/view lives OUTSIDE the
// pathless _app layout, so it renders with no left menu, no site header and
// no mobile tab bar — the page composes its own slim top bar. The route
// still sits inside __root's AuthGate: the image proxy and the catalog are
// session-cookie authenticated, so the viewer is Login-walled like every
// other surface. Dot-nesting without a /brochures parent follows the
// admin.catalog.jsx precedent.
export const Route = createFileRoute('/brochures/view')({
  // Structured deep link: ?store=&date=&file= each validates independently
  // (see resolveBrochureViewerSearch) and recomposes the canonical
  // brochure_url byte-exactly.
  validateSearch: resolveBrochureViewerSearch,
  component: RouteComponent,
  errorComponent: RouteError,
})
