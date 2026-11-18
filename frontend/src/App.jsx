import { RouterProvider, createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { plainParseSearch, plainStringifySearch } from './lib/plainSearchParams.js'

const router = createRouter({
  routeTree,
  // Plain query-string semantics (#716): the defaults JSON-round-trip search
  // values, so the /brochures/view deep link lost ?admin=true and re-quoted
  // its date segment on load — breaking the route's byte-exact brochure_url
  // contract. Every other route reads strings only (tab, view, code, run),
  // so plain parse/stringify is a strict relaxation (see plainSearchParams).
  parseSearch: plainParseSearch,
  stringifySearch: plainStringifySearch,
})

export function App() {
  return <RouterProvider router={router} />
}
