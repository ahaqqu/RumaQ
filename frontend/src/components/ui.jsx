import { useTranslation } from 'react-i18next'
import { IconPin, IconClock, IconShop } from './icons.jsx'
import { usageState } from '../data/mock.js'
import { cn } from '../lib/cn.js'
import { Chip } from './Chip.jsx'
import { Badge } from './Badge.jsx'
import { EmptyState } from './EmptyState.jsx'
import { SkeletonRows } from './Skeleton.jsx'

export function LocChip({ loc }) {
  return (
    <Chip variant="loc">
      <IconPin size={13} />
      {loc}
    </Chip>
  )
}

export function TimeSignal({ expiryDays, runOut, basis }) {
  const { t } = useTranslation()
  const hasExpiry = expiryDays != null
  const useExpiry = hasExpiry && expiryDays <= runOut
  const title = basis ? t('ui.estimatedBy', { basis }) : undefined

  if (useExpiry) {
    if (expiryDays <= 1)
      return (
        <span
          className="inline-flex items-center gap-1 text-sm font-medium text-danger"
          title={title}
        >
          <IconClock size={13} /> {t('ui.expiringTomorrow')}
        </span>
      )
    const tone = expiryDays <= 3 ? 'warn' : 'muted'
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 text-sm font-medium',
          tone === 'warn' && 'text-warn',
          tone === 'muted' && 'text-text-muted'
        )}
        title={title}
      >
        <IconClock size={13} /> {t('ui.expiringIn', { days: expiryDays })}
      </span>
    )
  }

  const tone = runOut <= 2 ? 'danger' : runOut <= 3 ? 'warn' : 'muted'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-sm font-medium',
        tone === 'danger' && 'text-danger',
        tone === 'warn' && 'text-warn',
        tone === 'muted' && 'text-text-muted'
      )}
      title={title}
    >
      <IconClock size={13} /> {t('ui.runsOutIn', { days: runOut })}
    </span>
  )
}

export { EmptyState, SkeletonRows }

export function UsageMeter({ usage }) {
  const { t } = useTranslation()
  // Without loaded data render nothing — the mock fallback would misreport
  // provider and counts as real usage.
  if (!usage) return null
  // The daily cap only applies to RumaQ's shared server key; a user's own
  // key is unmetered.
  const ownKey = usage.key_source === 'user'
  const normalized = { ...usage, limit: usage.limit ?? usage.daily_limit ?? 20 }
  const { pct, remaining, warn, danger } = usageState(normalized)
  const tone = !ownKey && danger ? 'danger' : !ownKey && warn ? 'warn' : 'muted'

  return (
    <div className="flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="font-semibold text-base">{normalized.provider}</div>
          <div className="text-sm text-text-muted mt-0.5">
            {ownKey
              ? t('ui.ownKeyRequestsToday', { used: normalized.used })
              : t('ui.requestsToday', {
                  used: normalized.used,
                  limit: normalized.limit,
                })}
          </div>
        </div>
        <div
          className={cn(
            'font-bold text-lg tabular-nums',
            tone === 'danger' && 'text-danger',
            tone === 'warn' && 'text-warn'
          )}
        >
          {ownKey ? normalized.used : `${normalized.used}/${normalized.limit}`}
        </div>
      </div>
      {!ownKey && (
        <>
          <div className="h-2 rounded-pill bg-surface-inset overflow-hidden">
            <div
              className={cn(
                'h-full rounded-pill bg-accent transition-[width] duration-300 ease-out',
                tone === 'warn' && 'bg-warn',
                tone === 'danger' && 'bg-danger'
              )}
              style={{ width: pct + '%' }}
            />
          </div>
          {danger ? (
            <div className="text-sm text-danger">{t('ui.dailyLimitReachedDesc')}</div>
          ) : warn ? (
            <div className="text-sm text-warn font-medium">
              {t('ui.closeToLimitDesc', { remaining })}
            </div>
          ) : (
            <div className="text-sm text-text-muted">
              {t('ui.remainingRequests', { remaining })}
            </div>
          )}
        </>
      )}
      {ownKey && <div className="text-sm text-text-muted">{t('ui.ownKeyUnlimited')}</div>}
    </div>
  )
}

export function MetaItem({ icon: Icon, children }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Icon size={13} />
      {children}
    </span>
  )
}

export { IconPin, IconClock, IconShop }
export { Chip, Badge }
