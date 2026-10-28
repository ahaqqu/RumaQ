import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePricePromos, usePriceSources } from '../lib/queries/index.js'
import { EmptyState, SkeletonRows } from '../components/ui.jsx'
import { Panel, PanelBody } from '../components/Panel.jsx'
import { Badge } from '../components/Badge.jsx'
import { IconSearch, IconWarning } from '../components/icons.jsx'
import { formatPrice } from '../lib/pricesHelpers.js'

// i18n key per promo group — the API returns groups in the fixed order
// (discount_pct → … → other last), cards render in that order.
const PROMO_TYPE_LABEL_KEYS = {
  discount_pct: 'prices.promoTypeDiscountPct',
  discount_fixed: 'prices.promoTypeDiscountFixed',
  get_free: 'prices.promoTypeGetFree',
  bundle_buy: 'prices.promoTypeBundleBuy',
  multi_price: 'prices.promoTypeMultiPrice',
  other: 'prices.promoTypeOther',
}

// One card per promo type group: label + count badge + per-source badges,
// header toggles ≤5 example rows. Store names resolve from the source chip
// bar (unknown slug falls back to the raw slug) — no hardcoded names or
// colors anywhere (PM AC 4).
function PromoCard({ group, sourceNames, expanded, onToggle, onJump }) {
  const { t } = useTranslation()
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        className="w-full flex items-center justify-between gap-4 px-5 py-3 text-left hover:bg-surface-sunken/60 transition-colors"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <div className="min-w-0">
          <div className="font-medium truncate">{t(PROMO_TYPE_LABEL_KEYS[group.promo_type])}</div>
          <div className="flex flex-wrap items-center gap-1 mt-1">
            <Badge tone="muted">{t('prices.productsCount', { count: group.product_count })}</Badge>
            {Object.entries(group.stores ?? {}).map(([slug, count]) => (
              <Badge key={slug} tone="muted">
                {sourceNames[slug] ?? slug} {count}
              </Badge>
            ))}
          </div>
        </div>
        <div className="text-xs text-text-muted shrink-0">
          {t('prices.showExamples')}
          {expanded ? ' ▲' : ' ▼'}
        </div>
      </button>
      {expanded && (
        <div className="px-5 py-3 border-t border-border bg-surface-sunken/40 flex flex-col gap-2">
          {(group.example_products ?? []).map((product) => {
            // Per-unit line only when the effective price differs from the
            // package price shown — same vocabulary as the explorer row.
            const perUnit =
              product.unit &&
              product.effective_unit_price != null &&
              product.effective_unit_price !== product.price
                ? t('prices.perUnit', {
                    price: formatPrice(product.effective_unit_price),
                    unit: product.unit,
                  })
                : null
            return (
              <button
                key={product.product_key}
                className="w-full flex items-center justify-between gap-4 text-left hover:bg-surface-sunken/60 transition-colors"
                onClick={() => onJump(product.product_key)}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    {product.name}
                    {product.brand ? ` · ${product.brand}` : ''}
                  </div>
                  {perUnit && <div className="text-xs text-text-muted">{perUnit}</div>}
                </div>
                <span className="text-sm font-semibold tabular-nums shrink-0">
                  {formatPrice(product.price)}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// The promo catalog view ("what is on deal this week?" — browse instead of
// search, issue #292): one card per promo type in the API's fixed order,
// multi-expand, example click jumps into the Products explorer.
export function PromosView({ onJump }) {
  const { t } = useTranslation()
  const { data, isLoading, isError } = usePricePromos()
  const { data: sources } = usePriceSources()
  // Multi-expand (independent Set): opening one group must not collapse
  // another — a catalog is browse-oriented (PM §2).
  const [expanded, setExpanded] = useState(() => new Set())
  const toggle = (key) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const sourceNames = useMemo(
    () => Object.fromEntries((sources ?? []).map((s) => [s.slug, s.name])),
    [sources]
  )

  const groups = data?.types ?? []

  return (
    <>
      {!isLoading && !isError && groups.length > 0 && (
        <p className="text-xs text-text-muted mb-4">
          {t('prices.promosTotal', { count: data.total })}
        </p>
      )}
      {isLoading ? (
        <Panel>
          <SkeletonRows n={5} />
        </Panel>
      ) : isError ? (
        <Panel>
          <EmptyState icon={IconWarning} title={t('prices.noMatch')} desc={t('offline.banner')} />
        </Panel>
      ) : groups.length === 0 ? (
        <Panel>
          <EmptyState
            icon={IconSearch}
            title={t('prices.promosEmpty')}
            desc={t('prices.promosEmptyDesc')}
          />
        </Panel>
      ) : (
        <Panel className="mb-4">
          <PanelBody className="!py-0 !px-0">
            <div className="flex flex-col">
              {groups.map((group) => (
                <PromoCard
                  key={group.promo_type}
                  group={group}
                  sourceNames={sourceNames}
                  expanded={expanded.has(group.promo_type)}
                  onToggle={() => toggle(group.promo_type)}
                  onJump={onJump}
                />
              ))}
            </div>
          </PanelBody>
        </Panel>
      )}
    </>
  )
}
