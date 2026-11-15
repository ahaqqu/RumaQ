import { useTranslation } from 'react-i18next'
import { Panel, PanelBody } from '../components/Panel.jsx'
import { observedDateLabel } from '../lib/pricesHelpers.js'

// The filter panel shared by the two brochure surfaces (user gallery +
// admin QA view): store/date selects whose options stay composable plus the
// filtered brochure/product counts. `filters` is the object returned by
// useBrochureCatalogFilters — the state/memo machinery and this markup were
// extracted together (#674, the #679 review B1) so the surfaces render one
// panel and cannot drift.
export function BrochuresFilterPanel({ filters }) {
  const { t, i18n } = useTranslation()
  const { stores, dates, store, setStore, date, setDate, filtered, filteredProducts } = filters

  return (
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
  )
}
