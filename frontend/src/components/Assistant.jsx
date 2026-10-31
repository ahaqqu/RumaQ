import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  IconSpark,
  IconClose,
  IconPlan,
  IconShop,
  IconLeaf,
  IconBolt,
  IconCheck,
  IconKey,
  IconReceipt,
} from './icons.jsx'
import { cn } from '../lib/cn.js'
import { usageMeterModel } from '../lib/usage.js'
import { usePersona } from '../context/PersonaContext.jsx'
import { useApp } from '../context/AppContext.jsx'
import { personaText } from '../lib/persona.js'
import { useUsage, useSendChatMessage, useSettings } from '../lib/queries/index.js'
import { Button } from './Button.jsx'
import { EmptyState } from './EmptyState.jsx'

const QUICK = [
  {
    id: 'plan',
    key: 'planThisWeek',
    descKey: 'planThisWeekDesc',
    Icon: IconPlan,
    prompt: "Create this week's shopping plan from items running low and my purchase history.",
  },
  {
    id: 'store',
    key: 'cheapestStore',
    descKey: 'cheapestStoreDesc',
    Icon: IconShop,
    prompt: 'Recommend the cheapest store for my usual items, based on price history.',
  },
  {
    id: 'useup',
    key: 'useUpExpiring',
    descKey: 'useUpExpiringDesc',
    Icon: IconLeaf,
    prompt: 'Suggest recipes to use up items that are expiring soon.',
  },
]

function classifyError(err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (/not configured|api key/i.test(msg)) return { kind: 'missing', message: msg }
  return { kind: 'other', message: msg }
}

export function Assistant({ open, onOpen, onClose, aiKey, onNavigate }) {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [reply, setReply] = useState(null)
  const { persona } = usePersona()
  const { setAssistantProposal, assistantSeed, setAssistantSeed } = useApp()
  const { data: usage } = useUsage()
  const { data: settings } = useSettings()
  const chat = useSendChatMessage()

  const hasBackendKey = settings?.has_ai_key === true
  // A server-provided key also counts as connected: the backend serves chat
  // with RumaQ's shared key when the user has none of their own.
  const isConnected = Boolean(aiKey) || hasBackendKey || settings?.server_ai_available === true

  // Shared metering model; null while the usage query loads — the status dot
  // still shows (connected is known), just without a usage count. No limit
  // is ever fabricated: usage is recorded but never capped (#353).
  const meter = usageMeterModel(usage)

  const send = async (text) => {
    if (!text.trim() || chat.isPending) return
    setReply(null)
    try {
      const result = await chat.mutateAsync({
        message: text.trim(),
        history: [],
      })
      setReply(result?.reply || '')
    } catch (err) {
      setReply({ error: classifyError(err) })
    }
  }

  const trigger = (q) => {
    if (!isConnected) return
    send(q.prompt)
  }

  // One-shot seeded prompt (e.g. the Home recipe card): send it when the
  // panel opens, then clear it so it never re-fires.
  useEffect(() => {
    if (open && assistantSeed) {
      const text = assistantSeed
      setAssistantSeed(null)
      if (isConnected) send(text)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, assistantSeed])

  const accept = () => {
    onClose()
    if (typeof reply === 'string' && reply.trim()) {
      setAssistantProposal(reply.slice(0, 4000))
    }
    setReply(null)
    onNavigate?.('plan')
  }

  const errorState = reply && typeof reply === 'object' && reply.error ? reply.error : null

  return (
    <>
      {/* Desktop-only floating trigger: on mobile the assistant lives in the
          bottom bar (AppShell), next to the Post photo slot. */}
      <button
        className={cn(
          'hidden lg:inline-flex fixed right-6 bottom-6 z-40 h-[46px] w-[46px] rounded-pill bg-surface-raised text-accent border border-accent shadow-lg',
          'items-center justify-center transition-all duration-150',
          'hover:bg-accent-soft hover:-translate-y-px active:scale-[0.97]'
        )}
        onClick={() => (open ? onClose() : onOpen())}
        // Icon-only: the accessible name comes from aria-label so voice-control
        // users can still reference the button as "Ask RumaQ".
        aria-label={t('assistant.fabLabel')}
        aria-expanded={open}
      >
        <IconSpark size={22} />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-50 bg-text/32 backdrop-blur-sm animate-[fade_0.2s_ease]"
            onClick={onClose}
          />
          <section
            className={cn(
              'fixed z-[51] right-6 bottom-6 w-[min(420px,calc(100vw-32px))] max-h-[min(680px,calc(100dvh-64px))]',
              'bg-surface-raised border border-border rounded-xl shadow-lg flex flex-col overflow-hidden',
              'origin-bottom-right animate-[pop_0.22s_cubic-bezier(0.2,0.8,0.2,1)]',
              'max-sm:right-3 max-sm:left-3 max-sm:bottom-[calc(62px+env(safe-area-inset-bottom))] max-sm:w-auto'
            )}
            role="dialog"
            aria-label={t('assistant.dialogAriaLabel')}
          >
            <header className="flex items-center gap-3 px-5 py-4 border-b border-border">
              <div className="w-9 h-9 rounded-md bg-gradient-to-br from-accent to-accent-hover grid place-items-center text-on-accent">
                <IconSpark size={18} />
              </div>
              <div>
                {/* Status text dropped (visual-only); the dot carries the same
                    state via color plus an aria-label for screen readers. */}
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-base">{t('assistant.title')}</span>
                  {isConnected && (
                    <span
                      role="img"
                      aria-label={
                        meter
                          ? t('assistant.ready', { used: meter.used })
                          : t('assistant.connected')
                      }
                      className="w-2 h-2 rounded-full shrink-0 bg-ok"
                    />
                  )}
                </div>
              </div>
              <button
                className="ml-auto w-9 h-9 rounded-md grid place-items-center text-text-muted hover:bg-surface-sunken hover:text-text transition-colors"
                onClick={onClose}
                aria-label={t('assistant.closeAriaLabel')}
              >
                <IconClose size={18} />
              </button>
            </header>

            {!isConnected ? (
              <div className="p-5 text-center text-text-muted text-sm">
                <EmptyState
                  icon={IconKey}
                  title={t('assistant.connectKeyFirst')}
                  desc={t('assistant.bringYourOwnKey')}
                  action={
                    <Button
                      className="mt-5"
                      block
                      onClick={() => {
                        onClose()
                        onNavigate('settings')
                      }}
                    >
                      <IconKey size={18} /> {t('assistant.addApiKey')}
                    </Button>
                  }
                />
              </div>
            ) : (
              <div className="px-5 py-5 overflow-y-auto flex flex-col gap-4">
                <p className="text-base leading-normal">
                  {personaText('assistantGreeting', persona, t)}{' '}
                  {personaText('assistantQuestion', persona, t)}
                </p>

                <div className="flex flex-col gap-2">
                  {/* The capture action lives in the assistant menu (it left
                      the bottom bar): navigates to the receipt flow. */}
                  <button
                    className={cn(
                      'flex items-center gap-3 px-4 py-3 rounded-md bg-accent text-on-accent text-left text-sm font-semibold',
                      'hover:bg-accent-hover transition-colors'
                    )}
                    onClick={() => {
                      onClose()
                      onNavigate?.('add')
                    }}
                  >
                    <IconReceipt size={18} className="shrink-0" />
                    <span>
                      <div>{t('nav.postPhoto')}</div>
                      <div className="text-[11px] font-medium opacity-80">
                        {t('assistant.postPhotoDesc')}
                      </div>
                    </span>
                  </button>
                  {QUICK.map(({ id, key, descKey, Icon, prompt }) => (
                    <button
                      key={id}
                      className={cn(
                        'flex items-center gap-3 px-4 py-3 rounded-md border border-border bg-surface',
                        'text-left text-sm font-medium text-text transition-colors',
                        'hover:bg-accent-soft hover:border-accent-soft-border'
                      )}
                      onClick={() => trigger({ prompt })}
                      disabled={chat.isPending}
                    >
                      <Icon size={18} className="text-accent shrink-0" />
                      <span>
                        <div>{t(`assistant.${key}`)}</div>
                        <div className="text-text-muted text-xs">{t(`assistant.${descKey}`)}</div>
                      </span>
                    </button>
                  ))}
                </div>

                {chat.isPending && (
                  <div className="text-base leading-normal flex items-center gap-3">
                    <IconBolt size={16} className="text-accent animate-spin" />
                    {t('assistant.analyzing')}
                  </div>
                )}

                {errorState && (
                  <div
                    className={cn(
                      'text-base leading-normal text-sm',
                      errorState.kind === 'other' ? 'text-danger' : 'text-text-muted'
                    )}
                  >
                    {errorState.kind === 'missing'
                      ? t('assistant.keyMissing')
                      : t('assistant.error', { message: errorState.message })}
                    {errorState.kind === 'missing' && (
                      <div className="mt-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            onClose()
                            onNavigate('settings')
                          }}
                        >
                          {t('assistant.addApiKey')}
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {reply && typeof reply === 'string' && (
                  <div className="bg-accent-soft border border-accent-soft-border rounded-md p-4">
                    <p className="whitespace-pre-wrap">{reply}</p>
                    <div className="flex gap-2 mt-4">
                      <Button size="sm" className="flex-1" onClick={accept}>
                        <IconCheck size={16} /> {t('assistant.applyToPlan')}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setReply(null)}>
                        {t('assistant.change')}
                      </Button>
                    </div>
                  </div>
                )}

                <form
                  className="mt-1 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    send(input)
                    setInput('')
                  }}
                >
                  <input
                    type="text"
                    placeholder={t('assistant.inputPlaceholder')}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    aria-label={t('assistant.inputPlaceholder')}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={chat.isPending || !input.trim()}
                    aria-label={t('assistant.sendAriaLabel')}
                  >
                    {t('assistant.send')}
                  </Button>
                </form>
              </div>
            )}
          </section>
        </>
      )}
    </>
  )
}
