import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useMatches, useNavigate } from '@tanstack/react-router'
import {
  IconHome,
  IconBox,
  IconPlan,
  IconHistory,
  IconSettings,
  IconReceipt,
  IconPrices,
  IconMonitor,
  IconBolt,
  IconReview,
  BrandMark,
} from './icons.jsx'
import { cn } from '../lib/cn.js'
import { formatTokens, usageMeterModel } from '../lib/usage.js'
import { useApp } from '../context/AppContext.jsx'
import { useMe, useLogout } from '../lib/queries/me.js'
import { useSettings, useUsage } from '../lib/queries/index.js'
import { Assistant } from './Assistant.jsx'
import { OfflineBanner } from './OfflineBanner.jsx'
import { Button } from './Button.jsx'
import { NavItem } from './NavItem.jsx'

const NAV = [
  { id: 'home', key: 'nav.home', Icon: IconHome, to: '/' },
  { id: 'inventory', key: 'nav.inventory', Icon: IconBox, to: '/inventory' },
  { id: 'plan', key: 'nav.plan', Icon: IconPlan, to: '/plan' },
  { id: 'history', key: 'nav.history', Icon: IconHistory, to: '/history' },
  { id: 'prices', key: 'nav.prices', Icon: IconPrices, to: '/prices' },
  { id: 'settings', key: 'nav.settings', Icon: IconSettings, to: '/settings' },
]

export function AppShell({ children }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const matches = useMatches()
  const { aiKey, assistantOpen, setAssistantOpen } = useApp()
  const { data: me } = useMe()
  const { data: settings } = useSettings()
  const logout = useLogout()
  const [imgError, setImgError] = useState(false)

  const hasBackendKey = settings?.has_ai_key === true
  const isAiConnected = Boolean(aiKey) || hasBackendKey
  const { data: usage } = useUsage()
  // Shared metering model: server-key usage gets the cap meter, own-key
  // usage the token counts (lib/usage.js).
  const meter = usageMeterModel(usage)
  const usageTone = meter ? (meter.danger ? 'text-danger' : meter.warn ? 'text-warn' : '') : ''

  const user = me?.user

  const currentRouteId = matches[matches.length - 1]?.routeId || '/'
  // The scraping monitor and the manual scrape trigger are operator surfaces —
  // their nav entries only exist for allowlisted admins (me.user.isAdmin from
  // the backend).
  const navItems = user?.isAdmin
    ? [
        ...NAV,
        { id: 'monitor', key: 'nav.monitor', Icon: IconMonitor, to: '/admin/prices' },
        { id: 'review', key: 'nav.review', Icon: IconReview, to: '/admin/review' },
        { id: 'scrape', key: 'nav.scrape', Icon: IconBolt, to: '/admin/scrape' },
      ]
    : NAV
  const currentNav = navItems.find((n) => n.to === currentRouteId)
  const title = currentNav ? t(currentNav.key) : t('nav.home')
  const isActive = (to) => matches.some((m) => m.routeId === to)

  return (
    <div className="grid min-h-dvh lg:grid-cols-[248px_1fr]">
      <aside
        className="hidden lg:flex sticky top-0 h-dvh flex-col px-4 py-5 gap-2 bg-surface-raised border-r border-border"
        aria-label={t('nav.home')}
      >
        <div className="flex items-center justify-center gap-3 pb-5 px-2 pt-2">
          <BrandMark size={56} />
          <div className="font-bold text-[26px] tracking-tight">RumaQ</div>
        </div>

        <Link to="/add" className="mx-1 mb-4">
          <Button block>
            <IconReceipt size={18} /> {t('nav.addFromReceipt')}
          </Button>
        </Link>

        <nav className="flex flex-col gap-0.5" aria-label={t('nav.home')}>
          {navItems.map(({ id, key, Icon, to }) => (
            <NavItem key={id} to={to} active={isActive(to)}>
              <Icon size={18} className="shrink-0 opacity-90" /> {t(key)}
            </NavItem>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-3 pt-4 border-t border-border">
          {user && (
            <div className="flex items-center gap-3 p-2 border-b border-border mb-0.5">
              {user.picture && !imgError ? (
                <img
                  className="w-9 h-9 rounded-pill object-cover shrink-0"
                  src={user.picture}
                  alt=""
                  onError={() => setImgError(true)}
                />
              ) : (
                <div className="w-9 h-9 rounded-pill grid place-items-center bg-accent text-on-accent font-semibold text-sm shrink-0">
                  {(user.name || '')
                    .split(' ')
                    .filter(Boolean)
                    .map((s) => s[0])
                    .slice(0, 2)
                    .join('')
                    .toUpperCase() || (user.email || '?')[0].toUpperCase()}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium whitespace-nowrap overflow-hidden text-ellipsis">
                  {user.name || t('nav.settings')}
                </div>
                <button
                  className="text-xs text-text-muted font-medium hover:text-danger underline-offset-2 hover:underline"
                  onClick={() => logout.mutate()}
                >
                  {t('nav.logout', 'Logout')}
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 text-sm text-text-muted px-2">
            <span
              className={cn(
                'w-2 h-2 rounded-full shrink-0',
                isAiConnected ? 'bg-ok' : 'bg-text-faint'
              )}
            />
            {isAiConnected ? t('assistant.connected') : t('assistant.noKey')}
          </div>

          {isAiConnected && meter && (
            <div className="flex flex-col gap-2 px-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-text-muted">
                  {meter.ownKey
                    ? t('ui.ownKeyTokensToday', {
                        input: formatTokens(meter.inputTokens),
                        output: formatTokens(meter.outputTokens),
                      })
                    : t('ui.requestsToday', {
                        used: meter.used,
                        limit: meter.limit,
                      })}
                </span>
                {!meter.ownKey && (
                  <span className={cn('font-semibold tabular-nums', usageTone)}>
                    {meter.used}/{meter.limit}
                  </span>
                )}
              </div>
              {!meter.ownKey && (
                <>
                  <div className="h-[5px] rounded-pill bg-surface-inset overflow-hidden">
                    <div
                      className={cn(
                        'h-full rounded-pill bg-accent transition-[width] duration-300',
                        meter.warn && 'bg-warn',
                        meter.danger && 'bg-danger'
                      )}
                      style={{ width: meter.pct + '%' }}
                    />
                  </div>
                  {meter.danger ? (
                    <div className="text-xs text-danger">{t('ui.dailyLimitReached')}</div>
                  ) : meter.warn ? (
                    <div className="text-xs text-warn">{t('assistant.closeToLimit')}</div>
                  ) : null}
                </>
              )}
            </div>
          )}
        </div>
      </aside>

      <div className="min-w-0 flex flex-col">
        <OfflineBanner />
        <header className="sticky top-0 z-20 flex items-center gap-3 px-4 py-3 lg:px-6 lg:py-4 bg-surface/82 backdrop-blur border-b border-border">
          <h1 className="font-semibold text-sm lg:text-base truncate">{title}</h1>
          <div className="flex-1" />
          <Link
            to="/add"
            className="w-10 h-10 rounded-md grid place-items-center text-text-muted border border-border bg-surface-raised hover:bg-surface-sunken hover:text-text transition-colors shrink-0"
            aria-label={t('nav.addFromReceipt')}
          >
            <IconReceipt size={18} />
          </Link>
          <Link
            to="/settings"
            className="w-10 h-10 rounded-md grid place-items-center text-text-muted border border-border bg-surface-raised hover:bg-surface-sunken hover:text-text transition-colors shrink-0"
            aria-label={t('nav.settings')}
          >
            <IconSettings size={18} />
          </Link>
        </header>

        <main className="px-4 py-5 lg:px-6 lg:pb-24 pb-[calc(168px+env(safe-area-inset-bottom))] max-w-[1080px]">
          {children}
        </main>
      </div>

      <nav
        className="lg:hidden fixed bottom-0 left-0 right-0 z-30 flex justify-around bg-surface-raised/92 backdrop-blur border-t border-border pb-[env(safe-area-inset-bottom)]"
        aria-label={t('nav.home')}
      >
        {NAV.filter((n) => n.id !== 'settings').map(({ id, key, Icon, to }) => (
          <NavItem key={id} to={to} active={isActive(to)} mobile>
            <Icon size={20} /> {t(key)}
          </NavItem>
        ))}
      </nav>

      <Assistant
        open={assistantOpen}
        onOpen={() => setAssistantOpen(true)}
        onClose={() => setAssistantOpen(false)}
        aiKey={aiKey}
        onNavigate={(view) => navigate({ to: `/${view === 'home' ? '' : view}` })}
      />
    </div>
  )
}
