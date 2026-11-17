import { useState } from 'react'
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

// One brochure card: the 3:4 frame is reserved up front (no layout shift),
// the image is lazy, and a missing object degrades to a text fallback in the
// same frame — never a broken-image glyph. The whole card is the link into
// the chrome-less viewer (issue #716): it opens in a NEW TAB with
// ?admin=true so the viewer renders the QA items panel with expandable rows
// — normal new-tab semantics (middle-click/ctrl-click) apply.
function BrochureCard({ group, dateLabel, viewerUrl }) {
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)
  return (
    <a
      href={viewerUrl}
      target="_blank"
      rel="noreferrer"
      data-testid="brochure-card"
      className="group flex w-full flex-col overflow-hidden rounded-lg border border-border bg-surface-raised text-left transition-colors hover:border-border-strong"
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
    </a>
  )
}

// The admin ingestion-QA browser (issue #630, moved to /admin/catalog by
// #631): filter the catalog by store and observed date and browse a
// responsive grid of brochure cards. Since #716 selecting a card opens the
// chrome-less viewer in a NEW TAB (?admin=true) — the full product table with
// expandable ingestion metadata lives there now, replacing the former
// in-place review section. The filter machinery and panel are shared with the
// user gallery (useBrochureCatalogFilters + BrochuresFilterPanel).
export function BrochuresView() {
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
              viewerUrl={brochureViewerUrl(group.brochure_url, { admin: true })}
            />
          ))}
        </div>
      )}
    </div>
  )
}
