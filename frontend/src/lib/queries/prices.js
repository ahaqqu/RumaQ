import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  getPrices,
  getPricesMeta,
  getPriceDetail,
  getPriceRuns,
  getPromos,
  getBrochures,
  getBrochureProducts,
} from '../api'

// Brochure data changes only when a scrape lands (daily) — a 5-minute
// refetch keeps countdowns and prices current in long-lived tabs while the
// tab is visible (react-query skips refetchIntervalInBackground by default).
const PRICES_REFETCH_MS = 1000 * 60 * 5

export function usePrices({ q, source, category, sort } = {}) {
  return useQuery({
    queryKey: ['prices', q ?? '', source ?? '', category ?? '', sort ?? ''],
    queryFn: ({ signal }) => getPrices({ q, source, category, sort }, signal),
    staleTime: 1000 * 60 * 5,
    refetchInterval: PRICES_REFETCH_MS,
  })
}

// Freshness for the explorer page: latest scrape time / observation window
// from GET /api/prices/meta (issue #291).
export function usePriceMeta() {
  return useQuery({
    queryKey: ['prices', 'meta'],
    queryFn: ({ signal }) => getPricesMeta(signal),
    staleTime: 1000 * 60 * 5,
    refetchInterval: PRICES_REFETCH_MS,
  })
}

// Promo catalog for the Promos segment (issue #292): same 5-min visible-tab
// refresh as usePrices so the two segments' counts cannot disagree
// mid-session (PM §7.6).
export function usePricePromos() {
  return useQuery({
    queryKey: ['prices', 'promos'],
    queryFn: ({ signal }) => getPromos(signal),
    staleTime: 1000 * 60 * 5,
    refetchInterval: PRICES_REFETCH_MS,
  })
}

// Brochure catalog for the Brochures segment (issue #293): same 5-min
// visible-tab refresh as its siblings so segments cannot disagree mid-session.
export function usePriceBrochures() {
  return useQuery({
    queryKey: ['prices', 'brochures'],
    queryFn: ({ signal }) => getBrochures(signal),
    staleTime: 1000 * 60 * 5,
    refetchInterval: PRICES_REFETCH_MS,
  })
}

// One page of the per-brochure QA list (issue #630): the full product set for
// a selected brochure, 50 rows at a time. Offset append ("Load more"),
// identical to the review queue's pagination; the exact total rides every
// page, so the first page's value stays stable while pages append.
export const BROCHURE_PRODUCTS_PAGE_SIZE = 50

export function useBrochureProducts(brochureUrl) {
  return useInfiniteQuery({
    queryKey: ['prices', 'brochures', 'products', brochureUrl ?? ''],
    queryFn: ({ signal, pageParam }) =>
      getBrochureProducts(
        {
          url: brochureUrl,
          limit: BROCHURE_PRODUCTS_PAGE_SIZE,
          offset: pageParam,
        },
        signal
      ),
    enabled: Boolean(brochureUrl),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + (page?.items?.length ?? 0), 0)
      const total = lastPage?.total ?? 0
      return loaded < total ? loaded : undefined
    },
    select: (data) => ({
      items: (data.pages ?? []).flatMap((page) => page?.items ?? []),
      total: (data.pages ?? [])[0]?.total ?? 0,
    }),
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
