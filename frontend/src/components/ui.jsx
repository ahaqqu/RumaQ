import { useTranslation } from 'react-i18next'
import { IconPin, IconClock, IconShop } from './icons.jsx'
import { formatTokens, formatCacheRate, usageMeterModel } from '../lib/usage.js'
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
  const meter = usageMeterModel(usage)
  if (!meter) return null

  return (
    <div className="flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="font-semibold text-base">{usage.provider}</div>
          <div className="text-sm text-text-muted mt-0.5">
            {t('ui.usageTokensToday', {
              used: meter.used,
              input: formatTokens(meter.inputTokens),
              output: formatTokens(meter.outputTokens),
            })}
          </div>
        </div>
        {/* Hidden when the provider reports no cache data — unknown, not 0%. */}
        {meter.cacheHitRate !== null && (
          <div className="text-right shrink-0">
            <div className="font-bold text-lg tabular-nums">
              {formatCacheRate(meter.cacheHitRate)}
            </div>
            <div className="text-xs text-text-muted">{t('ui.cacheHitRate')}</div>
          </div>
        )}
      </div>
      <div className="text-sm text-text-muted">
        {meter.ownKey ? t('ui.ownKeyUnlimited') : t('ui.serverKeyRecorded')}
      </div>
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
