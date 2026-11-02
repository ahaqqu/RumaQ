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

// observed_date is a bare YYYY-MM-DD; render it as a calendar date like the
// brochures view does (BrochuresView's observedDateLabel precedent).
function formatObservedDate(date, locale) {
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return date
  return parsed.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })
}

function reasonKey(reason) {
  return reason === 'price_ratio' ? 'review.reasonPriceRatio' : 'review.reasonVerifierUnresolved'
}

function methodKey(method) {
  const cap = method.charAt(0).toUpperCase() + method.slice(1)
  return `review.method${cap}`
}

// Issue #380: only the scraper's same-origin object URLs are page IMAGES.
// The stored brochure_url doubles as the listing page for catalog stores,
// so anything else (or null — old rows, no backfill) is the muted
// "catalog source" empty state, never a broken <img>.
function servableImage(url) {
  return typeof url === 'string' && url.startsWith('/api/brochures/') ? url : null
}

// Only http(s) ever renders as a retailer page link — the value comes from
// the scraper's store plugins, and the guard keeps a hostile `javascript:`
// string out of an href.
function externalPageUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null
}

// The evidence block's image slot: a lazy 3:4 thumbnail that opens the full
// page image in a new tab (same-origin proxy, cookie-authenticated), and a
// fallback in the same frame when the object is gone (404) — never a
// broken-image glyph (the BrochuresView precedent).
function EvidenceImage({ url }) {
  const { t } = useTranslation()
  // Thermos A1 (issue #380): remember WHICH url failed, not a boolean — the
  // same mounted instance can see its url change (decide/undo → refetch → a
  // newer observation swaps entryBrochureUrl), and a boolean would pin the
  // old failure over a url that was never tried.
  const [failedUrl, setFailedUrl] = useState(null)
  if (failedUrl === url) {
    return (
      <div className="flex h-20 w-16 items-center justify-center rounded-md border border-border bg-surface-sunken/40 p-1 text-center text-[10px] leading-tight text-text-muted">
        {t('review.evidenceNoImage')}
      </div>
    )
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" aria-label={t('review.evidenceImageAlt')}>
      <img
        src={url}
        alt={t('review.evidenceImageAlt')}
        loading="lazy"
        onError={() => setFailedUrl(url)}
        className="h-20 w-16 rounded-md border border-border object-cover"
      />
    </a>
  )
}

// PM asymmetry note (§2): B is NOT a parallel observation of the same
// instant — it is the canonical entry's most recent sighting. The honest
// column labels ("Matched item" / "Catalog entry (last seen)") carry that.
// Issue #380: each side also carries its evidence block — the page image
// behind the extraction, the retailer page it came from, and (right side)
// when the entry was last seen.
function SideCard({ label, name, brand, unit, price, store, imageUrl, sourceUrl, observedAt }) {
  const { t, i18n } = useTranslation()
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
      <div className="mt-2.5 flex items-start gap-2">
        {imageUrl ? (
          <EvidenceImage url={imageUrl} />
        ) : (
          <div className="flex h-20 w-16 items-center justify-center rounded-md border border-dashed border-border p-1 text-center text-[10px] leading-tight text-text-muted">
            {t('review.evidenceNoImage')}
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-1 text-xs">
          {sourceUrl && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              {t('review.evidenceOpenSource')}
            </a>
          )}
          {observedAt && (
            <span className="text-text-muted">
              {t('review.evidenceLastSeen', {
                date: formatObservedDate(observedAt, i18n.language),
              })}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function ReviewRow({ item, sourceNames, busy, onDecide, onUndo }) {
  const { t, i18n } = useTranslation()
  const decided = item.status !== 'pending'
  const runTo = item.runId ? `/admin/prices?run=${encodeURIComponent(item.runId)}` : '/admin/prices'
  // Issue #380: per-side evidence — the page image only renders for the
  // scraper's same-origin object URLs; the retailer page link only for
  // http(s).
  const itemImageUrl = servableImage(item.itemBrochureUrl)
  const itemPageUrl = externalPageUrl(item.itemSourceUrl)
  const entryImageUrl = servableImage(item.entryBrochureUrl)
  const entryPageUrl = externalPageUrl(item.entrySourceUrl)
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
          imageUrl={itemImageUrl}
          sourceUrl={itemPageUrl}
        />
        <div className="self-stretch w-px bg-border" aria-hidden="true" />
        <SideCard
          label={t('review.catalogEntry')}
          name={item.entryName}
          brand={item.entryBrand}
          unit={item.entryUnit}
          price={item.entryPrice}
          store={sourceNames[item.entryStore] ?? item.entryStore}
          imageUrl={entryImageUrl}
          sourceUrl={entryPageUrl}
          observedAt={item.entryObservedAt ?? null}
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
  const [exportFailed, setExportFailed] = useState(false)
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
    setExportFailed(false)
    try {
      const blob = await fetchReviewExport()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'review_decisions.json'
      anchor.click()
      URL.revokeObjectURL(url)
    } catch {
      // No toast system in the app — an inline line next to the button is
      // the codebase's surface for one-shot action failures. Without it a
      // failed export (expired session, 5xx) would be completely silent.
      setExportFailed(true)
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
        <div className="flex flex-col items-end gap-1.5">
          <Button variant="secondary" size="sm" onClick={handleExport} disabled={exporting}>
            <IconDownload size={16} /> {t('review.export')}
          </Button>
          {exportFailed && (
            <p className="text-xs text-danger" role="alert">
              {t('review.exportFailed')}
            </p>
          )}
        </div>
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
