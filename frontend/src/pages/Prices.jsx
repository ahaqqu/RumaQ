import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePrices, usePriceSources, usePriceDetail } from '../lib/queries/index.js'
import { EmptyState, SkeletonRows } from '../components/ui.jsx'
import { Panel, PanelBody } from '../components/Panel.jsx'
import { Chip } from '../components/Chip.jsx'
import { IconSearch, IconWarning, IconClock } from '../components/icons.jsx'

const LIST_LIMIT = 200

function formatPrice(amount) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
  }).format(amount)
}

function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

// Groups flat (product, source) rows by product so each row shows the
// best current price and expands into per-source detail.
function groupByProduct(items) {
  const groups = new Map()
  for (const item of items ?? []) {
    if (!groups.has(item.product_key)) {
      groups.set(item.product_key, { product: item, offers: [] })
    }
    groups.get(item.product_key).offers.push(item)
  }
  return [...groups.values()].map(({ product, offers }) => {
    // Sort once and read the headline price from the sorted copy — the
    // backend orders rows by product/store name, not by price.
    const sorted = [...offers].sort((a, b) => a.price - b.price)
    return {
      ...product,
      offers: sorted,
      bestPrice: sorted[0]?.price,
    }
  })
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

  const current = data?.current ?? []
  const history = data?.history ?? []

  return (
    <div className="px-5 py-3 border-t border-border bg-surface-sunken/40">
      <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
        {t('prices.currentPrices')}
      </div>
      <div className="flex flex-col gap-2">
        {current.map((offer) => (
          <div key={offer.source_slug} className="flex items-center gap-3 text-sm">
            <span className="font-medium">{offer.source_name}</span>
            {offer.promo_label && (
              <span className="text-text-muted text-xs">{offer.promo_label}</span>
            )}
            {offer.low_confidence && (
              <span className="text-warn text-xs inline-flex items-center gap-1">
                <IconWarning size={12} /> {t('prices.lowConfidence')}
              </span>
            )}
            <span className="ml-auto tabular-nums font-semibold">{formatPrice(offer.price)}</span>
            <Sparkline history={history} sourceSlug={offer.source_slug} />
          </div>
        ))}
      </div>
    </div>
  )
}

export function Prices() {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [source, setSource] = useState(null)
  const [expandedKey, setExpandedKey] = useState(null)
  const debouncedSearch = useDebouncedValue(search.trim(), 300)

  const { data, isLoading, isError } = usePrices({ q: debouncedSearch || undefined, source })
  const { data: sources } = usePriceSources()

  const products = useMemo(() => groupByProduct(data?.items), [data])
  const storeCount = useMemo(
    () => new Set((data?.items ?? []).map((item) => item.source_slug)).size,
    [data]
  )

  return (
    <>
      <div className="mb-6">
        <p className="text-md text-text-muted leading-snug max-w-[62ch]">{t('prices.lead')}</p>
      </div>

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
          <div className="flex items-center gap-2 mb-3 text-sm text-text-muted">
            <IconClock size={14} />
            {t('prices.storesCount', { count: storeCount })}
          </div>
          <Panel className="mb-4">
            <PanelBody className="!py-0 !px-0">
              <div className="flex flex-col">
                {products.map((product) => (
                  <div key={product.product_key} className="border-b border-border last:border-b-0">
                    <button
                      className="w-full grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-3 text-left hover:bg-surface-sunken/60 transition-colors"
                      onClick={() =>
                        setExpandedKey(
                          expandedKey === product.product_key ? null : product.product_key
                        )
                      }
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
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold tabular-nums">
                          {formatPrice(product.bestPrice)}
                        </div>
                        <div className="text-xs text-text-muted">
                          {t('prices.showDetail')}
                          {expandedKey === product.product_key ? ' ▲' : ' ▼'}
                        </div>
                      </div>
                    </button>
                    {expandedKey === product.product_key && (
                      <PriceDetail productKey={product.product_key} />
                    )}
                  </div>
                ))}
              </div>
            </PanelBody>
          </Panel>
          {(data?.total ?? 0) >= LIST_LIMIT && (
            <p className="text-xs text-text-muted -mt-2 mb-4">
              {t('prices.listLimit', { limit: LIST_LIMIT })}
            </p>
          )}
        </>
      )}
    </>
  )
}
