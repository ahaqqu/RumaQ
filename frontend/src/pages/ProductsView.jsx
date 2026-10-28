import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { usePrices, usePriceMeta, usePriceSources, usePriceDetail } from '../lib/queries/index.js'
import { EmptyState, SkeletonRows } from '../components/ui.jsx'
import { Panel, PanelBody } from '../components/Panel.jsx'
import { Chip } from '../components/Chip.jsx'
import { Badge } from '../components/Badge.jsx'
import { IconSearch, IconWarning, IconClock } from '../components/icons.jsx'
import { cn } from '../lib/cn.js'
import {
  buildFooterStats,
  countdownState,
  displayPrice,
  effectivePrice,
  formatPrice,
  isFreshnessStale,
  normalizeHash,
  promoBadges,
  relativeAge,
  savePctVisible,
} from '../lib/pricesHelpers.js'

const LIST_LIMIT = 200

// Sort options in the PM's menu order; default Cheapest because the page
// exists to answer "what's cheapest" (PM §3.1).
const SORT_OPTIONS = [
  { value: 'cheapest', key: 'prices.sortCheapest' },
  { value: 'savings', key: 'prices.sortSavings' },
  { value: 'name', key: 'prices.sortName' },
  { value: 'expiry', key: 'prices.sortExpiry' },
]

function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

// Groups flat (product, source) rows by product so each row shows the best
// current price and expands into per-source detail. Sorted responses are
// product-level pages carrying server aggregates (price_min, savings_pct,
// cheapest_source_slug) — the cheapest offer is looked up from the server's
// answer so card headline, badges, and countdown all describe one offer.
function groupByProduct(items) {
  const groups = new Map()
  for (const item of items ?? []) {
    if (!groups.has(item.product_key)) {
      groups.set(item.product_key, { product: item, offers: [] })
    }
    groups.get(item.product_key).offers.push(item)
  }
  return [...groups.values()].map(({ product, offers }) => {
    const sorted = [...offers].sort((a, b) => effectivePrice(a) - effectivePrice(b))
    const cheapestOffer =
      (product.cheapest_source_slug &&
        sorted.find((o) => o.source_slug === product.cheapest_source_slug)) ||
      sorted[0]
    return {
      ...product,
      offers: sorted,
      cheapestOffer,
      bestPrice: cheapestOffer ? displayPrice(cheapestOffer) : undefined,
    }
  })
}

// Slim trust line under the lead: pulsing dot + absolute-time age of the
// newest scrape. The dot turns warn and stops pulsing past 26h (daily scrape
// cadence + slack); no red state on a shopper page (PM §3.5).
function FreshnessBar() {
  const { t } = useTranslation()
  const { data } = usePriceMeta()
  const age = relativeAge(data?.latestScrapedAt)
  if (!age) return null
  const stale = isFreshnessStale(data.latestScrapedAt)
  return (
    <p className="flex items-center gap-2 mb-4 text-xs text-text-muted">
      <span
        aria-hidden="true"
        className={cn(
          'h-2 w-2 rounded-full shrink-0',
          stale ? 'bg-warn' : 'bg-accent animate-pulse motion-reduce:animate-none'
        )}
      />
      {t('prices.updated', { time: t(`prices.${age.key}`, { count: age.count }) })}
    </p>
  )
}

// Minimal inline SVG sparkline of one source's observed prices.
function Sparkline({ history, sourceSlug }) {
  const points = history.filter((row) => row.source_slug === sourceSlug && row.price > 0)
  if (points.length < 2) return null
  const width = 120
  const height = 32
  const prices = points.map((p) => p.price)
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const span = max - min || 1
  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * (width - 4) + 2
      const y = height - 4 - ((p.price - min) / span) * (height - 8)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0"
      aria-hidden="true"
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-accent" />
    </svg>
  )
}

function PriceDetail({ productKey }) {
  const { t } = useTranslation()
  const { data, isLoading } = usePriceDetail(productKey)

  if (isLoading) {
    return (
      <div className="px-5 py-3 border-t border-border">
        <SkeletonRows n={2} />
      </div>
    )
  }

  // current[] is server-ordered by COALESCE(effective_unit_price, price) —
  // first row is the payable-price cheapest (arch §3.1).
  const current = data?.current ?? []
  const history = data?.history ?? []

  return (
    <div className="px-5 py-3 border-t border-border bg-surface-sunken/40">
      <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
        {t('prices.currentPrices')}
      </div>
      <div className="flex flex-col gap-2">
        {current.map((offer, index) => {
          const shown = displayPrice(offer)
          const struck = shown !== offer.price
          const gap = index > 0 && current[0] ? shown - displayPrice(current[0]) : null
          // Per-piece unit price whenever the per-unit value differs from the
          // package price shown (AC 4) — unit comes from the data.
          const perUnit =
            offer.unit && effectivePrice(offer) !== offer.price
              ? t('prices.perUnit', {
                  price: formatPrice(effectivePrice(offer)),
                  unit: offer.unit,
                })
              : null
          return (
            <div key={offer.source_slug}>
              <div className="flex items-center gap-3 text-sm">
                <span className="font-medium">{offer.source_name}</span>
                {index === 0 && current.length > 1 && (
                  <span className="inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-xs font-semibold border bg-accent-soft border-accent-soft-border text-accent-hover">
                    ✓ {t('prices.cheapestBadge')}
                  </span>
                )}
                {promoBadges(offer.promo_label, offer.promo_type).map((badge) => (
                  <Badge key={badge.text} tone={badge.tone}>
                    {badge.text}
                  </Badge>
                ))}
                {offer.low_confidence && (
                  <span className="text-warn text-xs inline-flex items-center gap-1">
                    <IconWarning size={12} /> {t('prices.lowConfidence')}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-2">
                  {gap != null && gap !== 0 && (
                    <span className="text-xs text-text-muted tabular-nums">
                      +{formatPrice(gap)}
                    </span>
                  )}
                  {struck && (
                    <span className="text-xs text-text-muted line-through tabular-nums">
                      {formatPrice(offer.price)}
                    </span>
                  )}
                  <span className="tabular-nums font-semibold">{formatPrice(shown)}</span>
                </span>
                <Sparkline history={history} sourceSlug={offer.source_slug} />
              </div>
              {perUnit && <div className="text-xs text-text-muted">{perUnit}</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// The Products explorer: search, source chips, sort, per-product cards with
// #productKey deep links. Extracted verbatim from Prices.jsx when the page
// became a Products|Promos shell (issue #292) — search text and the selected
// source live in the shell so the promo view's example jump can clear them.
export function ProductsView({ search, setSearch, source, setSource }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const [sort, setSort] = useState('cheapest')
  const [expandedKey, setExpandedKey] = useState(null)
  const debouncedSearch = useDebouncedValue(search.trim(), 300)

  const { data, isLoading, isError } = usePrices({
    q: debouncedSearch || undefined,
    source,
    sort,
  })
  const { data: sources } = usePriceSources()

  const products = useMemo(() => groupByProduct(data?.items), [data])
  const storeCount = useMemo(
    () => new Set((data?.items ?? []).map((item) => item.source_slug)).size,
    [data]
  )
  const footerStats = useMemo(() => buildFooterStats(data?.items, sources ?? []), [data, sources])

  // --- Deep link (#productKey, PM §3.7) ---
  const hashKey = normalizeHash(location.hash)
  const rowRefs = useRef(new Map())
  const pendingScrollKey = useRef(null)

  // Apply: expand when the hash names a loaded product. A hash for a
  // filtered-out product is left untouched and retried when data changes —
  // no error state (the link stays valid for whoever clears the filter).
  useEffect(() => {
    if (!hashKey || !products.some((p) => p.product_key === hashKey)) return
    if (expandedKey !== hashKey) {
      pendingScrollKey.current = hashKey
      setExpandedKey(hashKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- expandedKey reads are guarded above
  }, [hashKey, products])

  // After the expansion rendered, bring the row into view — with default
  // sort=cheapest the target may sit far down the list, so scrolling is part
  // of the deep-link contract, not polish.
  useEffect(() => {
    if (!expandedKey || pendingScrollKey.current !== expandedKey) return
    pendingScrollKey.current = null
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    rowRefs.current
      .get(expandedKey)
      ?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
  }, [expandedKey])

  // Write: expansion writes the hash directly (replace semantics — the back
  // button does not walk expansion history). Writing in the handler (instead
  // of syncing in an effect) cannot loop with the apply effect and never
  // clears a hash for a product that has not matched yet.
  const toggleExpanded = (key) => {
    const next = expandedKey === key ? null : key
    setExpandedKey(next)
    navigate({ to: '/prices', hash: next ?? '', replace: true })
  }

  const setRowRef = (key) => (el) => {
    if (el) rowRefs.current.set(key, el)
    else rowRefs.current.delete(key)
  }

  return (
    <>
      <FreshnessBar />

      <div className="relative mb-4">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">
          <IconSearch size={18} />
        </span>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('prices.searchPlaceholder')}
          aria-label={t('prices.searchAriaLabel')}
          className="w-full rounded-md border border-border bg-surface-raised pl-10 pr-4 py-2.5 text-sm outline-none focus:border-accent"
        />
      </div>

      {(sources?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-2 mb-5">
          <Chip variant="filter" pressed={!source} onClick={() => setSource(null)}>
            {t('prices.allSources')}
          </Chip>
          {sources.map((s) => (
            <Chip
              key={s.slug}
              variant="filter"
              pressed={source === s.slug}
              onClick={() => setSource(source === s.slug ? null : s.slug)}
            >
              {s.name}
            </Chip>
          ))}
        </div>
      )}

      {isLoading ? (
        <Panel>
          <SkeletonRows n={5} />
        </Panel>
      ) : isError ? (
        <Panel>
          <EmptyState icon={IconWarning} title={t('prices.noMatch')} desc={t('offline.banner')} />
        </Panel>
      ) : products.length === 0 ? (
        <Panel>
          <EmptyState
            icon={IconSearch}
            title={t('prices.noMatch')}
            desc={t('prices.noMatchDesc')}
          />
        </Panel>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 mb-3 text-sm text-text-muted">
            <select
              value={sort}
              aria-label={t('prices.sortLabel')}
              onChange={(event) => setSort(event.target.value)}
              className="rounded-md border border-border bg-surface-raised text-sm px-2 py-1.5 outline-none focus:border-accent"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.key)}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2">
              <IconClock size={14} />
              {t('prices.storesCount', { count: storeCount })}
            </div>
          </div>
          <Panel className="mb-4">
            <PanelBody className="!py-0 !px-0">
              <div className="flex flex-col">
                {products.map((product) => {
                  const cheapest = product.cheapestOffer
                  const shown = cheapest ? displayPrice(cheapest) : undefined
                  const struck = cheapest != null && shown !== cheapest.price
                  const countdown = countdownState(product.cheapest_valid_until)
                  const badges = cheapest
                    ? promoBadges(cheapest.promo_label, cheapest.promo_type)
                    : []
                  const expanded = expandedKey === product.product_key
                  return (
                    <div
                      key={product.product_key}
                      ref={setRowRef(product.product_key)}
                      className="border-b border-border last:border-b-0"
                    >
                      <button
                        className="w-full grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-3 text-left hover:bg-surface-sunken/60 transition-colors"
                        onClick={() => toggleExpanded(product.product_key)}
                      >
                        <div className="min-w-0">
                          <div className="font-medium truncate">
                            {product.name}
                            {product.brand ? ` · ${product.brand}` : ''}
                          </div>
                          <div className="text-xs text-text-muted mt-0.5">
                            {product.unit ? `${product.unit} · ` : ''}
                            {t('prices.storesCount', { count: product.offers.length })}
                            {product.offers.some((o) => o.low_confidence) && (
                              <span className="text-warn"> · {t('prices.lowConfidence')}</span>
                            )}
                          </div>
                          {badges.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1 mt-1">
                              {badges.map((badge) => (
                                <Badge key={badge.text} tone={badge.tone}>
                                  {badge.text}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="text-right">
                          {struck && (
                            <div className="text-xs text-text-muted line-through tabular-nums">
                              {formatPrice(cheapest.price)}
                            </div>
                          )}
                          <div className="text-sm font-semibold tabular-nums">
                            {formatPrice(shown)}
                          </div>
                          {savePctVisible(product.savings_pct) && (
                            <div className="mt-0.5">
                              <Badge tone="ok">
                                {t('prices.savePct', { pct: Math.round(product.savings_pct) })}
                              </Badge>
                            </div>
                          )}
                          {countdown && (
                            <div
                              className={cn(
                                'text-xs tabular-nums',
                                countdown.type === 'expired' && 'text-danger',
                                countdown.type === 'today' && 'text-warn',
                                countdown.type === 'days' && countdown.count <= 3 && 'text-warn',
                                countdown.type === 'days' &&
                                  countdown.count > 3 &&
                                  'text-text-muted'
                              )}
                            >
                              {countdown.type === 'expired'
                                ? t('prices.countdownExpired')
                                : countdown.type === 'today'
                                  ? t('prices.countdownToday')
                                  : t('prices.countdownDays', { count: countdown.count })}
                            </div>
                          )}
                          <div className="text-xs text-text-muted">
                            {t('prices.showDetail')}
                            {expanded ? ' ▲' : ' ▼'}
                          </div>
                        </div>
                      </button>
                      {expanded && <PriceDetail productKey={product.product_key} />}
                    </div>
                  )
                })}
              </div>
            </PanelBody>
          </Panel>
          {footerStats.segments.length > 0 && (
            <p className="text-xs text-text-muted -mt-2 mb-4" data-testid="prices-footer-stats">
              {footerStats.segments.map((s) => `${s.name}: ${s.count}`).join(' · ')}
              {footerStats.matched > 0 &&
                ` · ${t('prices.matched', { count: footerStats.matched })}`}
            </p>
          )}
          {data?.truncated === true && (
            <p className="text-xs text-text-muted -mt-2 mb-4">
              {t('prices.listLimit', { limit: LIST_LIMIT })}
            </p>
          )}
        </>
      )}
    </>
  )
}
