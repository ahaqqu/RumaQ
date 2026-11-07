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

/**
 * One Settings row: title + description on the left, control on the right,
 * stacked on small screens when the control is wide (`stack`). Shared by the
 * Settings page and its AI section (ahaqqu/RumaQ#523 P3, review B1).
 */
export function Setting({ title, desc, children, className, highlight, stack = false }) {
  return (
    <div
      className={cn(
        'px-5 py-4 border-b border-border last:border-b-0',
        // Rows with wide controls (selects, toggle pills, input+button) stack
        // label-above-control on mobile and go side-by-side from sm. Compact
        // rows (icon buttons, checkboxes) stay on one line at every width.
        stack
          ? 'flex flex-col items-start gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4'
          : 'flex items-center justify-between gap-4',
        highlight === 'ok' && 'bg-ok-soft/50',
        highlight === 'warn' && 'bg-warn-soft/50',
        highlight === 'danger' && 'bg-danger-soft/50 border-danger-border',
        className
      )}
    >
      <div className="min-w-0">
        {title && <div className="font-medium">{title}</div>}
        {desc && <div className="text-sm text-text-muted mt-0.5">{desc}</div>}
      </div>
      {children}
    </div>
  )
}

// The personal usage meter (#523 P4): the acting member's today totals, broken
// down by capability, with the household total beside them. No provider title:
// a household may point each capability at a different row, so the capability
// IS the attribution.
export function UsageMeter({ usage }) {
  const { t } = useTranslation()
  const meter = usageMeterModel(usage)
  if (!meter) return null

  return (
    <div className="flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="font-semibold text-base">{t('ui.usageTitle')}</div>
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

      {meter.capabilities.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {meter.capabilities.map((row) => (
            <li
              key={row.capability ?? 'unknown'}
              className="flex items-start justify-between gap-4 text-sm"
            >
              <span className="text-text-muted">
                {row.capability
                  ? t(`settings.ai.${row.capability}`)
                  : t('ui.usageUnknownCapability')}
              </span>
              <span className="text-right">
                <span className="tabular-nums">
                  {t('ui.usageTokensToday', {
                    used: row.calls,
                    input: formatTokens(row.inputTokens),
                    output: formatTokens(row.outputTokens),
                  })}
                </span>
                {/* A typed provider reports no tokens: say so instead of a 0. */}
                {row.typedCalls > 0 && (
                  <span className="block text-xs text-text-muted">
                    {t('ui.usageTypedCalls', { calls: row.typedCalls })}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {meter.household && (
        <div className="text-sm text-text-muted">
          {t('ui.usageHouseholdToday', {
            used: meter.household.used,
            input: formatTokens(meter.household.inputTokens),
            output: formatTokens(meter.household.outputTokens),
          })}
        </div>
      )}

      <div className="text-sm text-text-muted">{t('ui.ownKeyUnlimited')}</div>
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
