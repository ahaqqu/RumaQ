import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import { useMe } from '../lib/queries/me.js'
import { usePriceSources } from '../lib/queries/index.js'
import { useReviewItems, useDecideReview, useUndoReview } from '../lib/queries/review.js'
import { fetchReviewExport } from '../lib/api'
import { EmptyState, SkeletonRows } from '../components/ui.jsx'
import { Panel, PanelHead, PanelBody } from '../components/Panel.jsx'
import { Chip } from '../components/Chip.jsx'
import { Button } from '../components/Button.jsx'
import { formatPrice } from '../lib/pricesHelpers.js'
import { cn } from '../lib/cn.js'
import { IconWarning, IconReview, IconDownload } from '../components/icons.jsx'

// Match review queue (issue #294): a triage work queue for pairs the matcher
// flagged — see the actual candidates side by side, record a verdict, keep
// the record. v1 decisions change nothing downstream; the muted note on the
// page says so (docs/294-design-pm.md §4).

const FILTERS = ['pending', 'approved', 'rejected', 'all']

function formatClock(iso, locale) {
  return new Date(iso).toLocaleString(locale, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function reasonKey(reason) {
  return reason === 'price_ratio' ? 'review.reasonPriceRatio' : 'review.reasonVerifierUnresolved'
}

function methodKey(method) {
  const cap = method.charAt(0).toUpperCase() + method.slice(1)
  return `review.method${cap}`
}

// PM asymmetry note (§2): B is NOT a parallel observation of the same
// instant — it is the canonical entry's most recent sighting. The honest
// column labels ("Matched item" / "Catalog entry (last seen)") carry that.
function SideCard({ label, name, brand, unit, price, store }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1.5">
        {label}
      </div>
      <div className="text-sm font-medium leading-snug">{name}</div>
      <div className="text-xs text-text-muted mt-1">
        {brand ?? '—'} · {unit ?? '—'}
      </div>
      <div className="text-sm mt-1.5">{formatPrice(price)}</div>
      <div className="text-xs text-text-muted mt-0.5">{store}</div>
    </div>
  )
}

function ReviewRow({ item, sourceNames, busy, onDecide, onUndo }) {
  const { t, i18n } = useTranslation()
  const decided = item.status !== 'pending'
  const runTo = item.runId ? `/admin/prices?run=${encodeURIComponent(item.runId)}` : '/admin/prices'
  return (
    <div className="border-b border-border last:border-b-0 px-5 py-4">
      <div className="flex items-stretch gap-4">
        <SideCard
          label={t('review.matchedItem')}
          name={item.itemName}
          brand={item.itemBrand}
          unit={item.itemUnit}
          price={item.itemPrice}
          store={sourceNames[item.itemStore] ?? item.itemStore}
        />
        <div className="self-stretch w-px bg-border" aria-hidden="true" />
        <SideCard
          label={t('review.catalogEntry')}
          name={item.entryName}
          brand={item.entryBrand}
          unit={item.entryUnit}
          price={item.entryPrice}
          store={sourceNames[item.entryStore] ?? item.entryStore}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-text-muted">
        <Chip variant="default">
          {t('review.confidence')} {Math.round(item.confidence * 100)}%
        </Chip>
        <Chip variant="loc">{t(methodKey(item.matchMethod))}</Chip>
        <Chip variant="default">{t(reasonKey(item.reason))}</Chip>
        <span>{t('review.flagCount', { count: item.flagCount })}</span>
        <span>·</span>
        <span>{formatClock(item.lastFlaggedAt, i18n.language)}</span>
        <Link to={runTo} className="text-accent hover:underline">
          {t('review.runDetail')}
        </Link>
      </div>
      <div className="mt-3 flex items-center gap-2">
        {decided ? (
          <>
            <span
              className={cn(
                'text-sm font-medium',
                item.status === 'approved' ? 'text-ok' : 'text-danger'
              )}
            >
              {item.status === 'approved' ? '✓' : '✗'}{' '}
              {t(item.status === 'approved' ? 'review.approved' : 'review.rejected')}
            </span>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onUndo(item.id)}>
              {t('review.undo')}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => onDecide(item.id, 'approved')}
            >
              {t('review.approve')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => onDecide(item.id, 'rejected')}
            >
              {t('review.reject')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

export function AdminReview() {
  const { t } = useTranslation()
  const { data: me } = useMe()
  const isAdmin = me?.user?.isAdmin === true
  const [status, setStatus] = useState('pending')
  const { data, isLoading, isError, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useReviewItems(status)
  const decide = useDecideReview()
  const undo = useUndoReview()
  const { data: sources } = usePriceSources()
  const sourceNames = useMemo(
    () => Object.fromEntries((sources ?? []).map((s) => [s.slug, s.name])),
    [sources]
  )
  const [exporting, setExporting] = useState(false)
  const busy = decide.isPending || undo.isPending

  if (!isAdmin) {
    return (
      <Panel>
        <EmptyState
          icon={IconWarning}
          title={t('monitor.forbidden')}
          desc={t('monitor.forbiddenDesc')}
        />
      </Panel>
    )
  }

  const items = data?.items ?? []
  const counts = data?.counts ?? { pending: 0, approved: 0, rejected: 0 }
  const filteredTotal = data?.filteredTotal ?? 0
  const total = counts.pending + counts.approved + counts.rejected

  async function handleExport() {
    setExporting(true)
    try {
      const blob = await fetchReviewExport()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'review_decisions.json'
      anchor.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-[62ch]">
          <p className="text-md text-text-muted leading-snug">{t('review.lead')}</p>
          <p className="text-xs text-text-muted mt-2">{t('review.decisionsNote')}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={handleExport} disabled={exporting}>
          <IconDownload size={16} /> {t('review.export')}
        </Button>
      </div>

      {/* Exact server-computed counts — unaffected by paging or the filter. */}
      <div className="mb-4 flex flex-wrap gap-2">
        <Chip variant="default">
          {t('review.pending')} {counts.pending}
        </Chip>
        <Chip variant="default">
          {t('review.approved')} {counts.approved}
        </Chip>
        <Chip variant="default">
          {t('review.rejected')} {counts.rejected}
        </Chip>
      </div>

      {/* Filter is list-only: switching never distorts the counts above. */}
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label={t('review.lead')}>
        {FILTERS.map((filter) => (
          <Chip
            key={filter}
            variant="filter"
            pressed={status === filter}
            aria-pressed={status === filter}
            onClick={() => setStatus(filter)}
          >
            {t(`review.${filter}`)}
          </Chip>
        ))}
      </div>

      {isLoading ? (
        <Panel>
          <SkeletonRows n={4} />
        </Panel>
      ) : isError ? (
        <Panel>
          <EmptyState icon={IconWarning} title={t('monitor.error')} desc={t('offline.banner')} />
        </Panel>
      ) : total === 0 ? (
        <Panel>
          <EmptyState icon={IconReview} title={t('review.empty')} desc={t('review.emptyDesc')} />
        </Panel>
      ) : items.length === 0 ? (
        <Panel>
          <div className="p-5 text-sm text-text-muted">
            {t('review.noneFiltered', { status: t(`review.${status}`) })}
          </div>
        </Panel>
      ) : (
        <Panel>
          <PanelHead className="!py-4">
            <div className="font-semibold flex items-center gap-3">
              <IconReview size={18} /> {t('nav.review')}
            </div>
          </PanelHead>
          <PanelBody className="!py-0 !px-0">
            <div className="flex flex-col">
              {items.map((item) => (
                <ReviewRow
                  key={item.id}
                  item={item}
                  sourceNames={sourceNames}
                  busy={busy}
                  onDecide={(id, decision) => decide.mutate({ id, decision })}
                  onUndo={(id) => undo.mutate({ id })}
                />
              ))}
            </div>
          </PanelBody>
          {hasNextPage && (
            <div className="p-5 flex items-center justify-between gap-4">
              <span className="text-xs text-text-muted">
                {t('review.showing', { shown: items.length, total: filteredTotal })}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {t('review.loadMore')}
              </Button>
            </div>
          )}
        </Panel>
      )}
    </>
  )
}
