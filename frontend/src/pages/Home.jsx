import { useTranslation } from 'react-i18next'
import { useHome, usePlans } from '../lib/queries/index.js'
import { useMe } from '../lib/queries/me.js'
import { getGreetingKey } from '../lib/greeting.js'
import { personaText } from '../lib/persona.js'
import { usePersona } from '../context/PersonaContext.jsx'
import { useApp } from '../context/AppContext.jsx'
import { IconSprout, IconCheck, IconArrowRight, IconLeaf } from '../components/icons.jsx'
import { Badge } from '../components/Badge.jsx'
import { Panel } from '../components/Panel.jsx'
import { EmptyState } from '../components/EmptyState.jsx'
import { SkeletonRows } from '../components/Skeleton.jsx'
import { Button } from '../components/Button.jsx'

// Assistant seed prompt for the recipe card bridge (#332 replaces this with a
// dedicated recipe-search endpoint later).
const RECIPE_SEED_PROMPT =
  'Find a recipe on recipe websites that uses up items I already have at home, prioritizing what expires soon. Suggest one recipe with its name, source website link, time, servings, and which of my pantry items it uses up.'

// Figma money style: "Rp 1.245.000" regardless of UI language (same
// convention as the Plan screen).
const formatPrice = (amount) =>
  new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
  }).format(amount ?? 0)

function getDaysUntil(expiryDate) {
  if (!expiryDate) return null
  const now = new Date()
  const expiry = new Date(expiryDate + 'T00:00:00')
  return Math.round((expiry - now) / 86400000)
}

// Effective urgency in days for a low-stock row: whichever of expiry and
// run-out estimate lands first.
function urgencyDays(row) {
  const expiryDays = getDaysUntil(row.expiry_date)
  const runOut = typeof row.run_out_days === 'number' ? row.run_out_days : null
  if (expiryDays == null && runOut == null) return null
  if (expiryDays == null) return runOut
  if (runOut == null) return expiryDays
  return Math.min(expiryDays, runOut)
}

function urgencyTone(days) {
  if (days == null) return 'muted'
  if (days <= 1) return 'danger'
  if (days <= 3) return 'warn'
  return 'muted'
}

function StatCard({ label, value, sub, testid }) {
  return (
    <div
      className="bg-surface-raised border border-border rounded-[18px] p-4 flex flex-col gap-1.5"
      data-testid={testid}
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
        {label}
      </div>
      <div className="text-[34px] leading-[41px] font-semibold tracking-[-1px] text-text">
        {value}
      </div>
      <div className="text-xs text-text-muted">{sub}</div>
    </div>
  )
}

function AttentionRow({ item, onOpenInventory, t }) {
  const days = urgencyDays(item)
  const tone = urgencyTone(days)
  const initial = (item.name || '?').trim().charAt(0).toUpperCase()
  const qtyLine = [item.qty, item.unit].filter(Boolean).join(' ')
  const estimate =
    days == null
      ? null
      : days <= 0
        ? t('home.estimateToday')
        : t('home.estimateDaysLeft', { count: days })

  return (
    <button
      type="button"
      onClick={onOpenInventory}
      className="w-full flex items-center gap-4 px-5 py-4 border-b border-border last:border-b-0 hover:bg-surface-sunken/60 transition-colors text-left"
    >
      <span className="w-12 h-12 rounded-xl bg-surface-inset grid place-items-center text-sm font-semibold text-text-muted shrink-0">
        {initial}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-text truncate">{item.name}</span>
        <span className="block text-[13px] text-text-muted truncate">
          {[qtyLine, estimate].filter(Boolean).join(' · ')}
        </span>
      </span>
      <Badge tone={tone}>
        {tone === 'danger'
          ? t('home.badgeCritical')
          : tone === 'warn'
            ? t('home.badgeLowSoon')
            : t('home.badgeWatch')}
      </Badge>
    </button>
  )
}

export function Home({ setView, askAssistant }) {
  const { t, i18n } = useTranslation()
  const { persona } = usePersona()
  const { setAssistantSeed } = useApp()
  const { data, isLoading } = useHome()
  const { data: meData } = useMe()
  const { data: plansData } = usePlans('active')

  const totalItems = data?.total_items ?? 0
  const attentionCount = data?.attention_count ?? 0
  const needs = data?.low_stock ?? []
  const monthSpend = data?.current_month_spend ?? 0
  const monthReceipts = data?.current_month_receipts ?? 0

  const activePlan = plansData?.plans?.[0] ?? null
  const planItems = activePlan?.items ?? []
  const planStores = [...new Set(planItems.map((it) => it.store_label).filter(Boolean))]

  const firstName = (meData?.user?.name || '').split(' ').filter(Boolean)[0]
  const greeting = firstName
    ? `${t(getGreetingKey(new Date(), i18n.language))}, ${firstName}`
    : t(getGreetingKey(new Date(), i18n.language))
  const monthName = new Intl.DateTimeFormat(i18n.language, { month: 'long' }).format(new Date())

  const openRecipeAssistant = () => {
    setAssistantSeed(RECIPE_SEED_PROMPT)
    askAssistant?.()
  }

  if (isLoading) {
    return (
      <Panel>
        <SkeletonRows n={4} />
      </Panel>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Greeting */}
      <div className="flex items-start justify-between gap-4" data-testid="home-greeting">
        <div className="min-w-0">
          <h1 className="text-[28px] lg:text-[34px] leading-tight font-semibold tracking-[-1px] text-text">
            {greeting}
          </h1>
          <p className="mt-2 text-sm text-text-muted leading-snug max-w-[62ch]">
            {personaText('homeLead', persona, t)}
          </p>
        </div>
        <span className="hidden sm:inline-flex items-center gap-1.5 rounded-[10px] bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent shrink-0">
          <IconCheck size={12} /> {t('home.companionChip')}
        </span>
      </div>

      {/* Stats: hero card on mobile, three cards on desktop (Figma) */}
      <div
        className="lg:hidden rounded-[18px] bg-accent text-on-accent p-6 flex items-center justify-between gap-4"
        data-testid="home-hero"
      >
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] opacity-80">
            {t('home.heroLabel')}
          </div>
          <div className="mt-1 text-[30px] font-semibold tracking-[-1px]">
            {t('home.essentialsCount', { count: totalItems })}
          </div>
          <div className="mt-1 text-sm opacity-90">
            {t('home.heroRunningLow', { count: attentionCount })}
          </div>
        </div>
        <div className="rounded-xl bg-white/15 grid place-items-center w-16 h-16 shrink-0">
          <IconSprout size={32} />
        </div>
      </div>
      <div className="hidden lg:grid grid-cols-3 gap-6" data-testid="home-stats">
        <StatCard
          testid="stat-kitchen"
          label={t('home.statKitchenLabel')}
          value={t('home.essentialsCount', { count: totalItems })}
          sub={t('home.statKitchenSub')}
        />
        <StatCard
          testid="stat-attention"
          label={t('home.statLookLabel')}
          value={t('home.runningLowCount', { count: attentionCount })}
          sub={t('home.statLookSub')}
        />
        <StatCard
          testid="stat-spending"
          label={t('home.statSpendingLabel', { month: monthName })}
          value={formatPrice(monthSpend)}
          sub={t('home.receiptsCount', { count: monthReceipts })}
        />
      </div>

      {/* Needs attention */}
      <section data-testid="home-attention">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-text">
            <span className="hidden lg:inline">{t('home.attentionTitle')}</span>
            <span className="lg:hidden">{t('home.useSoonTitle')}</span>
          </h2>
          <button
            type="button"
            onClick={() => setView?.('inventory')}
            className="inline-flex items-center gap-1 text-[13px] font-semibold text-accent hover:underline"
          >
            {t('home.viewInventory')} <IconArrowRight size={15} />
          </button>
        </div>
        {needs.length > 0 ? (
          <>
            <Panel className="px-0 py-0">
              {needs.slice(0, 5).map((item) => (
                <AttentionRow
                  key={item.id}
                  item={item}
                  t={t}
                  onOpenInventory={() => setView?.('inventory')}
                />
              ))}
            </Panel>
          </>
        ) : (
          <Panel className="px-0 py-0">
            <EmptyState icon={IconSprout} title={t('home.allSafe')} desc={t('home.allSafeDesc')} />
          </Panel>
        )}
      </section>

      {/* Next trip teaser — only when there is an active plan */}
      {activePlan && planItems.length > 0 && (
        <section
          className="rounded-[18px] bg-accent-soft border border-accent-soft-border p-5 grid gap-3 md:grid-cols-[1fr_auto] md:items-center"
          data-testid="home-plan-teaser"
        >
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-accent">
              {t('home.planTeaserLabel')}
            </div>
            <div className="mt-1 text-sm font-semibold text-text truncate">
              {planStores.length > 0
                ? t('home.shopAt', { store: planStores.join(', ') })
                : t('home.planTeaserTitle')}
            </div>
            <div className="mt-0.5 text-[13px] text-text-muted">
              {t('home.itemCount', { count: planItems.length })}
              {activePlan.total_estimate ? ` · ${formatPrice(activePlan.total_estimate)}` : ''}
            </div>
          </div>
          <Button size="sm" onClick={() => setView?.('plan')}>
            {t('home.viewPlan')}
          </Button>
        </section>
      )}

      {/* Recipe card — assistant bridge until #332 lands */}
      {needs.length > 0 && (
        <section
          className="rounded-[18px] bg-surface-raised border border-border p-5 flex items-start gap-4"
          data-testid="home-recipe-card"
        >
          <span className="w-10 h-10 rounded-xl bg-accent-soft grid place-items-center text-accent shrink-0">
            <IconLeaf size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-text">{t('home.recipeTitle')}</div>
            <p className="mt-1 text-[13px] text-text-muted leading-[145%]">
              {t('home.recipeDesc')}
            </p>
            <button
              type="button"
              onClick={openRecipeAssistant}
              className="mt-2 inline-flex items-center gap-1 text-[13px] font-semibold text-accent hover:underline"
            >
              {t('home.recipeCta')} <IconArrowRight size={15} />
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
