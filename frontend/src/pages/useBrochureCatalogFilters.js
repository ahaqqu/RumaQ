import { useMemo, useState } from 'react'

// The store/date filter machinery shared by the two brochure surfaces: the
// user gallery (BrochuresGallery, /prices?view=brochures) and the admin
// ingestion-QA browser (BrochuresView, /admin/catalog Brochures QA tab).
// #673 shipped a second copy of all of this beside the frozen QA view; #674
// extracts it (the #679 review B1) so filter behavior can no longer drift
// between the surfaces. Behavior-neutral: the memos below are verbatim from
// the twin copies, and both surfaces' suites pin them.
//
// Options come from the unfiltered catalog so both filters remain
// composable after one is applied (picking a store must not erase the dates
// it still has). The state shape (null = no filter) and the option/filtered
// derivations are consumed via BrochuresFilterPanel, the rendering half of
// this extraction.
export function useBrochureCatalogFilters(data) {
  const [store, setStore] = useState(null)
  const [date, setDate] = useState(null)

  // Memoized so the stores/dates/filtered memos keyed on `groups` keep a
  // stable array identity between fetches (react-hooks/exhaustive-deps).
  const groups = useMemo(() => data?.groups ?? [], [data])

  const stores = useMemo(() => {
    const seen = new Map()
    for (const group of groups) {
      if (!seen.has(group.source_slug)) seen.set(group.source_slug, group.source_name)
    }
    return [...seen.entries()].map(([slug, name]) => ({ slug, name }))
  }, [groups])
  const dates = useMemo(
    () => [...new Set(groups.map((group) => group.observed_date))].sort().reverse(),
    [groups]
  )

  const filtered = useMemo(
    () =>
      groups.filter(
        (group) =>
          (store == null || group.source_slug === store) &&
          (date == null || group.observed_date === date)
      ),
    [groups, store, date]
  )
  const filteredProducts = useMemo(
    () => filtered.reduce((sum, group) => sum + Number(group.product_count ?? 0), 0),
    [filtered]
  )

  const resetFilters = () => {
    setStore(null)
    setDate(null)
  }

  return {
    groups,
    stores,
    dates,
    store,
    setStore,
    date,
    setDate,
    filtered,
    filteredProducts,
    resetFilters,
  }
}
