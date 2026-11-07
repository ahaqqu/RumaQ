import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import { useMe } from '../lib/queries/me.js'
import { usePriceSources } from '../lib/queries/index.js'
import {
  useReviewItems,
  useDecideReview,
  useUndoReview,
  useReviewMode,
  useSetReviewMode,
  useEvaluateReview,
} from '../lib/queries/review.js'
import { fetchReviewExport } from '../lib/api'
import { EmptyState, SkeletonRows } from '../components/ui.jsx'
import { Panel, PanelHead, PanelBody } from '../components/Panel.jsx'
import { Chip } from '../components/Chip.jsx'
import { Button } from '../components/Button.jsx'
import { ProductRenameForm } from '../components/ProductRenameForm.jsx'
import { formatPrice } from '../lib/pricesHelpers.js'
import { cn } from '../lib/cn.js'
import { IconWarning, IconReview, IconDownload, IconBolt } from '../components/icons.jsx'

// Match review queue (issue #294): a triage work queue for pairs the matcher
// flagged — see the actual candidates side by side, record a verdict, keep
// the record. v1 decisions change nothing downstream; the muted note on the
// page says so (docs/294-design-pm.md §4).
//
// Issue #484 (frontend, PR 2 of 2) adds the AI layer on top: the global
// manual/assist/auto mode switch, the cached verdict chips, assist-mode
// agree/disagree, and provenance on decided rows. Manual mode is a hard
// zero-call gate — the page renders no verdict/evaluate UI there, and the
// backend refuses evaluation in that mode too.

const FILTERS = ['pending', 'approved', 'rejected', 'all']

// The three modes, in the owner's order (issue #484). `assist` is the
// backend default; the UI mirrors it while the mode query is in flight.
const REVIEW_MODES = ['manual', 'assist', 'auto']
const MODE_COPY_SUFFIX = { manual: 'Manual', assist: 'Assist', auto: 'Auto' }
const DEFAULT_MODE = 'assist'

// Bounded evaluation sizes (backend caps: REVIEW_EVALUATE_MAX = 10). The
// first-load probe is small so an open review page never bills ten calls
// before the admin has asked for anything.
const EVALUATE_ON_LOAD_LIMIT = 5
const EVALUATE_MORE_LIMIT = 10

// Mirrors lib/review-ai.ts's REVIEW_TAXONOMY_REASON. A taxonomy flag is a
// SELF-pair (the classifier's question, not a product-identity one) and the
// reviewer skips it intentionally: it never gets a verdict, so counting it
// as "waiting for AI" (or letting it trigger an evaluation) would be a lie.
const TAXONOMY_REASON = 'taxonomy'

function isWaitingForAi(item) {
  return item.status === 'pending' && !item.aiVerdict && item.reason !== TAXONOMY_REASON
}

// The assist contract (issue #484): Agree records the verdict's OWN decision;
// Disagree records the opposite. The agreement flag is what the backend
// stores as human_agreement and turns into decided_source='ai_assist'.
function assistedDecision(verdict, agreement) {
  const same = verdict.verdict === 'same'
  const asVerdict = agreement === 'agreed' ? same : !same
  return asVerdict ? 'approved' : 'rejected'
}

const PROVENANCE_KEYS = {
  human: 'review.aiProvenanceHuman',
  ai_assist: 'review.aiProvenanceAssist',
  ai_auto: 'review.aiProvenanceAuto',
}

// The two column labels (#480) share one treatment; their ids are the
// aria-labelledby targets every row's sides point at.
const SIDE_LABEL_CLASS = 'text-xs font-semibold text-text-muted uppercase tracking-wide'

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

// Click-to-copy for the row's reference id (#480). Best-effort and silent:
// the clipboard API may be unavailable (permissions, insecure context), and
// copying is a convenience — the full UUID stays visible in the button title.
async function copyItemId(id) {
  try {
    await navigator.clipboard.writeText(id)
  } catch {
    // Silent by design.
  }
}

// PM asymmetry note (§2): B is NOT a parallel observation of the same
// instant — it is the canonical entry's most recent sighting. The honest
// column labels ("Matched item" / "Catalog entry (last seen)") moved into
// ONE list header (#480); each side is named by that header via
// aria-labelledby instead of repeating the label per card.
//
// Thermos B1 (#480): the header labels only line up with the rows if both
// sides use the same column proportions, so the two-column shell lives here
// once instead of being repeated at every call site.
function SideColumns({ className, left, right }) {
  return (
    <div className={cn('flex items-stretch gap-4', className)}>
      <div className="min-w-0 flex-1">{left}</div>
      <div className="self-stretch w-px bg-border" aria-hidden="true" />
      <div className="min-w-0 flex-1">{right}</div>
    </div>
  )
}

// Issue #380: each side also carries its evidence block — the page image
// behind the extraction, the retailer page it came from, and (right side)
// when the entry was last seen.
function SideCard({
  labelledBy,
  name,
  brand,
  unit,
  price,
  store,
  imageUrl,
  sourceUrl,
  observedAt,
  action,
}) {
  const { t, i18n } = useTranslation()
  return (
    <div role="group" aria-labelledby={labelledBy}>
      <div className="text-sm font-medium leading-snug">{name}</div>
      {/* #480: no more "— · —". Both missing reads as one muted sentence;
          one value renders alone; both keep the brand · unit pair. */}
      <div className="text-xs text-text-muted mt-1">
        {brand && unit ? `${brand} · ${unit}` : brand || unit || t('review.noBrandUnit')}
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
      {action}
    </div>
  )
}

// The 3-way mode switch (issue #484). Native radios in labels: keyboard
// reachable, arrow-key group navigation for free, and the selected mode is
// announced. `saving` is the mutation in flight — the fieldset disables the
// whole group so a double-click can never race two PUTs.
function ReviewModeSelector({ mode, saving, onChange }) {
  const { t } = useTranslation()
  return (
    <fieldset disabled={saving} className="min-w-0">
      <legend className="text-xs font-semibold text-text-muted uppercase tracking-wide">
        {t('review.aiModeLegend')}
      </legend>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {REVIEW_MODES.map((option) => {
          const suffix = MODE_COPY_SUFFIX[option]
          const selected = option === mode
          return (
            <label
              key={option}
              className={cn(
                'flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 transition-colors',
                selected
                  ? 'border-accent-soft-border bg-accent-soft'
                  : 'border-border bg-surface-raised hover:bg-surface-sunken',
                saving && 'cursor-not-allowed opacity-60'
              )}
            >
              <input
                type="radio"
                name="review-ai-mode"
                value={option}
                checked={selected}
                disabled={saving}
                onChange={() => onChange(option)}
                className="mt-1 h-4 w-4 shrink-0 accent-accent"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium leading-snug">
                  {t(`review.aiMode${suffix}`)}
                </span>
                <span className="block text-xs text-text-muted leading-snug mt-0.5">
                  {t(`review.aiMode${suffix}Desc`)}
                </span>
              </span>
            </label>
          )
        })}
      </div>
      {saving && (
        <p className="mt-2 text-xs text-text-muted" role="status">
          {t('review.aiModeSaving')}
        </p>
      )}
    </fieldset>
  )
}

// The cached AI verdict for one pending row (issue #484). The chip carries
// verdict + confidence; the model and the reason are one interaction away
// (the reason is display text, not evidence — it stays collapsed by
// default). In assist mode the human accepts or rejects the AI's call here;
// auto mode has already applied it, so it gets no action buttons.
function AiVerdictBlock({ verdict, mode, busy, saving, onAgree, onDisagree }) {
  const { t } = useTranslation()
  const [reasonOpen, setReasonOpen] = useState(false)
  const confidence = Math.round((verdict.confidence ?? 0) * 100)
  const label = t(verdict.verdict === 'same' ? 'review.aiSame' : 'review.aiDifferent')
  const help = [
    label,
    verdict.reason,
    verdict.model ? t('review.aiModel', { model: verdict.model }) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-sunken/40 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Chip variant="accent" title={help || undefined}>
          {t('review.aiVerdict', { verdict: label, confidence })}
        </Chip>
        {verdict.model && (
          <span className="text-xs text-text-muted">
            {t('review.aiModel', { model: verdict.model })}
          </span>
        )}
        {verdict.reason && (
          <button
            type="button"
            className="text-xs text-accent hover:underline"
            aria-expanded={reasonOpen}
            onClick={() => setReasonOpen((open) => !open)}
          >
            {t(reasonOpen ? 'review.aiReasonHide' : 'review.aiReasonShow')}
          </button>
        )}
      </div>
      {reasonOpen && verdict.reason && (
        <p className="mt-1.5 text-xs text-text-muted leading-snug">{verdict.reason}</p>
      )}
      {mode === 'assist' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            title={t('review.aiAgreeHint')}
            onClick={onAgree}
          >
            {t('review.aiAgree')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            title={t('review.aiDisagreeHint')}
            onClick={onDisagree}
          >
            {t('review.aiDisagree')}
          </Button>
          {saving && (
            <span role="status" className="text-xs text-text-muted">
              {t('review.aiRecording')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function ReviewRow({
  item,
  sourceNames,
  itemSideLabelId,
  entrySideLabelId,
  mode,
  aiEnabled,
  isAdmin,
  busy,
  saving,
  onDecide,
  onUndo,
}) {
  const { t, i18n } = useTranslation()
  // #423: the rename form expands under the row that opened it, so each row
  // owns its own open state.
  const [renameOpen, setRenameOpen] = useState(false)
  const decided = item.status !== 'pending'
  const runTo = item.runId ? `/admin/prices?run=${encodeURIComponent(item.runId)}` : '/admin/prices'
  // Issue #380: per-side evidence — the page image only renders for the
  // scraper's same-origin object URLs; the retailer page link only for
  // http(s).
  const itemImageUrl = servableImage(item.itemBrochureUrl)
  const itemPageUrl = externalPageUrl(item.itemSourceUrl)
  const entryImageUrl = servableImage(item.entryBrochureUrl)
  const entryPageUrl = externalPageUrl(item.entrySourceUrl)
  const shortId = `#${item.id.slice(0, 8)}`
  return (
    <div className="border-b border-border last:border-b-0 px-5 py-4">
      <SideColumns
        left={
          <SideCard
            labelledBy={itemSideLabelId}
            name={item.itemName}
            brand={item.itemBrand}
            unit={item.itemUnit}
            price={item.itemPrice}
            store={sourceNames[item.itemStore] ?? item.itemStore}
            imageUrl={itemImageUrl}
            sourceUrl={itemPageUrl}
          />
        }
        right={
          <SideCard
            labelledBy={entrySideLabelId}
            name={item.entryName}
            brand={item.entryBrand}
            unit={item.entryUnit}
            price={item.entryPrice}
            store={sourceNames[item.entryStore] ?? item.entryStore}
            imageUrl={entryImageUrl}
            sourceUrl={entryPageUrl}
            observedAt={item.entryObservedAt ?? null}
            action={
              // #423: the canonical entry side owns the rename action — the
              // pair's frozen labels are what the admin is looking at. The
              // page's admin gate above already returned for everyone else.
              item.entryProductKey ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  aria-expanded={renameOpen}
                  onClick={() => setRenameOpen((open) => !open)}
                >
                  {renameOpen ? t('rename.close') : t('rename.action')}
                </Button>
              ) : null
            }
          />
        }
      />
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-text-muted">
        {/* #480: the short reference id, full UUID in the title, click to
            copy it for a conversation ("that #31b35444 one"). The label
            carries the short id too (WCAG 2.5.3 label-in-name). */}
        <button
          type="button"
          onClick={() => copyItemId(item.id)}
          title={item.id}
          aria-label={t('review.copyItemId', { id: shortId })}
          className="font-mono text-text-muted hover:text-text hover:underline"
        >
          {shortId}
        </button>
        <Chip variant="default" title={t('review.confidenceHint')}>
          {t('review.confidence')} {Math.round(item.confidence * 100)}%
        </Chip>
        <Chip variant="loc">{t(methodKey(item.matchMethod))}</Chip>
        <Chip variant="default">
          {t('review.flagPrefix')} {t(reasonKey(item.reason))}
        </Chip>
        <span>{t('review.flagCount', { count: item.flagCount })}</span>
        <span>·</span>
        <span>{formatClock(item.lastFlaggedAt, i18n.language)}</span>
        <Link to={runTo} className="text-accent hover:underline">
          {t('review.runDetail')}
        </Link>
      </div>
      {/* Issue #484: the cached verdict is shown for PENDING rows only — a
          decided row's provenance chip below says who decided it. Manual mode
          (aiEnabled=false) renders no verdict UI at all. */}
      {!decided && aiEnabled && item.aiVerdict && (
        <AiVerdictBlock
          verdict={item.aiVerdict}
          mode={mode}
          busy={busy}
          saving={saving}
          onAgree={() => onDecide(item.id, assistedDecision(item.aiVerdict, 'agreed'), 'agreed')}
          onDisagree={() =>
            onDecide(item.id, assistedDecision(item.aiVerdict, 'disagreed'), 'disagreed')
          }
        />
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
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
            {/* Issue #484 provenance: who produced this decision. The chip is
                the record, shown in every mode — hiding a past AI decision
                because the mode changed now would misrepresent the row. */}
            {PROVENANCE_KEYS[item.decidedSource] && (
              <Chip variant="loc">{t(PROVENANCE_KEYS[item.decidedSource])}</Chip>
            )}
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
      {renameOpen && item.entryProductKey && (
        <div className="mt-3">
          {/* The pair keeps the frozen catalog label it was flagged with; only
              the canonical product name moves (the rename is identity-neutral,
              the audit trail is the record of it). */}
          <p className="text-xs text-text-muted mb-2">{t('rename.frozenPairNote')}</p>
          <ProductRenameForm
            productKey={item.entryProductKey}
            isAdmin={isAdmin}
            onClose={() => setRenameOpen(false)}
          />
        </div>
      )}
    </div>
  )
}

export function AdminReview() {
  const { t } = useTranslation()
  // #480: one list header names both sides; every row's SideCard points at
  // these label ids (unique even if the page ever mounts twice).
  const itemSideLabelId = useId()
  const entrySideLabelId = useId()
  const { data: me } = useMe()
  const isAdmin = me?.user?.isAdmin === true
  const [status, setStatus] = useState('pending')
  const { data, isLoading, isError, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useReviewItems(status)
  const decide = useDecideReview()
  const undo = useUndoReview()
  // Issue #484: the mode query is admin-gated up front (enabled:false keeps a
  // non-admin from ever issuing the request; the page itself returns the
  // forbidden state below).
  const modeQuery = useReviewMode({ enabled: isAdmin })
  const setMode = useSetReviewMode()
  const evaluate = useEvaluateReview()
  const { data: sources } = usePriceSources()
  const sourceNames = useMemo(
    () => Object.fromEntries((sources ?? []).map((s) => [s.slug, s.name])),
    [sources]
  )
  const [exporting, setExporting] = useState(false)
  const [exportFailed, setExportFailed] = useState(false)
  const busy = decide.isPending || undo.isPending
  const savingItemId = decide.isPending ? decide.variables?.id : null
  const items = data?.items ?? []
  // `assist` mirrors the backend default while the mode query is in flight;
  // AI UI waits for real data (aiConfigured is a server answer, never assumed).
  const mode = modeQuery.data?.mode ?? DEFAULT_MODE
  const aiConfigured = modeQuery.data?.aiConfigured === true
  const aiEnabled = mode !== 'manual' && aiConfigured
  const waitingForAi = useMemo(() => items.filter(isWaitingForAi), [items])

  // First-load probe (issue #484): when AI is on and the queue has items the
  // reviewer has not seen, run ONE bounded evaluation (limit 5) in the
  // background and let the mutation's invalidation refetch the verdicts.
  // Non-blocking; a ref makes it once-per-mount even though the mutation
  // result object changes identity across renders. Manual mode returns
  // before the ref is set, so switching manual → assist later still probes.
  const autoEvaluateStarted = useRef(false)
  const evaluateMutate = evaluate.mutate
  useEffect(() => {
    if (autoEvaluateStarted.current) return
    if (!isAdmin || !modeQuery.data || !aiEnabled) return
    if (waitingForAi.length === 0) return
    autoEvaluateStarted.current = true
    evaluateMutate(EVALUATE_ON_LOAD_LIMIT)
  }, [isAdmin, modeQuery.data, aiEnabled, waitingForAi, evaluateMutate])

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

  const counts = data?.counts ?? { pending: 0, approved: 0, rejected: 0 }
  const filteredTotal = data?.filteredTotal ?? 0
  const total = counts.pending + counts.approved + counts.rejected

  function handleModeChange(next) {
    if (next === mode || setMode.isPending) return
    setMode.mutate(next)
  }

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
          {/* #480: a 100% match can still be here — say review is flag-driven.
              The record-only note below stays as the "nothing changes" caveat. */}
          <p className="text-xs text-text-muted leading-snug mt-2">{t('review.whyReview')}</p>
          <p className="text-xs text-text leading-snug mt-2">{t('review.decisionRubric')}</p>
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

      {/* Issue #484: the AI mode block sits in the review header, above the
          counts. The selector is always usable (a misconfigured provider is a
          warning, never a lock); the evaluate controls exist only when AI can
          actually run, and never in manual mode. */}
      {modeQuery.data ? (
        <Panel className="mb-4">
          <PanelBody className="flex flex-col gap-3">
            <ReviewModeSelector
              mode={mode}
              saving={setMode.isPending}
              onChange={handleModeChange}
            />
            {!aiConfigured && (
              <p className="text-xs text-text-muted" role="status">
                {t('review.aiNotConfigured')}
              </p>
            )}
            {setMode.isError && (
              <p className="text-xs text-danger" role="alert">
                {t('review.aiModeFailed')}
              </p>
            )}
            {aiEnabled && (
              <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={evaluate.isPending}
                  onClick={() => evaluate.mutate(EVALUATE_MORE_LIMIT)}
                >
                  <IconBolt size={16} className={cn(evaluate.isPending && 'animate-spin')} />
                  {t('review.aiEvaluateMore')}
                </Button>
                {evaluate.isPending ? (
                  <span role="status">{t('review.aiEvaluating')}</span>
                ) : waitingForAi.length > 0 ? (
                  <span>{t('review.aiWaiting', { count: waitingForAi.length })}</span>
                ) : null}
                {mode === 'auto' && <span>{t('review.aiAutoCronNote')}</span>}
                {evaluate.isError && (
                  <span className="text-danger" role="alert">
                    {t('review.aiEvaluateFailed')}
                  </span>
                )}
              </div>
            )}
          </PanelBody>
        </Panel>
      ) : modeQuery.isError ? (
        // Thermos B1: the mode read is the only request on this page whose
        // failure used to be invisible — gating the whole block on
        // `modeQuery.data` made a 500 look like a build without any AI
        // surface, so the admin could neither see the switch nor retry it.
        // Same inline surface the rename form uses for its load failure
        // (#423): an alert plus a retry, never a bare absence.
        <Panel className="mb-4">
          <PanelBody>
            <p role="alert" className="text-xs text-danger">
              {t('review.aiModeUnavailable')}
            </p>
            <div className="mt-2">
              <Button variant="ghost" size="sm" onClick={() => modeQuery.refetch()}>
                {t('review.aiModeRetry')}
              </Button>
            </div>
          </PanelBody>
        </Panel>
      ) : null}

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
              {/* #480: the two side labels live here once, in the same
                  two-column proportions as each row (SideColumns). */}
              <SideColumns
                className="border-b border-border px-5 py-3"
                left={
                  <span id={itemSideLabelId} className={SIDE_LABEL_CLASS}>
                    {t('review.matchedItem')}
                  </span>
                }
                right={
                  <span id={entrySideLabelId} className={SIDE_LABEL_CLASS}>
                    {t('review.catalogEntry')}
                  </span>
                }
              />
              {items.map((item) => (
                <ReviewRow
                  key={item.id}
                  item={item}
                  sourceNames={sourceNames}
                  itemSideLabelId={itemSideLabelId}
                  entrySideLabelId={entrySideLabelId}
                  mode={mode}
                  aiEnabled={aiEnabled}
                  isAdmin={isAdmin}
                  busy={busy}
                  saving={savingItemId === item.id}
                  onDecide={(id, decision, agreement) =>
                    decide.mutate(agreement ? { id, decision, agreement } : { id, decision })
                  }
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
