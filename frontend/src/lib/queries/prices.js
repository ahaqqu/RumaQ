import { useQuery } from '@tanstack/react-query'
import { getPrices, getPriceDetail, getPriceRuns } from '../api'

export function usePrices({ q, source } = {}) {
  return useQuery({
    queryKey: ['prices', q ?? '', source ?? ''],
    queryFn: ({ signal }) => getPrices({ q, source }, signal),
    staleTime: 1000 * 60 * 5,
  })
}

// Distinct sources for the filter chips — served from one unfiltered explorer
// query kept separate from the (possibly filtered) list query.
export function usePriceSources() {
  return useQuery({
    queryKey: ['prices', 'sources'],
    queryFn: ({ signal }) => getPrices({}, signal),
    staleTime: 1000 * 60 * 10,
    select: (data) => {
      const seen = new Map()
      for (const item of data?.items ?? []) {
        if (!seen.has(item.source_slug)) {
          seen.set(item.source_slug, item.source_name)
        }
      }
      return [...seen.entries()].map(([slug, name]) => ({ slug, name }))
    },
  })
}

export function usePriceDetail(productKey) {
  return useQuery({
    queryKey: ['prices', 'detail', productKey],
    queryFn: ({ signal }) => getPriceDetail(productKey, signal),
    enabled: Boolean(productKey),
    staleTime: 1000 * 60 * 5,
  })
}

export function usePriceRuns() {
  return useQuery({
    queryKey: ['price-runs'],
    queryFn: ({ signal }) => getPriceRuns(signal),
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
  })
}
