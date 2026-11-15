import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePriceBrochures } from '../lib/queries/index.js'
import { EmptyState, SkeletonRows } from '../components/ui.jsx'
import { Panel, PanelBody } from '../components/Panel.jsx'
import { Button } from '../components/Button.jsx'
import { IconSearch, IconWarning } from '../components/icons.jsx'
import { observedDateLabel } from '../lib/pricesHelpers.js'

// One gallery card (issue #673): the 3:4 frame is reserved up front (no
// layout shift), the image is lazy, and a missing object degrades to a text
// fallback in the same frame — never a broken-image glyph. Browse-only: no
// selection affordances and none of the #630 QA fields; the full-mode viewer
// link ships with #674.
function UserBrochureCard({ group, dateLabel }) {
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)
  return (
    <div
      data-testid="brochure-card"
      className="flex w-full flex-col overflow-hidden rounded-lg border border-border bg-surface-raised"
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
      </div>
      <div className="flex flex-col gap-0.5 p-2.5">
        <div className="truncate text-sm font-medium">{group.source_name}</div>
        <div className="text-xs text-text-muted">{dateLabel}</div>
        <div className="text-xs text-text-muted">
          {t('prices.productsCount', { count: group.product_count })}
        </div>
      </div>
    </div>
  )
}

// The user-facing brochure gallery (/prices?view=brochures, issue #673):
// filter the catalog by store and observed date, browse a responsive grid of
// current brochure pages. Lean by design — no match/confidence columns, no
// ingestion metadata, no per-brochure product table; that QA surface stays
// admin-side on /admin/catalog's Brochures QA tab.
export function BrochuresGallery() {
  const { t, i18n } = useTranslation()
  const { data, isLoading, isError } = usePriceBrochures()

  const [store, setStore] = useState(null)
  const [date, setDate] = useState(null)

  // Memoized so the stores/dates/filtered memos keyed on `groups` keep a
  // stable array identity between fetches (react-hooks/exhaustive-deps).
  const groups = useMemo(() => data?.groups ?? [], [data])

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
            <UserBrochureCard
              key={group.brochure_url}
              group={group}
              dateLabel={observedDateLabel(group.observed_date, i18n.language)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
