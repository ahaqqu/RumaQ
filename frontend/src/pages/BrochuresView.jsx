import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePriceBrochures, useBrochureProducts } from '../lib/queries/index.js'
import { EmptyState, SkeletonRows } from '../components/ui.jsx'
import { Panel, PanelBody, PanelHead } from '../components/Panel.jsx'
import { Button } from '../components/Button.jsx'
import { Badge } from '../components/Badge.jsx'
import { IconSearch, IconWarning } from '../components/icons.jsx'
import { brandSuffix, prettyName, prettyUnit } from '../lib/productDisplay.js'
import {
  displayPrice,
  formatPrice,
  showsMemberPrice,
  promoBadges,
  referencePrice,
} from '../lib/pricesHelpers.js'
import { cn } from '../lib/cn.js'

const NONE = '—'

function observedDateLabel(date, language) {
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return date
  return parsed.toLocaleDateString(language, { day: 'numeric', month: 'long', year: 'numeric' })
}

function displayValue(value) {
  if (value == null) return NONE
  const text = String(value)
  return text === '' ? NONE : text
}

function confidenceLabel(value) {
  if (value == null || Number.isNaN(Number(value))) return NONE
  return `${Math.round(Number(value) * 100)}%`
}

// One brochure card: the 3:4 frame is reserved up front (no layout shift),
// the image is lazy, and a missing object degrades to a text fallback in the
// same frame — never a broken-image glyph. Selecting a card opens the review
// section below the grid; selecting it again closes it.
function BrochureCard({ group, selected, dateLabel, onSelect }) {
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)
  return (
    <button
      type="button"
      data-testid="brochure-card"
      aria-expanded={selected}
      aria-controls={selected ? 'brochure-review' : undefined}
      onClick={onSelect}
      className={cn(
        'group flex w-full flex-col overflow-hidden rounded-lg border bg-surface-raised text-left transition-colors',
        selected
          ? 'border-accent shadow-sm ring-2 ring-accent-soft'
          : 'border-border hover:border-border-strong'
      )}
    >
      <div
        className="relative w-full overflow-hidden bg-surface-sunken/40"
        style={{ aspectRatio: '3 / 4' }}
      >
        {!failed && (
          <img
            src={group.brochure_url}
            alt={t('prices.brochureAlt', { store: group.source_name })}
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
            onError={() => setFailed(true)}
          />
        )}
        {failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-3 text-center">
            <div className="text-sm font-medium">{group.source_name}</div>
            <div className="text-xs text-text-muted">
              {t('prices.productsCount', { count: group.product_count })}
            </div>
          </div>
        )}
        {selected && (
          <span className="absolute left-2 top-2 rounded-sm bg-accent px-2 py-0.5 text-xs font-semibold text-on-accent">
            {t('catalog.brochuresSelected')}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-0.5 p-2.5">
        <div className="truncate text-sm font-medium">{group.source_name}</div>
        <div className="text-xs text-text-muted">{dateLabel}</div>
        <div className="text-xs text-text-muted">
          {t('prices.productsCount', { count: group.product_count })}
        </div>
      </div>
    </button>
  )
}

function MetaField({ label, value, mono = false }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-text-muted">{label}</dt>
      <dd className={cn('mt-0.5 break-words text-sm', mono && 'font-mono text-xs')}>{value}</dd>
    </div>
  )
}

// The inline QA panel for one ingestion row (issue #630): every field the
// backend ships, verbatim. Product name and unit stay as ingested (not the
// display-normalized form) — this panel is the ground truth for ingestion
// review. No navigation: the row expands in place.
function BrochureProductMetadata({ product, brochureDateLabel }) {
  const { t } = useTranslation()
  return (
    <dl
      className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3"
      data-testid="brochure-product-metadata"
    >
      <MetaField
        label={t('catalog.metaProductKey')}
        value={displayValue(product.product_key)}
        mono
      />
      <MetaField label={t('catalog.metaName')} value={displayValue(product.name)} />
      <MetaField label={t('catalog.metaBrand')} value={displayValue(product.brand)} />
      <MetaField label={t('catalog.metaUnit')} value={displayValue(product.unit)} />
      <MetaField label={t('catalog.metaCategory')} value={displayValue(product.category)} />
      <MetaField
        label={t('catalog.metaCategoryVersion')}
        value={displayValue(product.category_version)}
      />
      <MetaField label={t('catalog.metaPrice')} value={formatPrice(product.price)} />
      <MetaField
        label={t('catalog.metaMemberPrice')}
        value={product.member_price == null ? NONE : formatPrice(product.member_price)}
      />
      <MetaField
        label={t('catalog.metaEffectiveUnitPrice')}
        value={
          product.effective_unit_price == null ? NONE : formatPrice(product.effective_unit_price)
        }
      />
      <MetaField label={t('catalog.metaPromoType')} value={displayValue(product.promo_type)} />
      <MetaField label={t('catalog.metaPromoLabel')} value={displayValue(product.promo_label)} />
      <MetaField label={t('catalog.metaValidFrom')} value={displayValue(product.valid_from)} />
      <MetaField label={t('catalog.metaValidUntil')} value={displayValue(product.valid_until)} />
      <MetaField label={t('catalog.metaMatchMethod')} value={displayValue(product.match_method)} />
      <MetaField
        label={t('catalog.metaMatchConfidence')}
        value={confidenceLabel(product.match_confidence)}
      />
      <MetaField label={t('catalog.metaStore')} value={displayValue(product.source_name)} />
      <MetaField label={t('catalog.metaSourceSlug')} value={displayValue(product.source_slug)} />
      <MetaField
        label={t('catalog.metaSourceWebsite')}
        value={displayValue(product.source_website)}
        mono
      />
      <MetaField
        label={t('catalog.metaObservedDate')}
        value={displayValue(product.observed_date)}
        mono
      />
      <MetaField label={t('catalog.metaBrochureDate')} value={brochureDateLabel} mono />
      <MetaField
        label={t('catalog.metaBrochureUrl')}
        value={displayValue(product.brochure_url)}
        mono
      />
      <MetaField label={t('catalog.metaScrapedAt')} value={displayValue(product.scraped_at)} mono />
    </dl>
  )
}

function BrochureProductsTable({ items, brochureDateLabel }) {
  const { t } = useTranslation()
  // One expanded metadata panel at a time keeps the table scannable; the
  // toggle button in the first cell is the keyboard path (the row click is a
  // pointer convenience).
  const [expandedKey, setExpandedKey] = useState(null)
  const toggle = (productKey) => setExpandedKey((prev) => (prev === productKey ? null : productKey))

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] border-collapse text-sm">
        <caption className="sr-only">{t('catalog.brochuresTableCaption')}</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs text-text-muted">
            <th scope="col" className="px-5 py-2.5 font-medium">
              {t('catalog.brochuresColumnName')}
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              {t('catalog.brochuresColumnUnit')}
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              {t('catalog.brochuresColumnPrice')}
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              {t('catalog.brochuresColumnEffective')}
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              {t('catalog.brochuresColumnPromo')}
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              {t('catalog.brochuresColumnCategory')}
            </th>
            <th scope="col" className="px-5 py-2.5 font-medium">
              {t('catalog.brochuresColumnMatch')}
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((product) => {
            const expanded = expandedKey === product.product_key
            const badges = promoBadges(product.promo_label, product.promo_type)
            const priceShown = displayPrice(product)
            const memberPriceShown = showsMemberPrice(product)
            const priceReference = referencePrice(product)
            const metaId = `brochure-product-meta-${product.product_key}`
            return (
              <Fragment key={product.product_key}>
                <tr
                  data-testid="brochure-product-row"
                  className="cursor-pointer border-b border-border transition-colors last:border-b-0 hover:bg-surface-sunken/60"
                  onClick={() => toggle(product.product_key)}
                >
                  <td className="px-5 py-3">
                    <button
                      type="button"
                      className="text-left font-medium hover:underline"
                      aria-expanded={expanded}
                      aria-controls={expanded ? metaId : undefined}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggle(product.product_key)
                      }}
                    >
                      {prettyName(product.name)}
                      {brandSuffix(product.name, product.brand)}
                    </button>
                  </td>
                  <td className="px-3 py-3 text-text-muted">
                    {product.unit ? prettyUnit(product.unit) : NONE}
                  </td>
                  <td className="px-3 py-3 tabular-nums">
                    {priceReference && (
                      <div
                        data-testid="shelf-reference-price"
                        title={memberPriceShown ? t('prices.shelfPrice') : undefined}
                        className={cn(
                          'text-xs text-text-muted',
                          priceReference.struck && 'line-through'
                        )}
                      >
                        {formatPrice(priceReference.price)}
                      </div>
                    )}
                    <div className="font-medium">{formatPrice(priceShown)}</div>
                    {memberPriceShown && (
                      <Badge tone="ok" className="mt-1">
                        {t('prices.memberPrice')}
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-3 tabular-nums text-text-muted">
                    {product.effective_unit_price == null
                      ? NONE
                      : formatPrice(product.effective_unit_price)}
                  </td>
                  <td className="px-3 py-3">
                    {badges.length > 0 ? (
                      <span className="flex flex-wrap gap-1">
                        {badges.map((badge, index) => (
                          <Badge key={`${index}-${badge.text}`} tone={badge.tone}>
                            {badge.text}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      NONE
                    )}
                  </td>
                  <td className="px-3 py-3 text-text-muted">{displayValue(product.category)}</td>
                  <td className="px-5 py-3 text-text-muted">
                    {displayValue(product.match_method)} ·{' '}
                    <span className="tabular-nums">
                      {confidenceLabel(product.match_confidence)}
                    </span>
                  </td>
                </tr>
                {expanded && (
                  <tr id={metaId} className="border-b border-border bg-surface-sunken/40">
                    <td colSpan={7} className="px-5 py-4">
                      <BrochureProductMetadata
                        product={product}
                        brochureDateLabel={brochureDateLabel}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// The full-width review section for the selected brochure. Fetching is lazy:
// the query only runs when a card is selected; pages append 50 rows at a
// time with "Showing N of M" and a Load more action while pages remain.
function BrochureReview({ group, dateLabel }) {
  const { t } = useTranslation()
  const { data, isLoading, isError, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useBrochureProducts(group.brochure_url)
  const items = data?.items ?? []
  const total = data?.total ?? 0

  return (
    <section
      id="brochure-review"
      role="region"
      aria-label={t('catalog.brochuresReviewAria', {
        store: group.source_name,
        date: dateLabel,
      })}
      className="mt-6"
    >
      <Panel>
        <PanelHead>
          <div className="min-w-0">
            <h3 className="font-medium">{t('catalog.brochuresReviewTitle')}</h3>
            <p className="mt-0.5 text-xs text-text-muted">
              {group.source_name} · {dateLabel}
            </p>
          </div>
          <span className="shrink-0 text-sm text-text-muted">
            {t('prices.productsCount', { count: group.product_count })}
          </span>
        </PanelHead>
        {isLoading ? (
          <PanelBody>
            <SkeletonRows n={5} />
          </PanelBody>
        ) : isError ? (
          <PanelBody>
            <EmptyState
              icon={IconWarning}
              title={t('catalog.brochuresProductsError')}
              desc={t('offline.banner')}
            />
          </PanelBody>
        ) : items.length === 0 ? (
          <PanelBody>
            <EmptyState
              icon={IconSearch}
              title={t('catalog.brochuresProductsEmpty')}
              desc={t('catalog.brochuresProductsEmptyDesc')}
            />
          </PanelBody>
        ) : (
          <>
            <BrochureProductsTable items={items} brochureDateLabel={dateLabel} />
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
              <span className="text-xs text-text-muted" role="status">
                {t('catalog.brochuresShowing', { shown: items.length, total })}
              </span>
              {hasNextPage && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                >
                  {t('catalog.brochuresLoadMore')}
                </Button>
              )}
            </div>
          </>
        )}
      </Panel>
    </section>
  )
}

// The admin ingestion-QA browser (issue #630, moved to /admin/catalog by
// #631): filter the catalog by store and observed date, browse a responsive
// grid of brochure cards, then review EVERY current product on the selected
// brochure in a full-width table. A row expands its full ingestion metadata
// in place — no jump into the Products explorer.
export function BrochuresView() {
  const { t, i18n } = useTranslation()
  const { data, isLoading, isError } = usePriceBrochures()

  const [store, setStore] = useState(null)
  const [date, setDate] = useState(null)
  const [selectedUrl, setSelectedUrl] = useState(null)

  const groups = data?.groups ?? []

  // Options come from the unfiltered catalog so both filters remain
  // composable after one is applied (picking a store must not erase the
  // dates it still has).
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

  // A filtered-out selection hides the review section (and stops its query);
  // restoring the filters brings the same brochure back.
  const selected = filtered.find((group) => group.brochure_url === selectedUrl) ?? null
  const toggleSelected = (url) => setSelectedUrl((prev) => (prev === url ? null : url))
  const resetFilters = () => {
    setStore(null)
    setDate(null)
  }

  if (isLoading) {
    return (
      <Panel>
        <SkeletonRows n={5} />
      </Panel>
    )
  }
  if (isError) {
    return (
      <Panel>
        <EmptyState icon={IconWarning} title={t('prices.noMatch')} desc={t('offline.banner')} />
      </Panel>
    )
  }
  if (groups.length === 0) {
    return (
      <Panel>
        <EmptyState
          icon={IconSearch}
          title={t('prices.brochuresEmpty')}
          desc={t('prices.brochuresEmptyDesc')}
        />
      </Panel>
    )
  }

  return (
    <div className="flex flex-col">
      <Panel className="mb-5">
        <PanelBody>
          <div
            className="flex flex-wrap items-end gap-4"
            role="group"
            aria-label={t('catalog.brochuresFilters')}
            data-testid="brochure-filters"
          >
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-text-muted">
                {t('catalog.brochuresFilterStore')}
              </span>
              <select
                data-testid="brochure-store-filter"
                value={store ?? ''}
                onChange={(event) => setStore(event.target.value || null)}
                className="rounded-md border border-border bg-surface-raised px-2 py-1.5 text-sm outline-none focus:border-accent"
              >
                <option value="">{t('catalog.brochuresAllStores')}</option>
                {stores.map((option) => (
                  <option key={option.slug} value={option.slug}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-text-muted">
                {t('catalog.brochuresFilterDate')}
              </span>
              <select
                data-testid="brochure-date-filter"
                value={date ?? ''}
                onChange={(event) => setDate(event.target.value || null)}
                className="rounded-md border border-border bg-surface-raised px-2 py-1.5 text-sm outline-none focus:border-accent"
              >
                <option value="">{t('catalog.brochuresAllDates')}</option>
                {dates.map((option) => (
                  <option key={option} value={option}>
                    {observedDateLabel(option, i18n.language)}
                  </option>
                ))}
              </select>
            </label>
            <div className="ml-auto flex items-center gap-2 text-sm text-text-muted">
              <span data-testid="brochures-summary">
                {t('catalog.brochuresCount', { count: filtered.length })} ·{' '}
                {t('prices.productsCount', { count: filteredProducts })}
              </span>
            </div>
          </div>
        </PanelBody>
      </Panel>

      {filtered.length === 0 ? (
        <Panel>
          <EmptyState
            icon={IconSearch}
            title={t('catalog.brochuresFilteredEmpty')}
            desc={t('catalog.brochuresFilteredEmptyDesc')}
          />
          <div className="flex justify-center pb-5">
            <Button variant="secondary" size="sm" onClick={resetFilters}>
              {t('catalog.brochuresResetFilters')}
            </Button>
          </div>
        </Panel>
      ) : (
        <div
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4"
          data-testid="brochures-grid"
        >
          {filtered.map((group) => (
            <BrochureCard
              key={group.brochure_url}
              group={group}
              selected={group.brochure_url === selectedUrl}
              dateLabel={observedDateLabel(group.observed_date, i18n.language)}
              onSelect={() => toggleSelected(group.brochure_url)}
            />
          ))}
        </div>
      )}

      {filtered.length > 0 && selected == null && (
        <p className="mt-4 text-sm text-text-muted" data-testid="brochures-select-hint">
          {t('catalog.brochuresSelectHint')}
        </p>
      )}

      {selected != null && (
        <BrochureReview
          key={selected.brochure_url}
          group={selected}
          dateLabel={observedDateLabel(selected.observed_date, i18n.language)}
        />
      )}
    </div>
  )
}
