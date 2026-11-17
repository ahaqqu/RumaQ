import { useTranslation } from 'react-i18next'
import { usePriceBrochures } from '../lib/queries/index.js'
import { EmptyState, SkeletonRows } from '../components/ui.jsx'
import { Panel } from '../components/Panel.jsx'
import { Button } from '../components/Button.jsx'
import { IconSearch, IconWarning } from '../components/icons.jsx'
import { brochureViewerUrl, observedDateLabel } from '../lib/pricesHelpers.js'
import { errorKindKey } from '../lib/errorKind.js'
import { useBrochureCatalogFilters } from './useBrochureCatalogFilters.js'
import { BrochuresFilterPanel } from './BrochuresFilterPanel.jsx'
import { BrochureCard } from './BrochureCard.jsx'

// The user-facing brochure gallery (/prices?view=brochures, issue #673):
// filter the catalog by store and observed date, browse a responsive grid of
// current brochure pages. Lean by design — no match/confidence columns, no
// ingestion metadata, no per-brochure product table; that QA surface stays
// admin-side on /admin/catalog's Brochures QA tab (whose cards open the same
// viewer with ?admin=true, #716). The View link's viewer shows the
// brochure's items as a lean table with no admin affordances (#716). Filters
// and the grid share the catalog-filter machinery with the QA view
// (useBrochureCatalogFilters + BrochuresFilterPanel).
export function BrochuresGallery() {
  const { t, i18n } = useTranslation()
  const { data, isLoading, isError, error } = usePriceBrochures()
  const filters = useBrochureCatalogFilters(data)
  const { groups, filtered, resetFilters } = filters

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
        <EmptyState icon={IconWarning} title={t('prices.noMatch')} desc={t(errorKindKey(error))} />
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
      <BrochuresFilterPanel filters={filters} />

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
              dateLabel={observedDateLabel(group.observed_date, i18n.language)}
              viewerUrl={brochureViewerUrl(group.brochure_url)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
