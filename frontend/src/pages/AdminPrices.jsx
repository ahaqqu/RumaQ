import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearch } from '@tanstack/react-router'
import { useMe } from '../lib/queries/me.js'
import { usePriceRuns } from '../lib/queries/index.js'
import { EmptyState, SkeletonRows } from '../components/ui.jsx'
import { Panel, PanelHead, PanelBody } from '../components/Panel.jsx'
import { Chip } from '../components/Chip.jsx'
import { cn } from '../lib/cn.js'
import { IconClock, IconWarning, IconCheck, IconBolt } from '../components/icons.jsx'

// The staleness threshold mirrors the smoke alert (§7.1): a nightly run that
// has not succeeded for >26h means the pipeline is not landing.
const STALE_HOURS = 26

function formatClock(iso, locale) {
  return new Date(iso).toLocaleString(locale, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function durationSeconds(startedAt, finishedAt) {
  const seconds = Math.max(0, Math.round((new Date(finishedAt) - new Date(startedAt)) / 1000))
  if (seconds < 90) return `${seconds}s`
  return `${Math.round(seconds / 60)}m`
}

function stageKey(stage) {
  if (!stage) return null
  return `monitor.stage${stage.charAt(0).toUpperCase()}${stage.slice(1)}`
}

function ageHours(iso) {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000
}

// Issue #357: the degradation chain line reads as a story, not a model
// catalog — the gemini- prefix is dead weight at this width.
function shortModel(model) {
  return model.replace(/^gemini-/, '')
}

function LastSuccessCard({ lastSuccessAt }) {
  const { t, i18n } = useTranslation()
  if (!lastSuccessAt) {
    return (
      <Panel className="p-5 flex gap-4 items-center mb-4">
        <div className="text-warn">
          <IconWarning size={22} />
        </div>
        <div className="flex-1 text-sm">
          <strong>{t('monitor.neverSucceeded')}</strong>
        </div>
      </Panel>
    )
  }
  const hours = ageHours(lastSuccessAt)
  const stale = hours > STALE_HOURS
  return (
    <Panel className="p-5 flex gap-4 items-center mb-4">
      <div className={stale ? 'text-danger' : 'text-ok'}>
        {stale ? <IconWarning size={22} /> : <IconCheck size={22} />}
      </div>
      <div className="flex-1 text-sm">
        <strong>{t('monitor.lastSuccess')}</strong> {formatClock(lastSuccessAt, i18n.language)}
        {stale && <div className="text-danger text-xs mt-0.5">{t('monitor.stale')}</div>}
      </div>
    </Panel>
  )
}

function RunDetail({ run }) {
  const { t } = useTranslation()
  const storeEntries = Object.entries(run.perStore ?? {})
  return (
    <div className="px-5 py-4 border-t border-border bg-surface-sunken/40 text-sm">
      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
            {t('monitor.storesDetail')}
          </div>
          {storeEntries.length === 0 ? (
            <div className="text-text-muted text-xs">—</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {storeEntries.map(([slug, stats]) => (
                <div key={slug} className="text-xs">
                  <span className="font-medium">{slug}</span>
                  {stats.needsProxy ? (
                    <span className="text-warn"> — {t('monitor.needsProxy')}</span>
                  ) : stats.error ? (
                    <span className="text-danger">
                      {' '}
                      — {t('monitor.storeError')}: {stats.error}
                    </span>
                  ) : (
                    <>
                      <span className="text-text-muted">
                        {' '}
                        — {t('monitor.pages', { count: stats.pagesFound })},{' '}
                        {t('monitor.newImages', { count: stats.newImages })},{' '}
                        {t('monitor.items', { count: stats.itemsExtracted })}
                        {stats.itemsRejected > 0 &&
                          `, ${t('monitor.rejected', { count: stats.itemsRejected })}`}
                      </span>
                      {/* Issue #357: a store that rode more than one OCR
                      rung rode a degraded chain — the compact chain (final
                      rung last) sits next to the counts so "N rejected ·
                      OCR degraded: …" reads as one story. Raw data outside
                      t(), like the store error above. */}
                      {stats.modelsUsed?.length > 1 && (
                        <span className="text-warn">
                          {' '}
                          · {t('monitor.ocrDegraded')}:{' '}
                          {stats.modelsUsed.map(shortModel).join(' → ')}
                        </span>
                      )}
                    </>
                  )}
                  {/* Issue #362: the first rejects ride the report with
                  their reasons — compact warn-toned lines under the counts
                  (source as the tooltip), the "+N more" marker keeping the
                  cap honest (itemsRejected stays the true count). Raw scraper
                  strings, like the warnings below. */}
                  {stats.rejectedItems?.length > 0 && (
                    <div className="text-warn mt-0.5 break-words">
                      <div>{t('monitor.rejectReasons')}</div>
                      {stats.rejectedItems.map((item, i) => (
                        <div key={i} title={item.source}>
                          {item.name ? `${item.name} — ${item.reason}` : item.reason}
                        </div>
                      ))}
                      {stats.itemsRejected > stats.rejectedItems.length && (
                        <div>
                          {t('monitor.moreRejected', {
                            count: stats.itemsRejected - stats.rejectedItems.length,
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  {/* Issue #322 (A4), #357: the scraper-side warnings
                  (plugin anomalies, OCR-chain degradation) never had a
                  display channel — each rides its own line here. Raw scraper
                  strings, like the run error below. */}
                  {stats.warnings?.map((warning, i) => (
                    <div key={i} className="text-warn mt-0.5 break-words">
                      {warning}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
            {t('monitor.matchDetail')}
          </div>
          {run.match ? (
            <div className="text-xs text-text-muted flex flex-col gap-1">
              <span>
                {t('monitor.matchExact', { count: run.match.exact })},{' '}
                {t('monitor.matchEmbedding', { count: run.match.embedding })},{' '}
                {t('monitor.matchAi', { count: run.match.ai })},{' '}
                {t('monitor.matchSolo', { count: run.match.solo })}
              </span>
              <span>
                {/* Issue #294: the flagged count links to the review queue —
                the monitor answers "did a run report flags?", the review page
                is where they get resolved. Plain text at zero. */}
                {run.match.reviewItems > 0 ? (
                  <Link to="/admin/review" className="text-accent hover:underline">
                    {t('monitor.matchReview', { count: run.match.reviewItems })}
                  </Link>
                ) : (
                  t('monitor.matchReview', { count: run.match.reviewItems })
                )}
                {run.match.embeddingsDegraded && ` · ${t('monitor.matchDegraded')}`}
              </span>
            </div>
          ) : (
            <div className="text-text-muted text-xs">—</div>
          )}
        </div>
        <div>
          <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
            {t('monitor.publishDetail')}
          </div>
          {run.publish ? (
            <div className="text-xs text-text-muted flex flex-col gap-1">
              <span>
                {run.publish.mode === 'dry-run'
                  ? t('monitor.dryRun')
                  : t('monitor.publishedAccepted', { count: run.publish.accepted ?? 0 })}
              </span>
              {run.publish.error && <span className="text-danger">{run.publish.error}</span>}
            </div>
          ) : (
            <div className="text-text-muted text-xs">—</div>
          )}
        </div>
      </div>
      {run.error && <div className="mt-3 text-xs text-danger break-words">{run.error}</div>}
    </div>
  )
}

function RunRow({ run, initiallyExpanded = false }) {
  const { t, i18n } = useTranslation()
  // ?run=<id> deep link (issue #294): the review queue's "View run" jumps
  // here with the run pre-expanded. A run absent from the 50-run feed simply
  // renders unexpanded.
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const failed = run.status !== 'success'
  // A green run can still carry a by-design needs-proxy skip — surface it on
  // the row so the gap is visible without expanding.
  const needsProxy = Object.values(run.perStore ?? {}).some((stats) => stats.needsProxy)
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-surface-sunken/60 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span
          className={cn('w-2 h-2 rounded-full shrink-0', failed ? 'bg-danger' : 'bg-ok')}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {formatClock(run.runStartedAt, i18n.language)}{' '}
            <span className="text-text-muted font-normal">
              · {durationSeconds(run.runStartedAt, run.finishedAt)}
              {stageKey(run.stage) && ` · ${t(stageKey(run.stage))}`}
            </span>
          </div>
          {run.error && (
            <div className="text-xs text-danger truncate max-w-[60ch]">{run.error}</div>
          )}
        </div>
        {needsProxy && !failed && (
          <Chip variant="default" className="text-warn">
            {t('monitor.needsProxyChip')}
          </Chip>
        )}
        <Chip variant={failed ? 'accent' : 'default'}>
          {failed ? t('monitor.failed') : t('monitor.success')}
        </Chip>
      </button>
      {expanded && <RunDetail run={run} />}
    </div>
  )
}

export function AdminPrices() {
  const { t } = useTranslation()
  const { data: me } = useMe()
  const isAdmin = me?.user?.isAdmin === true
  const { data, isLoading, isError } = usePriceRuns()
  // ?run=<id> from the review queue's "View run" link.
  const { run: runParam } = useSearch({ strict: false }) ?? {}

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

  return (
    <>
      <div className="mb-6">
        <p className="text-md text-text-muted leading-snug max-w-[62ch]">{t('monitor.lead')}</p>
      </div>

      {isLoading ? (
        <Panel>
          <SkeletonRows n={5} />
        </Panel>
      ) : isError ? (
        <Panel>
          <EmptyState icon={IconWarning} title={t('monitor.error')} desc={t('offline.banner')} />
        </Panel>
      ) : (data?.runs ?? []).length === 0 ? (
        <Panel>
          <EmptyState icon={IconBolt} title={t('monitor.noRuns')} desc={t('monitor.noRunsDesc')} />
        </Panel>
      ) : (
        <>
          <LastSuccessCard lastSuccessAt={data.lastSuccessAt} />
          <Panel>
            <PanelHead className="!py-4">
              <div className="font-semibold flex items-center gap-3">
                <IconClock size={18} /> {t('monitor.runHistory')}
              </div>
            </PanelHead>
            <PanelBody className="!py-0 !px-0">
              <div className="flex flex-col">
                {data.runs.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    initiallyExpanded={Boolean(runParam) && run.id === runParam}
                  />
                ))}
              </div>
            </PanelBody>
          </Panel>
        </>
      )}
    </>
  )
}
