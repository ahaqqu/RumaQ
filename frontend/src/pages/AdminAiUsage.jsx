import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMe } from '../lib/queries/me.js'
import { useAdminAiUsage } from '../lib/queries/index.js'
import { EmptyState, SkeletonRows } from '../components/ui.jsx'
import { Panel, PanelHead, PanelBody } from '../components/Panel.jsx'
import { Button } from '../components/Button.jsx'
import { IconSpark, IconWarning } from '../components/icons.jsx'
import { formatCacheRate } from '../lib/usage.js'
import { cn } from '../lib/cn.js'

const RANGES = [
  { id: '24h', key: 'aiUsage.range24h' },
  { id: '7d', key: 'aiUsage.range7d' },
  { id: '30d', key: 'aiUsage.range30d' },
]

function formatInt(n, locale) {
  return new Intl.NumberFormat(locale).format(Number(n) || 0)
}

function formatClock(iso, locale) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(locale, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Exact counts — this is an admin analytics surface, compact "18.2k" rounding
// belongs to the personal meter, not here.
function TotalCard({ label, value, locale }) {
  return (
    <div className="flex-1 min-w-[140px] rounded-md border border-border bg-surface-sunken/40 px-4 py-3">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="font-bold text-xl tabular-nums mt-1">{formatInt(value, locale)}</div>
    </div>
  )
}

// Unknown (provider reported no cache) renders as "—", never 0%.
function CacheRate({ rate }) {
  return <span className="tabular-nums">{formatCacheRate(rate) ?? '—'}</span>
}

export function AdminAiUsage() {
  const { t, i18n } = useTranslation()
  const { data: me } = useMe()
  const isAdmin = me?.user?.isAdmin === true
  const [range, setRange] = useState('24h')
  const { data, isLoading, isError } = useAdminAiUsage(range)

  if (!isAdmin) {
    return (
      <Panel>
        <EmptyState
          icon={IconWarning}
          title={t('aiUsage.forbidden')}
          desc={t('aiUsage.forbiddenDesc')}
        />
      </Panel>
    )
  }

  const totals = data?.totals
  const users = data?.users ?? []

  return (
    <>
      <div className="mb-6">
        <p className="text-md text-text-muted leading-snug max-w-[62ch]">{t('aiUsage.lead')}</p>
      </div>

      <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label={t('aiUsage.lead')}>
        {RANGES.map((r) => (
          <Button
            key={r.id}
            size="sm"
            variant={range === r.id ? 'primary' : 'secondary'}
            aria-pressed={range === r.id}
            onClick={() => setRange(r.id)}
          >
            {t(r.key)}
          </Button>
        ))}
      </div>

      <Panel className="mb-4">
        <PanelHead className="!py-4">
          <div className="font-semibold flex items-center gap-3">
            <IconSpark size={18} /> {t('nav.aiUsage')}
          </div>
          {totals?.cache_hit_rate != null && (
            <div className="text-sm text-text-muted">
              {t('aiUsage.cacheHitRate')}:{' '}
              <span className="font-semibold text-text tabular-nums">
                {formatCacheRate(totals.cache_hit_rate) ?? '—'}
              </span>
            </div>
          )}
        </PanelHead>
        <PanelBody className="text-sm">
          {isLoading ? (
            <SkeletonRows n={2} />
          ) : isError ? (
            <EmptyState
              icon={IconWarning}
              title={t('aiUsage.loadError')}
              desc={t('offline.banner')}
            />
          ) : (
            <div className="flex flex-wrap gap-3">
              <TotalCard
                label={t('aiUsage.totalCalls')}
                value={totals?.calls}
                locale={i18n.language}
              />
              <TotalCard
                label={t('aiUsage.totalInput')}
                value={totals?.input_tokens}
                locale={i18n.language}
              />
              <TotalCard
                label={t('aiUsage.totalOutput')}
                value={totals?.output_tokens}
                locale={i18n.language}
              />
            </div>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelBody className="!py-0 !px-0">
          {isLoading ? (
            <div className="px-5 py-4">
              <SkeletonRows n={4} />
            </div>
          ) : isError ? (
            <div className="px-5 py-6">
              <EmptyState
                icon={IconWarning}
                title={t('aiUsage.loadError')}
                desc={t('offline.banner')}
              />
            </div>
          ) : users.length === 0 ? (
            <div className="px-5 py-6">
              <EmptyState
                icon={IconSpark}
                title={t('aiUsage.empty')}
                desc={t('aiUsage.emptyDesc')}
              />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-text-muted border-b border-border">
                  <th scope="col" className="px-5 py-3 font-medium">
                    {t('aiUsage.userColumn')}
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium text-right">
                    {t('aiUsage.callsColumn')}
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium text-right">
                    {t('aiUsage.inputColumn')}
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium text-right">
                    {t('aiUsage.outputColumn')}
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium text-right">
                    {t('aiUsage.cacheColumn')}
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium text-right">
                    {t('aiUsage.lastUsedColumn')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr
                    key={user.user_id}
                    className={cn(
                      'border-b border-border last:border-b-0 hover:bg-surface-sunken/40'
                    )}
                  >
                    <td
                      className="px-5 py-3 max-w-[24ch] truncate"
                      title={user.email ?? user.user_id}
                    >
                      {user.email ?? user.user_id}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {formatInt(user.calls, i18n.language)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {formatInt(user.input_tokens, i18n.language)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {formatInt(user.output_tokens, i18n.language)}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <CacheRate rate={user.cache_hit_rate} />
                    </td>
                    <td className="px-5 py-3 text-right text-text-muted whitespace-nowrap">
                      {formatClock(user.last_used, i18n.language)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </PanelBody>
      </Panel>
    </>
  )
}
