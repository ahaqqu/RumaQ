import { Fragment, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePromoReview, usePriceSources } from '../lib/queries/index.js'
import { EmptyState, SkeletonRows } from '../components/ui.jsx'
import { Panel, PanelBody } from '../components/Panel.jsx'
import { Button } from '../components/Button.jsx'
import { Badge } from '../components/Badge.jsx'
import { IconSearch, IconWarning } from '../components/icons.jsx'
import { brandSuffix, prettyName, prettyUnit } from '../lib/productDisplay.js'
import { formatPrice, promoChipClass, splitPromoChips } from '../lib/pricesHelpers.js'
import { errorKindKey } from '../lib/errorKind.js'
import { NONE, MetadataDl, MetaField, confidenceLabel, displayValue } from './QaMetadata.jsx'

// i18n key per chip class — presentation-only tags over the verbatim chip
// text (issue #717): the OCR-QA report's promo-semantics families
// (ahaqqu/RumaQ-pipeline#164 F3/F4/F5) surfaced as labels. The tags name a
// family for the owner's review; they never change any price behavior.
const CHIP_CLASS_LABEL_KEYS = {
  dated: 'catalog.promoChipClassDated',
  bogo: 'catalog.promoChipClassBogo',
  multiBuy: 'catalog.promoChipClassMultiBuy',
  limit: 'catalog.promoChipClassLimit',
  discount: 'catalog.promoChipClassDiscount',
  priceLabel: 'catalog.promoChipClassPriceLabel',
  other: 'catalog.promoChipClassOther',
}

// Fixed display order for a row's class tags ('other' last).
const CHIP_CLASS_ORDER = ['dated', 'bogo', 'multiBuy', 'limit', 'discount', 'priceLabel', 'other']

// Sort orders the owner flips between while spotting chip classes (issue
// #717): `date` fronts the latest scrape run, `store` groups one store's
// items, `name` groups one item across stores.
const SORT_OPTIONS = [
  { value: 'date', key: 'catalog.promosSortDate' },
  { value: 'store', key: 'catalog.promosSortStore' },
  { value: 'name', key: 'catalog.promosSortName' },
]

function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

// The verbatim chips of one row: the shared '; '-wire-format split
// (splitPromoChips) — casing and spacing untouched, footnotes kept (issue
// #717: the owner reviews the pipeline's raw output, so nothing is normalized
// or dropped here; this is deliberately NOT the shopper-facing promoBadges
// chain, which title-cases and hides footnote markers).
function PromoChips({ label, type }) {
  const { t } = useTranslation()
  const chips = splitPromoChips(label)
  if (chips.length === 0) {
    // A type with no label still counts as promo evidence — show the parsed
    // type so the row never renders an empty promo column.
    return type ? <Badge tone="muted">{type}</Badge> : NONE
  }
  const classes = [...new Set(chips.map((chip) => promoChipClass(chip)))]
  const ordered = CHIP_CLASS_ORDER.filter((key) => classes.includes(key))
  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap gap-1">
        {chips.map((chip, index) => (
          <Badge key={`${index}-${chip}`} tone="muted" data-testid="promo-review-chip">
            {chip}
          </Badge>
        ))}
      </span>
      {ordered.length > 0 && (
        <span className="text-xs text-text-muted" data-testid="promo-review-chip-classes">
          {ordered.map((key) => t(CHIP_CLASS_LABEL_KEYS[key])).join(' · ')}
        </span>
      )}
    </span>
  )
}

// The expanded metadata for one review row — every field the endpoint ships,
// verbatim (the BrochureReview #630 affordance). Product name and unit stay
// as ingested; the chips live in the row above them.
function PromoReviewMetadata({ item }) {
  const { t } = useTranslation()
  return (
    <MetadataDl testId="promo-review-metadata">
      <MetaField label={t('catalog.metaProductKey')} value={displayValue(item.product_key)} mono />
      <MetaField label={t('catalog.metaName')} value={displayValue(item.name)} />
      <MetaField label={t('catalog.metaBrand')} value={displayValue(item.brand)} />
      <MetaField label={t('catalog.metaUnit')} value={displayValue(item.unit)} />
      <MetaField label={t('catalog.metaStore')} value={displayValue(item.source_name)} />
      <MetaField label={t('catalog.metaSourceSlug')} value={displayValue(item.source_slug)} mono />
      <MetaField
        label={t('catalog.metaObservedDate')}
        value={displayValue(item.observed_date)}
        mono
      />
      <MetaField label={t('catalog.metaPrice')} value={formatPrice(item.price)} />
      <MetaField
        label={t('catalog.metaMemberPrice')}
        value={item.member_price == null ? NONE : formatPrice(item.member_price)}
      />
      <MetaField
        label={t('catalog.metaEffectiveUnitPrice')}
        value={item.effective_unit_price == null ? NONE : formatPrice(item.effective_unit_price)}
      />
      <MetaField label={t('catalog.metaPromoType')} value={displayValue(item.promo_type)} mono />
      <MetaField label={t('catalog.metaPromoLabel')} value={displayValue(item.promo_label)} />
      <MetaField label={t('catalog.metaValidFrom')} value={displayValue(item.valid_from)} mono />
      <MetaField label={t('catalog.metaValidUntil')} value={displayValue(item.valid_until)} mono />
      <MetaField label={t('catalog.metaMatchMethod')} value={displayValue(item.match_method)} />
      <MetaField
        label={t('catalog.metaMatchConfidence')}
        value={confidenceLabel(item.match_confidence)}
      />
      <MetaField
        label={t('catalog.metaBrochureUrl')}
        value={displayValue(item.brochure_url)}
        mono
      />
      <MetaField label={t('catalog.metaScrapedAt')} value={displayValue(item.scraped_at)} mono />
    </MetadataDl>
  )
}

// The promo review table (issue #717): one row per (product, store) at its
// current offer, the verbatim chips in the promo column, expandable metadata.
// One expanded row at a time keeps the list scannable; the toggle button in
// the first cell is the keyboard path (the row click is a pointer
// convenience) — the BrochureReview QA affordance.
function PromoReviewTable({ items }) {
  const { t } = useTranslation()
  const [expandedKey, setExpandedKey] = useState(null)
  const toggle = (key) => setExpandedKey((prev) => (prev === key ? null : key))

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] border-collapse text-sm">
        <caption className="sr-only">{t('catalog.promosReviewTableCaption')}</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs text-text-muted">
            <th scope="col" className="px-5 py-2.5 font-medium">
              {t('catalog.brochuresColumnName')}
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              {t('catalog.promosColumnStore')}
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              {t('catalog.brochuresColumnPrice')}
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              {t('catalog.brochuresColumnPromo')}
            </th>
            <th scope="col" className="px-5 py-2.5 font-medium">
              {t('catalog.promosColumnPeriod')}
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const metaId = `promo-review-meta-${item.product_key}-${item.source_slug}`
            const expanded = expandedKey === metaId
            return (
              <Fragment key={metaId}>
                <tr
                  data-testid="promo-review-row"
                  className="cursor-pointer border-b border-border transition-colors last:border-b-0 hover:bg-surface-sunken/60"
                  onClick={() => toggle(metaId)}
                >
                  <td className="px-5 py-3">
                    <button
                      type="button"
                      className="text-left font-medium hover:underline"
                      aria-expanded={expanded}
                      aria-controls={expanded ? metaId : undefined}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggle(metaId)
                      }}
                    >
                      {prettyName(item.name)}
                      {brandSuffix(item.name, item.brand)}
                    </button>
                    {item.unit && (
                      <div className="mt-0.5 text-xs text-text-muted">{prettyUnit(item.unit)}</div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-text-muted">{item.source_name}</td>
                  <td className="px-3 py-3">
                    <div className="font-medium tabular-nums">{formatPrice(item.price)}</div>
                    {item.member_price != null && item.member_price < item.price && (
                      <div className="mt-0.5 text-xs text-text-muted tabular-nums">
                        {formatPrice(item.member_price)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <PromoChips label={item.promo_label} type={item.promo_type} />
                  </td>
                  <td className="px-5 py-3 text-xs text-text-muted tabular-nums">
                    {item.valid_from || item.valid_until ? (
                      <>
                        {displayValue(item.valid_from)} → {displayValue(item.valid_until)}
                        <div className="mt-0.5">{displayValue(item.observed_date)}</div>
                      </>
                    ) : (
                      displayValue(item.observed_date)
                    )}
                  </td>
                </tr>
                {expanded && (
                  <tr id={metaId} className="border-b border-border bg-surface-sunken/40">
                    <td colSpan={5} className="px-5 py-4">
                      <PromoReviewMetadata item={item} />
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

// The promo review surface (issue #717): every current promo-evidence
// observation listed per item with its verbatim chips, filterable by store
// and by promo/item text, sortable by date/store/name. The pagination, empty
// and error affordances mirror the per-brochure QA list (BrochureReview).
export function PromosReview() {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [source, setSource] = useState(null)
  const [sort, setSort] = useState('date')
  const debouncedSearch = useDebouncedValue(search.trim(), 300)

  const { data, isLoading, isError, error, hasNextPage, fetchNextPage, isFetchingNextPage } =
    usePromoReview({ q: debouncedSearch || undefined, source, sort })
  const { data: sources } = usePriceSources()

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const filtered = debouncedSearch !== '' || source != null

  return (
    <Panel>
      <PanelBody>
        <div
          className="flex flex-wrap items-end gap-4"
          role="group"
          aria-label={t('catalog.promosReviewFilters')}
          data-testid="promo-review-filters"
        >
          <label className="flex min-w-[220px] flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-text-muted">
              {t('catalog.promosFilterSearch')}
            </span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('catalog.promosSearchPlaceholder')}
              aria-label={t('catalog.promosSearchAria')}
              className="w-full rounded-md border border-border bg-surface-raised px-3 py-1.5 text-sm outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-muted">
              {t('catalog.promosFilterStore')}
            </span>
            <select
              data-testid="promo-review-store-filter"
              value={source ?? ''}
              onChange={(event) => setSource(event.target.value || null)}
              className="rounded-md border border-border bg-surface-raised px-2 py-1.5 text-sm outline-none focus:border-accent"
            >
              <option value="">{t('catalog.brochuresAllStores')}</option>
              {(sources ?? []).map((option) => (
                <option key={option.slug} value={option.slug}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-muted">
              {t('catalog.promosFilterSort')}
            </span>
            <select
              data-testid="promo-review-sort"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
              className="rounded-md border border-border bg-surface-raised px-2 py-1.5 text-sm outline-none focus:border-accent"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.key)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </PanelBody>
      {isLoading ? (
        <PanelBody>
          <SkeletonRows n={5} />
        </PanelBody>
      ) : isError ? (
        <PanelBody>
          <EmptyState
            icon={IconWarning}
            title={t('catalog.promosReviewError')}
            desc={t(errorKindKey(error))}
          />
        </PanelBody>
      ) : items.length === 0 ? (
        <PanelBody>
          <EmptyState
            icon={IconSearch}
            title={t('catalog.promosReviewEmpty')}
            desc={t(
              filtered ? 'catalog.promosReviewFilteredEmptyDesc' : 'catalog.promosReviewEmptyDesc'
            )}
          />
        </PanelBody>
      ) : (
        <>
          <PromoReviewTable items={items} />
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
  )
}
