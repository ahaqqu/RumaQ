import { useTranslation } from 'react-i18next'
import { usePlans, useGeneratePlan, useSavePlan, useUpdatePlanItem } from '../lib/queries/index.js'
import { useSettings } from '../lib/queries/index.js'
import { usePersona } from '../context/PersonaContext.jsx'
import { useApp } from '../context/AppContext.jsx'
import { personaText } from '../lib/persona.js'
import { SkeletonRows, EmptyState } from '../components/ui.jsx'
import {
  IconSpark,
  IconShop,
  IconCheck,
  IconKey,
  IconBolt,
  IconClose,
} from '../components/icons.jsx'
import { cn } from '../lib/cn.js'
import { Button } from '../components/Button.jsx'
import { Chip } from '../components/Chip.jsx'
import { Panel, PanelHead, PanelBody } from '../components/Panel.jsx'

function formatPrice(amount, currency) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: currency || 'IDR',
    minimumFractionDigits: 0,
  }).format(amount)
}

export function Plan({ askAssistant, setView }) {
  const { t } = useTranslation()
  const { persona } = usePersona()
  const { assistantProposal, setAssistantProposal } = useApp()
  const { data: settings, isLoading: settingsLoading } = useSettings()
  const { data: plansData, isLoading: plansLoading } = usePlans('active')
  const generateMutation = useGeneratePlan()
  const saveMutation = useSavePlan()
  const updateItemMutation = useUpdatePlanItem()

  const hasAiKey = settings?.has_ai_key === true
  const currency = settings?.currency || 'IDR'

  const activePlan = plansData?.plans?.[0] ?? null
  const generatedItems = generateMutation.data?.items ?? null

  const renderProposalBanner = () => {
    if (!assistantProposal) return null
    return (
      <Panel className="p-5 mb-4 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="text-accent">
            <IconSpark size={18} />
          </span>
          <strong>{t('assistant.applyToPlan')}</strong>
          <button
            className="ml-auto w-9 h-9 rounded-md grid place-items-center text-text-muted hover:bg-surface-sunken hover:text-text transition-colors"
            onClick={() => setAssistantProposal(null)}
            aria-label={t('assistant.closeAriaLabel')}
          >
            <IconClose size={16} />
          </button>
        </div>
        <p className="whitespace-pre-wrap m-0">{assistantProposal}</p>
      </Panel>
    )
  }

  const allDone =
    activePlan && activePlan.items.every((it) => it.status === 'bought' || it.status === 'skipped')

  const itemsByStore = (items) => {
    const map = {}
    for (const it of items) {
      const storeId = it.store_id || '__unknown__'
      if (!map[storeId]) {
        map[storeId] = {
          store_id: storeId,
          store_label: it.store_label || t('plan.otherStore'),
          items: [],
        }
      }
      map[storeId].items.push(it)
    }
    return Object.values(map)
  }

  const handleCheckItem = (planId, itemId, currentStatus) => {
    if (currentStatus !== 'pending') return
    updateItemMutation.mutate({ planId, itemId, status: 'bought' })
  }

  const handleSaveDraft = async () => {
    const items = generatedItems.map((it) => ({
      name: it.name,
      qty: it.qty,
      unit: it.unit,
      store_id: it.store_id,
      price_estimate: it.price_estimate,
      why: it.why,
      price_observation_id: it.price_observation_id,
    }))
    await saveMutation.mutateAsync(items)
    generateMutation.reset()
  }

  const handleDiscardDraft = () => {
    generateMutation.reset()
  }

  if (settingsLoading || plansLoading) {
    return (
      <Panel>
        <SkeletonRows n={4} />
      </Panel>
    )
  }

  if (!hasAiKey) {
    return (
      <>
        <div className="mb-6">
          <p className="text-md text-text-muted leading-snug max-w-[62ch]">
            {personaText('planLeadNoKey', persona, t)}
          </p>
        </div>
        {renderProposalBanner()}
        <Panel>
          <EmptyState
            icon={IconKey}
            title={t('plan.connectApiKey')}
            desc={t('plan.bringYourOwnKey')}
            action={
              <Button onClick={() => setView('settings')}>
                <IconKey size={18} /> {t('plan.addApiKey')}
              </Button>
            }
          />
        </Panel>
      </>
    )
  }

  if (generateMutation.isPending) {
    return (
      <>
        <div className="mb-6">
          <p className="text-md text-text-muted leading-snug max-w-[62ch]">
            {personaText('planLead', persona, t)}
          </p>
        </div>
        {renderProposalBanner()}
        <Panel>
          <SkeletonRows n={4} />
        </Panel>
      </>
    )
  }

  if (generatedItems) {
    const stores = itemsByStore(generatedItems)
    const grandTotal = generatedItems.reduce((s, it) => s + (it.price_estimate || 0), 0)

    return (
      <>
        <div className="mb-6">
          <p className="text-md text-text-muted leading-snug max-w-[62ch]">
            {personaText('planLead', persona, t)}
          </p>
        </div>
        {renderProposalBanner()}

        <div className="flex flex-wrap gap-3 mb-5">
          <Button onClick={handleSaveDraft} disabled={saveMutation.isPending}>
            <IconCheck size={18} /> {t('plan.savePlan')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
          >
            <IconSpark size={18} /> {t('plan.regenerate')}
          </Button>
          <Button variant="ghost" onClick={handleDiscardDraft} disabled={saveMutation.isPending}>
            {t('plan.discardDraft')}
          </Button>
          {grandTotal > 0 && (
            <Chip className="self-center">
              {t('plan.stores', { count: stores.length })} · {formatPrice(grandTotal, currency)}
            </Chip>
          )}
        </div>

        {stores.map((store) => (
          <Panel key={store.store_id} className="mb-4">
            <PanelHead className="!py-4">
              <div className="font-semibold flex items-center gap-3">
                <IconShop size={18} /> {store.store_label}
              </div>
              <div className="text-text-muted text-sm">
                {t('home.itemCount', { count: store.items.length })} ·{' '}
                {formatPrice(
                  store.items.reduce((s, it) => s + (it.price_estimate || 0), 0),
                  currency
                )}
              </div>
            </PanelHead>
            <PanelBody className="!py-0 !px-0">
              <div className="flex flex-col">
                {store.items.map((it) => (
                  <div
                    className="grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-3 border-b border-border last:border-b-0"
                    key={it.name}
                  >
                    <div className="min-w-0">
                      <div className="font-medium">
                        {it.name} · {it.qty}
                        {it.unit ? ` ${it.unit}` : ''}
                      </div>
                      <div className="text-xs text-text-muted mt-0.5">{it.why}</div>
                      {it.price_source_name && it.price_estimate != null && (
                        <div className="text-xs text-accent-hover mt-0.5">
                          {t('plan.groundedFrom', { source: it.price_source_name })}
                          {it.price_valid_until &&
                            ` · ${t('plan.groundedUntil', { date: it.price_valid_until })}`}
                        </div>
                      )}
                    </div>
                    {it.price_estimate != null && (
                      <div className="text-sm font-semibold">
                        {formatPrice(it.price_estimate, currency)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </PanelBody>
          </Panel>
        ))}
      </>
    )
  }

  if (!activePlan) {
    return (
      <>
        <div className="mb-6">
          <p className="text-md text-text-muted leading-snug max-w-[62ch]">
            {personaText('planLead', persona, t)}
          </p>
        </div>
        {renderProposalBanner()}
        <Panel>
          <EmptyState
            icon={IconSpark}
            title={t('plan.noActivePlan')}
            desc={t('plan.generatePrompt')}
            action={
              <Button
                onClick={() => generateMutation.mutate()}
                disabled={generateMutation.isPending}
              >
                <IconSpark size={18} /> {t('plan.generate')}
              </Button>
            }
          />
        </Panel>
      </>
    )
  }

  const stores = itemsByStore(activePlan.items)
  const grandTotal = activePlan.items.reduce((s, it) => s + (it.price_estimate || 0), 0)

  return (
    <>
      <div className="mb-6">
        <p className="text-md text-text-muted leading-snug max-w-[62ch]">
          {personaText('planLead', persona, t)}
        </p>
      </div>

      {renderProposalBanner()}

      <div className="flex flex-wrap gap-3 mb-5">
        <Button
          variant="secondary"
          onClick={() => generateMutation.mutate()}
          disabled={generateMutation.isPending}
        >
          <IconSpark size={18} /> {t('plan.regenerate')}
        </Button>
        {grandTotal > 0 && (
          <Chip className="self-center">
            {t('plan.stores', { count: stores.length })} · {formatPrice(grandTotal, currency)}
          </Chip>
        )}
      </div>

      {stores.map((store) => (
        <Panel key={store.store_id} className="mb-4">
          <PanelHead className="!py-4">
            <div className="font-semibold flex items-center gap-3">
              <IconShop size={18} /> {store.store_label}
            </div>
            <div className="text-text-muted text-sm">
              {t('home.itemCount', { count: store.items.length })} ·{' '}
              {formatPrice(
                store.items.reduce((s, it) => s + (it.price_estimate || 0), 0),
                currency
              )}
            </div>
          </PanelHead>
          <PanelBody className="!py-0 !px-0">
            <div className="flex flex-col">
              {store.items.map((it) => {
                const isDone = it.status === 'bought'
                const isSkipped = it.status === 'skipped'
                return (
                  <label
                    className={cn(
                      'grid grid-cols-[auto_1fr_auto] items-center gap-4 px-5 py-3 border-b border-border last:border-b-0',
                      isDone && 'opacity-45',
                      (isDone || isSkipped) && 'cursor-default'
                    )}
                    key={it.id}
                  >
                    <input
                      type="checkbox"
                      className="w-5 h-5 accent-accent"
                      checked={isDone}
                      disabled={isDone || isSkipped}
                      onChange={() => handleCheckItem(activePlan.id, it.id, it.status)}
                    />
                    <div className="min-w-0">
                      <div className={cn('font-medium', isDone && 'line-through')}>
                        {it.item_name || it.name} · {it.qty}
                        {it.unit ? ` ${it.unit}` : ''}
                      </div>
                      {it.why && <div className="text-xs text-text-muted mt-0.5">{it.why}</div>}
                      {it.price_source_name && it.price_estimate != null && (
                        <div className="text-xs text-accent-hover mt-0.5">
                          {t('plan.groundedFrom', { source: it.price_source_name })}
                          {it.price_valid_until &&
                            ` · ${t('plan.groundedUntil', { date: it.price_valid_until })}`}
                        </div>
                      )}
                    </div>
                    {it.price_estimate != null && (
                      <div className="text-sm font-semibold">
                        {formatPrice(it.price_estimate, currency)}
                      </div>
                    )}
                  </label>
                )
              })}
            </div>
          </PanelBody>
        </Panel>
      ))}

      {allDone ? (
        <Panel className="p-5 flex gap-4 items-center">
          <div className="text-ok">
            <IconCheck size={22} />
          </div>
          <div className="flex-1 text-sm">
            <strong>{t('plan.allBought')}</strong> {t('plan.allBoughtDesc')}
          </div>
          <Button size="sm" onClick={() => generateMutation.mutate()}>
            <IconSpark size={16} /> {t('plan.generateNext')}
          </Button>
        </Panel>
      ) : (
        <Panel className="p-5 flex gap-4 items-center">
          <div className="text-accent">
            <IconBolt size={20} />
          </div>
          <div className="flex-1 text-sm">
            {t('plan.basedOnItems', { count: activePlan.items.length })}
          </div>
          <Button variant="ghost" size="sm" onClick={askAssistant}>
            {t('plan.askAssistant')}
          </Button>
        </Panel>
      )}
    </>
  )
}
