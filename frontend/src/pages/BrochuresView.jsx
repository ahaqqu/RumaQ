import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePriceBrochures } from '../lib/queries/index.js'
import { EmptyState, SkeletonRows } from '../components/ui.jsx'
import { Panel } from '../components/Panel.jsx'
import { IconSearch, IconWarning } from '../components/icons.jsx'
import { formatPrice } from '../lib/pricesHelpers.js'

// The API returns groups store-name-asc, date-desc, url-asc — adjacent runs
// of the same source slice into store sections with no client re-sort.
function sectionBySource(groups) {
  const sections = []
  for (const group of groups) {
    const last = sections[sections.length - 1]
    if (last && last.source_slug === group.source_slug) {
      last.groups.push(group)
    } else {
      sections.push({
        source_slug: group.source_slug,
        source_name: group.source_name,
        groups: [group],
      })
    }
  }
  return sections
}

function observedDateLabel(date, language) {
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return date
  return parsed.toLocaleDateString(language, { day: 'numeric', month: 'long', year: 'numeric' })
}

// One brochure card: a 3:4 frame that always reserves its space (no layout
// shift), a lazy native img, and a fallback block in the same frame when the
// object is missing (404) — never a broken-image glyph (PM AC 6).
function BrochureCard({ group, expanded, onToggle, onJump }) {
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)
  return (
    <div>
      <button
        className="w-full text-left"
        aria-expanded={expanded}
        onClick={onToggle}
        data-testid="brochure-card"
      >
        <div
          className="relative w-full overflow-hidden rounded-md border border-border bg-surface-sunken/40"
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
        <div className="mt-1 text-xs text-text-muted">
          {group.source_name} · {t('prices.productsCount', { count: group.product_count })}
        </div>
      </button>
      {expanded && (
        <div className="mt-1 flex flex-col rounded-md border border-border bg-surface-sunken/40 px-3 py-2">
          <div className="text-xs text-text-muted mb-1">{t('prices.showExamples')}</div>
          {(group.example_products ?? []).map((product) => {
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
                <span className="min-w-0 text-sm font-medium truncate">
                  {product.name}
                  {product.brand ? ` · ${product.brand}` : ''}
                </span>
                <span className="flex flex-col items-end shrink-0">
                  <span className="text-sm font-semibold tabular-nums">
                    {formatPrice(product.price)}
                  </span>
                  {perUnit && <span className="text-xs text-text-muted">{perUnit}</span>}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// The brochures view ("the actual page behind the price" — issue #293):
// store sections in chip-bar order, date-desc subgroups, 3:4 card grids,
// multi-expand, example click jumps into the Products explorer.
export function BrochuresView({ onJump }) {
  const { t, i18n } = useTranslation()
  const { data, isLoading, isError } = usePriceBrochures()
  // Multi-expand (independent Set): opening one brochure must not close
  // another — a browse view (PM §4).
  const [expanded, setExpanded] = useState(() => new Set())
  const toggle = (key) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const sections = useMemo(() => sectionBySource(data?.groups ?? []), [data])

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
  if (sections.length === 0) {
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
    <div className="flex flex-col gap-6">
      {sections.map((section) => (
        <section key={section.source_slug}>
          <h3 className="font-medium mb-3">{section.source_name}</h3>
          <div className="flex flex-col gap-4">
            {section.groups.map((group) => (
              <div key={group.brochure_url}>
                <div className="text-xs text-text-muted mb-2">
                  {observedDateLabel(group.observed_date, i18n.language)}
                </div>
                <div
                  className="grid gap-3"
                  style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
                >
                  <BrochureCard
                    group={group}
                    expanded={expanded.has(group.brochure_url)}
                    onToggle={() => toggle(group.brochure_url)}
                    onJump={onJump}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
