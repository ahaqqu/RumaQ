import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBrochureProducts } from '../lib/queries/index.js'
import { EmptyState, SkeletonRows } from '../components/ui.jsx'
import { Panel, PanelBody, PanelHead } from '../components/Panel.jsx'
import { Button } from '../components/Button.jsx'
import { Badge } from '../components/Badge.jsx'
import { IconSearch, IconWarning } from '../components/icons.jsx'
import { brandSuffix, prettyName, prettyUnit } from '../lib/productDisplay.js'
import {
  displayPrice,
  formatPrice,
  promoBadges,
  referencePrice,
  showsMemberPrice,
} from '../lib/pricesHelpers.js'
import { cn } from '../lib/cn.js'
import { errorKindKey } from '../lib/errorKind.js'
import { NONE, MetadataDl, MetaField, confidenceLabel, displayValue } from './QaMetadata.jsx'

// Per-variant copy for the brochure items panel (issue #716): 'qa' is the
// admin ingestion table (every column, expandable rows with the full metadata
// — the #630 affordance); 'lean' is the user-facing items-only list the
// viewer renders from /prices — no QA columns, no expand.
const VARIANT_KEYS = {
  qa: {
    aria: 'catalog.brochuresReviewAria',
    caption: 'catalog.brochuresTableCaption',
    empty: 'catalog.brochuresProductsEmpty',
    emptyDesc: 'catalog.brochuresProductsEmptyDesc',
  },
  lean: {
    aria: 'prices.viewerItemsAria',
    caption: 'prices.viewerItemsCaption',
    empty: 'prices.viewerItemsEmpty',
    emptyDesc: 'prices.viewerItemsEmptyDesc',
  },
}

// The inline QA panel for one ingestion row (issue #630): every field the
// backend ships, verbatim. Product name and unit stay as ingested (not the
// display-normalized form) — this panel is the ground truth for ingestion
// review. No navigation: the row expands in place.
function BrochureProductMetadata({ product, brochureDateLabel }) {
  const { t } = useTranslation()
  return (
    <MetadataDl testId="brochure-product-metadata">
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
    </MetadataDl>
  )
}

// One table, two audiences (issue #716): variant 'qa' keeps every #630 column
// and expands a row into its ingestion metadata; variant 'lean' — the
// /prices viewer's items-only panel — keeps the shopper columns (name, unit,
// price, promo) and drops the QA ones (effective unit price, category, match)
// together with the expand affordance, matching the #673 lean-by-design rule
// that the user surface renders none of the ingestion fields. The default is
// 'lean' so a future caller that forgets the prop can never leak QA columns.
function BrochureProductsTable({ items, brochureDateLabel, variant = 'lean' }) {
  const { t } = useTranslation()
  // One expanded metadata panel at a time keeps the table scannable; the
  // toggle button in the first cell is the keyboard path (the row click is a
  // pointer convenience).
  const [expandedKey, setExpandedKey] = useState(null)
  const toggle = (productKey) => setExpandedKey((prev) => (prev === productKey ? null : productKey))
  const lean = variant === 'lean'

  return (
    <div className="overflow-x-auto">
      {/* The QA table needs its seven columns; the lean table keeps a tighter
      floor so the viewer's phone-first column scrolls less. */}
      <table
        className={cn('w-full border-collapse text-sm', lean ? 'min-w-[520px]' : 'min-w-[900px]')}
      >
        <caption className="sr-only">{t(VARIANT_KEYS[variant].caption)}</caption>
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
            {!lean && (
              <th scope="col" className="px-3 py-2.5 font-medium">
                {t('catalog.brochuresColumnEffective')}
              </th>
            )}
            <th scope="col" className="px-3 py-2.5 font-medium">
              {t('catalog.brochuresColumnPromo')}
            </th>
            {!lean && (
              <th scope="col" className="px-3 py-2.5 font-medium">
                {t('catalog.brochuresColumnCategory')}
              </th>
            )}
            {!lean && (
              <th scope="col" className="px-5 py-2.5 font-medium">
                {t('catalog.brochuresColumnMatch')}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((product) => {
            const expanded = !lean && expandedKey === product.product_key
            const badges = promoBadges(product.promo_label, product.promo_type)
            const priceShown = displayPrice(product)
            const memberPriceShown = showsMemberPrice(product)
            const priceReference = referencePrice(product)
            const metaId = `brochure-product-meta-${product.product_key}`
            return (
              <Fragment key={product.product_key}>
                <tr
                  data-testid="brochure-product-row"
                  className={cn(
                    'border-b border-border transition-colors last:border-b-0',
                    lean
                      ? 'hover:bg-surface-sunken/60'
                      : 'cursor-pointer hover:bg-surface-sunken/60'
                  )}
                  onClick={lean ? undefined : () => toggle(product.product_key)}
                >
                  <td className="px-5 py-3">
                    {lean ? (
                      <span className="font-medium">
                        {prettyName(product.name)}
                        {brandSuffix(product.name, product.brand)}
                      </span>
                    ) : (
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
                    )}
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
                  {!lean && (
                    <td className="px-3 py-3 tabular-nums text-text-muted">
                      {product.effective_unit_price == null
                        ? NONE
                        : formatPrice(product.effective_unit_price)}
                    </td>
                  )}
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
                  {!lean && (
                    <td className="px-3 py-3 text-text-muted">{displayValue(product.category)}</td>
                  )}
                  {!lean && (
                    <td className="px-5 py-3 text-text-muted">
                      {displayValue(product.match_method)} ·{' '}
                      <span className="tabular-nums">
                        {confidenceLabel(product.match_confidence)}
                      </span>
                    </td>
                  )}
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

// The full-width review section for the selected brochure (the #630 QA
// surface, reused by the chrome-less viewer's items panel — issue #716).
// Fetching is driven by the brochure_url: pages append 50 rows at a time with
// "Showing N of M" and a Load more action while pages remain. The head count
// prefers the catalog group's product_count (instant on the QA tab) and falls
// back to the query total once it loads (the viewer may render before the
// catalog has resolved). The variant defaults to 'lean' (#673): the QA table
// must be opted into explicitly, never arrived at by forgetting a prop.
export function BrochureReview({ group, dateLabel, variant = 'lean' }) {
  const { t } = useTranslation()
  const { data, isLoading, isError, error, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useBrochureProducts(group.brochure_url)
  const items = data?.items ?? []
  const total = data?.total ?? 0
  const headCount = group.product_count ?? (isLoading ? null : total)
  const copy = VARIANT_KEYS[variant]

  return (
    <section
      id="brochure-review"
      role="region"
      aria-label={t(copy.aria, {
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
          {headCount != null && (
            <span className="shrink-0 text-sm text-text-muted">
              {t('prices.productsCount', { count: headCount })}
            </span>
          )}
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
              desc={t(errorKindKey(error))}
            />
          </PanelBody>
        ) : items.length === 0 ? (
          <PanelBody>
            <EmptyState icon={IconSearch} title={t(copy.empty)} desc={t(copy.emptyDesc)} />
          </PanelBody>
        ) : (
          <>
            <BrochureProductsTable items={items} brochureDateLabel={dateLabel} variant={variant} />
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
