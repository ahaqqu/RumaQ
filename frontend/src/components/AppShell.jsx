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
  IconBolt,
  IconReview,
  IconUserRound,
  IconLogout,
  IconSliders,
  BrandMark,
} from './icons.jsx'
import { useApp } from '../context/AppContext.jsx'
import { useMe, useLogout } from '../lib/queries/me.js'
import { useSettings, useUpdateSettings } from '../lib/queries/index.js'
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

// Mobile keeps the capture action in the tab bar's center slot; History is
// reachable from the mobile header instead (Figma shell). Mobile tabs use the
// short "Plan" label from the mockup — the full "Shopping Plan" overflows.
const MOBILE_TABS = NAV.filter((n) => ['home', 'inventory', 'plan', 'prices'].includes(n.id)).map(
  (n) => ({ ...n, key: n.id === 'plan' ? 'nav.planShort' : n.key })
)

const ADMIN_NAV = [
  { id: 'monitor', key: 'nav.monitor', Icon: IconSliders, to: '/admin/prices' },
  { id: 'review', key: 'nav.review', Icon: IconReview, to: '/admin/review' },
  { id: 'scrape', key: 'nav.scrape', Icon: IconBolt, to: '/admin/scrape' },
]

function LanguageSwitcher({ currentLang, onChange, ariaLabel }) {
  return (
    <div className="flex items-center gap-1 text-xs" role="group" aria-label={ariaLabel}>
      {['en', 'id'].map((lng, i) => (
        <span key={lng} className="flex items-center gap-1">
          {i > 0 && <span className="text-text-muted">/</span>}
          <button
            type="button"
            onClick={() => onChange(lng)}
            aria-pressed={currentLang === lng}
            className={
              currentLang === lng
                ? 'font-semibold text-accent'
                : 'text-text-muted hover:text-text transition-colors'
            }
          >
            {lng.toUpperCase()}
          </button>
        </span>
      ))}
    </div>
  )
}

export function AppShell({ children }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const matches = useMatches()
  const { aiKey, assistantOpen, setAssistantOpen } = useApp()
  const { data: me } = useMe()
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()
  const logout = useLogout()
  const [imgError, setImgError] = useState(false)

  const user = me?.user
  const householdName = settings?.active_household_name

  const currentLang = i18n.language?.startsWith('id') ? 'id' : 'en'
  const changeLanguage = (lng) => {
    if (lng === currentLang) return
    i18n.changeLanguage(lng)
    updateSettings.mutate({ language: lng })
  }

  const currentRouteId = matches[matches.length - 1]?.routeId || '/'
  // The scraping monitor and the manual scrape trigger are operator surfaces —
  // their nav entries only exist for admins (me.user.isAdmin from the
  // backend, backed by the users.is_admin grant).
  const navItems = user?.isAdmin ? [...NAV, ...ADMIN_NAV] : NAV
  const currentNav = navItems.find((n) => n.to === currentRouteId)
  const title = currentNav ? t(currentNav.key) : t('nav.home')
  const isActive = (to) => matches.some((m) => m.routeId === to)

  const today = new Intl.DateTimeFormat(i18n.language, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date())

  const renderNavItem = ({ id, key, Icon, to }) => (
    <NavItem key={id} to={to} active={isActive(to)}>
      <Icon size={21} className="shrink-0" /> {t(key)}
    </NavItem>
  )

  return (
    <div className="grid min-h-dvh lg:grid-cols-[240px_1fr]">
      <aside
        className="hidden lg:flex sticky top-0 h-dvh flex-col gap-8 p-6 bg-surface-raised border-r border-border"
        aria-label={t('nav.mainNav')}
      >
        <div className="flex items-center gap-2.5">
          <BrandMark size={36} />
          <div className="font-bold text-[27px] leading-[33px] tracking-[-1px] text-accent">
            RumaQ
          </div>
        </div>

        {householdName && (
          <div className="rounded-xl bg-surface-inset p-3" data-testid="household-card">
            <div className="text-[13px] font-semibold leading-[145%] text-text">
              {householdName}
            </div>
            <div className="text-[11px] leading-[145%] text-text-muted">
              {t('household.cardHint')}
            </div>
          </div>
        )}

        <nav className="flex flex-col gap-1.5" aria-label={t('nav.mainNav')}>
          {NAV.map(renderNavItem)}
        </nav>

        {user?.isAdmin && (
          <div className="flex flex-col gap-4">
            <div className="text-[10px] font-semibold leading-3 tracking-[1px] uppercase text-text-muted">
              {t('nav.adminGroup')}
            </div>
            <nav className="flex flex-col gap-1.5" aria-label={t('nav.adminGroup')}>
              {ADMIN_NAV.map(renderNavItem)}
            </nav>
          </div>
        )}

        <div className="mt-auto flex flex-col gap-4">
          <div className="h-px bg-border" aria-hidden="true" />
          {user && (
            <>
              <div className="flex items-center gap-3">
                {user.picture && !imgError ? (
                  <img
                    className="w-10 h-10 rounded-xl object-cover shrink-0"
                    src={user.picture}
                    alt=""
                    onError={() => setImgError(true)}
                  />
                ) : (
                  <div className="w-10 h-10 rounded-xl grid place-items-center bg-surface-inset text-text shrink-0">
                    <IconUserRound size={20} />
                  </div>
                )}
                <div className="min-w-0">
                  <div className="text-sm font-semibold leading-[145%] text-text truncate">
                    {user.name || user.email}
                  </div>
                  {user.name && (
                    <div className="text-xs leading-[145%] text-text-muted truncate">
                      {user.email}
                    </div>
                  )}
                </div>
              </div>
              <button
                className="flex items-center gap-2.5 text-[13px] text-text-muted hover:text-danger transition-colors"
                onClick={() => logout.mutate()}
              >
                <IconLogout size={18} /> {t('nav.logout', 'Logout')}
              </button>
            </>
          )}
        </div>
      </aside>

      <div className="min-w-0 flex flex-col">
        <OfflineBanner />
        <header className="sticky top-0 z-20 bg-surface/82 backdrop-blur border-b border-border">
          {/* Desktop header: breadcrumb + date, language and primary action.
              Rendered first so the breadcrumb is the DOM's first heading. */}
          <div className="hidden lg:flex items-center justify-between px-9 min-h-[88px]">
            <div className="flex flex-col gap-1.5 min-w-0">
              <h1 className="text-xs font-normal text-text-muted truncate">
                {t('shell.yourHousehold')} / {title}
              </h1>
              <p className="text-sm font-medium text-text">{today}</p>
            </div>
            <div className="flex items-center gap-5 shrink-0">
              <LanguageSwitcher
                currentLang={currentLang}
                onChange={changeLanguage}
                ariaLabel={t('settings.language')}
              />
              <Link to="/add">
                <Button>
                  <IconReceipt size={19} /> {t('nav.addFromReceipt')}
                </Button>
              </Link>
            </div>
          </div>
          {/* Mobile header: brand + title, History and Settings as compact actions */}
          <div className="lg:hidden flex items-center gap-3 px-4 py-3">
            <BrandMark size={36} />
            <h1 className="text-[26px] font-semibold tracking-[-1px] text-text truncate">
              {title}
            </h1>
            <div className="flex-1" />
            <Link
              to="/history"
              className="text-sm font-medium text-accent shrink-0"
              aria-current={isActive('/history') ? 'page' : undefined}
            >
              {t('nav.history')}
            </Link>
            <Link
              to="/settings"
              className="w-10 h-10 rounded-full grid place-items-center text-text-muted bg-surface-inset hover:text-text transition-colors shrink-0"
              aria-label={t('nav.settings')}
            >
              <IconSettings size={20} />
            </Link>
          </div>
        </header>

        <main className="px-4 py-5 lg:px-9 lg:py-9 lg:pb-16 pb-[calc(120px+env(safe-area-inset-bottom))] max-w-[1128px] w-full">
          {children}
        </main>
      </div>

      <nav
        className="lg:hidden fixed bottom-0 left-0 right-0 z-30 flex items-end justify-around bg-surface-raised border-t border-border px-2 pt-1 pb-[env(safe-area-inset-bottom)]"
        aria-label={t('nav.mainNav')}
      >
        {/* Icon-only tabs: five equal flex-1 slots, accessible name on each
            link (axe requires one when there is no visible text). */}
        {MOBILE_TABS.slice(0, 2).map(({ id, key, Icon, to }) => (
          <NavItem key={id} to={to} active={isActive(to)} mobile aria-label={t(key)}>
            <Icon size={26} />
          </NavItem>
        ))}
        <Link
          to="/add"
          className="flex-1 flex items-end justify-center min-h-14"
          aria-label={t('nav.postPhoto')}
        >
          <span className="flex flex-col items-center justify-center w-16 h-16 -mt-5 rounded-2xl bg-accent text-on-accent shadow-md">
            <IconReceipt size={26} />
          </span>
        </Link>
        {MOBILE_TABS.slice(2).map(({ id, key, Icon, to }) => (
          <NavItem key={id} to={to} active={isActive(to)} mobile aria-label={t(key)}>
            <Icon size={26} />
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
