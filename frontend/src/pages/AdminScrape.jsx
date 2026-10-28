import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMe } from '../lib/queries/me.js'
import {
  useScrapeStores,
  useScrapeCommands,
  useScrapeEvents,
  useTriggerScrape,
  ACTIVE_STATUSES,
} from '../lib/queries/index.js'
import { EmptyState, SkeletonRows } from '../components/ui.jsx'
import { Panel, PanelHead, PanelBody } from '../components/Panel.jsx'
import { Chip } from '../components/Chip.jsx'
import { Button } from '../components/Button.jsx'
import { cn } from '../lib/cn.js'
import { IconBolt, IconClock, IconWarning } from '../components/icons.jsx'

const STATUS_DOT = {
  pending: 'bg-warn',
  running: 'bg-accent',
  success: 'bg-ok',
  failed: 'bg-danger',
}

function statusKey(status) {
  return `scrape.status${status.charAt(0).toUpperCase()}${status.slice(1)}`
}

function formatClock(iso, locale) {
  return new Date(iso).toLocaleString(locale, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatLogTime(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function durationLabel(seconds) {
  if (seconds < 90) return `${seconds}s`
  return `${Math.round(seconds / 60)}m`
}

// Raw log stream for one command — the live output while the run is active,
// the failure log once it is not. Fed by incremental afterSeq polling.
function EventLog({ command }) {
  const { t } = useTranslation()
  const { data, isLoading } = useScrapeEvents(command)
  const logRef = useRef(null)
  const eventCount = data?.events?.length ?? 0

  // Stick to the tail: the newest lines are the interesting ones.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [eventCount])

  return (
    <div className="px-5 py-4 border-t border-border bg-surface-sunken/40">
      {isLoading ? (
        <SkeletonRows n={2} />
      ) : eventCount === 0 ? (
        <div className="text-xs text-text-muted">{t('scrape.noEvents')}</div>
      ) : (
        <pre
          ref={logRef}
          data-testid="scrape-log"
          className="font-mono text-xs leading-relaxed max-h-72 overflow-y-auto whitespace-pre-wrap break-words bg-surface-inset rounded-md p-3 m-0"
        >
          {(data?.events ?? []).map((event) => (
            <div key={event.seq} className={cn(event.level === 'error' && 'text-danger')}>
              <span className="text-text-faint select-none">{formatLogTime(event.ts)} </span>
              {event.message}
            </div>
          ))}
        </pre>
      )}
      {data?.truncated && <div className="text-xs text-warn mt-2">{t('scrape.logTruncated')}</div>}
    </div>
  )
}

function TriggerPanel({ activeCommand }) {
  const { t } = useTranslation()
  const { data, isLoading } = useScrapeStores()
  const trigger = useTriggerScrape()
  const [selected, setSelected] = useState([])
  const stores = data?.stores ?? []
  const blocked = trigger.isPending || Boolean(activeCommand)
  // The inline reason must not fire while the first POST is merely in flight —
  // only a live command or the server's own 409 means "one run at a time".
  const alreadyRunning = Boolean(activeCommand) || trigger.error?.status === 409

  const toggleStore = (slug, checked) => {
    setSelected((prev) => (checked ? [...prev, slug] : prev.filter((entry) => entry !== slug)))
  }

  return (
    <Panel className="mb-4">
      <PanelHead className="!py-4">
        <div className="font-semibold flex items-center gap-3">
          <IconBolt size={18} /> {t('scrape.triggerTitle')}
        </div>
      </PanelHead>
      <PanelBody className="text-sm">
        {isLoading ? (
          <SkeletonRows n={2} />
        ) : stores.length === 0 ? (
          <div className="text-text-muted text-xs">—</div>
        ) : (
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {stores.map((slug) => (
              <label key={slug} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="w-5 h-5 accent-accent"
                  checked={selected.includes(slug)}
                  disabled={blocked}
                  onChange={(e) => toggleStore(slug, e.target.checked)}
                />
                {slug}
              </label>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 mt-4">
          <Button
            onClick={() => trigger.mutate(selected, { onSuccess: () => setSelected([]) })}
            disabled={blocked || selected.length === 0}
          >
            <IconBolt size={16} />
            {trigger.isPending ? t('scrape.queueing') : t('scrape.scrapeNow')}
          </Button>
          {alreadyRunning && (
            <span className="text-xs text-warn">{t('scrape.alreadyRunning')}</span>
          )}
          {trigger.error && trigger.error?.status !== 409 && (
            <span className="text-xs text-danger">{t('scrape.queueError')}</span>
          )}
        </div>
      </PanelBody>
    </Panel>
  )
}

function ActiveRunCard({ command }) {
  const { t } = useTranslation()
  const active = ACTIVE_STATUSES.has(command.status)
  const [now, setNow] = useState(() => Date.now())

  // Ticking elapsed clock — only while the run is actually in flight.
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])

  const startedAt = command.pickedUpAt ?? command.createdAt
  const elapsed = Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000))

  return (
    <Panel className="mb-4">
      <PanelHead className="!py-4">
        <div className="font-semibold flex items-center gap-3">
          <span
            className={cn('w-2 h-2 rounded-full shrink-0', STATUS_DOT[command.status])}
            aria-hidden="true"
          />
          {t('scrape.activeRun')}
        </div>
        <Chip variant={command.status === 'running' ? 'accent' : 'default'}>
          {t(statusKey(command.status))}
        </Chip>
      </PanelHead>
      <PanelBody className="text-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium">{(command.stores ?? []).join(', ')}</span>
          <span className="text-text-muted">
            · {t('scrape.elapsed')}: {durationLabel(elapsed)}
          </span>
        </div>
        {command.status === 'pending' && (
          <div className="text-xs text-text-muted mt-1">{t('scrape.waitingForAgent')}</div>
        )}
      </PanelBody>
      <EventLog command={command} />
    </Panel>
  )
}

function CommandRow({ command }) {
  const { t, i18n } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-surface-sunken/60 transition-colors"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span
          className={cn('w-2 h-2 rounded-full shrink-0', STATUS_DOT[command.status])}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {formatClock(command.createdAt, i18n.language)}
            <span className="text-text-muted font-normal">
              {' '}
              · {(command.stores ?? []).join(', ')}
              {command.finishedAt && ` · ${formatClock(command.finishedAt, i18n.language)}`}
            </span>
          </div>
          {command.error && (
            <div className="text-xs text-danger truncate max-w-[60ch]">{command.error}</div>
          )}
        </div>
        <Chip
          variant={
            command.status === 'failed' || command.status === 'running' ? 'accent' : 'default'
          }
        >
          {t(statusKey(command.status))}
        </Chip>
      </button>
      {expanded && (
        <>
          <div className="px-5 pt-3 border-t border-border bg-surface-sunken/40 text-xs text-text-muted flex flex-wrap gap-x-4 gap-y-1">
            <span>
              {t('scrape.createdBy')}: {command.createdBy}
            </span>
            {command.exitCode != null && (
              <span>
                {t('scrape.exitCode')}: {command.exitCode}
              </span>
            )}
          </div>
          {/* Expanding fetches the full event log — the failure-log view. */}
          <EventLog command={command} />
        </>
      )}
    </div>
  )
}

function HistoryPanel({ commands, isLoading, isError }) {
  const { t } = useTranslation()
  return (
    <Panel>
      <PanelHead className="!py-4">
        <div className="font-semibold flex items-center gap-3">
          <IconClock size={18} /> {t('scrape.history')}
        </div>
      </PanelHead>
      {isLoading ? (
        <PanelBody>
          <SkeletonRows n={3} />
        </PanelBody>
      ) : isError ? (
        <PanelBody>
          <EmptyState icon={IconWarning} title={t('scrape.loadError')} desc={t('offline.banner')} />
        </PanelBody>
      ) : commands.length === 0 ? (
        <PanelBody>
          <EmptyState
            icon={IconBolt}
            title={t('scrape.noCommands')}
            desc={t('scrape.noCommandsDesc')}
          />
        </PanelBody>
      ) : (
        <PanelBody className="!py-0 !px-0">
          <div className="flex flex-col">
            {commands.map((command) => (
              <CommandRow key={command.id} command={command} />
            ))}
          </div>
        </PanelBody>
      )}
    </Panel>
  )
}

export function AdminScrape() {
  const { t } = useTranslation()
  const { data: me } = useMe()
  const isAdmin = me?.user?.isAdmin === true
  const { data, isLoading, isError } = useScrapeCommands()
  const commands = data?.commands ?? []
  const activeCommand = commands.find((command) => ACTIVE_STATUSES.has(command.status))

  if (!isAdmin) {
    return (
      <Panel>
        <EmptyState
          icon={IconWarning}
          title={t('scrape.forbidden')}
          desc={t('scrape.forbiddenDesc')}
        />
      </Panel>
    )
  }

  return (
    <>
      <div className="mb-6">
        <p className="text-md text-text-muted leading-snug max-w-[62ch]">{t('scrape.lead')}</p>
      </div>

      <TriggerPanel activeCommand={activeCommand} />
      {activeCommand && <ActiveRunCard command={activeCommand} />}
      <HistoryPanel commands={commands} isLoading={isLoading} isError={isError} />
    </>
  )
}
