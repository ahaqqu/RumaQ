import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { i18n } from '../i18n/index.js'
import { UsageMeter, SkeletonRows } from '../components/ui.jsx'
import { usePersona } from '../context/PersonaContext.jsx'
import { personaText, deriveHue } from '../lib/persona.js'
import { IconCheck, IconTrash, IconPin, IconBolt, IconPlus } from '../components/icons.jsx'
import { cn } from '../lib/cn.js'
import {
  useSettings,
  useUpdateSettings,
  useLocations,
  useCreateLocation,
  useDeleteLocation,
  useStores,
  useCreateStore,
  useDeleteStore,
  useUsage,
} from '../lib/queries/index.js'
import { testAiKey } from '../lib/api'
import { Button } from '../components/Button.jsx'
import { Panel } from '../components/Panel.jsx'
import { useOnlineStatus } from '../lib/useOnlineStatus.js'

const MOTION_OPTS = [
  { id: 'none', key: 'settings.motionOpts.none' },
  { id: 'reduced', key: 'settings.motionOpts.reduced' },
  { id: 'standard', key: 'settings.motionOpts.standard' },
]

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'id', label: 'Bahasa Indonesia' },
]

function Setting({ title, desc, children, className, highlight }) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 px-5 py-4 border-b border-border last:border-b-0',
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

function ToggleGroup({ value, options, onChange, ariaLabel }) {
  return (
    <div
      className="flex gap-1 bg-surface-inset rounded-pill p-1"
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((opt) => (
        <button
          key={opt.id}
          aria-pressed={value === opt.id}
          onClick={() => onChange(opt.id)}
          className={cn(
            'px-4 py-2 rounded-pill text-sm font-medium text-text-muted transition-all',
            value === opt.id && 'bg-surface-raised text-text shadow-sm'
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function InlineInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  ariaLabel,
  action,
  disabled,
  type = 'text',
}) {
  return (
    <div className="flex gap-2 max-w-[360px] w-full">
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
      />
      <Button size="sm" variant="secondary" onClick={onSubmit} disabled={disabled}>
        {action}
      </Button>
    </div>
  )
}

export function Settings({ aiKey, setAiKey, motion, setMotion }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(aiKey || '')
  const [provider, setProvider] = useState('gemini')
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testOk, setTestOk] = useState(null)
  const [newLoc, setNewLoc] = useState('')
  const [newStore, setNewStore] = useState('')
  const { persona, setPersona, regenerateCopy } = usePersona()
  const [personaDraft, setPersonaDraft] = useState({
    userRole: persona.userRole,
    aiRole: persona.aiRole,
    enabled: persona.enabled,
  })
  const [personaApplied, setPersonaApplied] = useState(false)
  const [personaLoading, setPersonaLoading] = useState(false)
  const [personaError, setPersonaError] = useState(null)
  const [currentLang, setCurrentLang] = useState(i18n.language)
  const isOnline = useOnlineStatus()

  const { data: settingsData, isLoading: settingsLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const { data: locsData, isLoading: locsLoading } = useLocations()
  const createLocation = useCreateLocation()
  const deleteLocation = useDeleteLocation()
  const { data: storesData, isLoading: storesLoading } = useStores()
  const createStore = useCreateStore()
  const deleteStore = useDeleteStore()
  const { data: usageData } = useUsage()

  const locs = locsData?.locations ?? []
  const stores = storesData?.stores ?? []

  useEffect(() => {
    const handler = (lng) => setCurrentLang(lng)
    i18n.on('languageChanged', handler)
    return () => i18n.off('languageChanged', handler)
  }, [])

  useEffect(() => {
    if (!settingsData) return
    if (settingsData.ai_provider) {
      setProvider(settingsData.ai_provider)
    }
    if (settingsData.ai_base_url) {
      setCustomBaseUrl(settingsData.ai_base_url)
    }
    if (settingsData.ai_model) {
      setCustomModel(settingsData.ai_model)
    }
    if (settingsData.has_ai_key) {
      setDraft('')
    }
    if (settingsData.motion_preference) {
      setMotion(settingsData.motion_preference)
    }
    if (settingsData.language) {
      i18n.changeLanguage(settingsData.language)
    }
    setPersonaDraft((prev) => ({
      userRole: settingsData.persona_user_role ?? prev.userRole,
      aiRole: settingsData.persona_ai_role ?? prev.aiRole,
      enabled: settingsData.persona_enabled ?? prev.enabled,
    }))
  }, [settingsData, setMotion])

  const saveSettings = useCallback(
    async (payload) => {
      try {
        await updateSettings.mutateAsync(payload)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } catch (err) {
        console.error('Failed to save settings:', err)
      }
    },
    [updateSettings]
  )

  const applyPersona = async () => {
    setPersonaError(null)
    setPersonaLoading(true)
    try {
      setPersona({ ...personaDraft, generatedCopy: null })

      await saveSettings({
        persona_user_role: personaDraft.userRole || null,
        persona_ai_role: personaDraft.aiRole || null,
        persona_enabled: personaDraft.enabled,
      })

      if (personaDraft.enabled && personaDraft.userRole && personaDraft.aiRole && aiKey) {
        await regenerateCopy(
          aiKey,
          provider,
          {
            ...personaDraft,
            hue: deriveHue(personaDraft.userRole, personaDraft.aiRole),
          },
          { baseUrl: customBaseUrl, model: customModel }
        )
      }

      setPersonaApplied(true)
      setTimeout(() => setPersonaApplied(false), 2000)
    } catch (err) {
      setPersonaError(
        err.message || 'Failed to generate persona text. Try again or use fallback without AI.'
      )
    } finally {
      setPersonaLoading(false)
    }
  }

  const save = async () => {
    // Always persist both fields so switching away from Custom resets them —
    // stale values would otherwise leak into later provider calls.
    const payload = {
      ai_key: draft.trim(),
      ai_provider: provider,
      ai_base_url: customBaseUrl.trim(),
      ai_model: customModel.trim(),
    }
    setAiKey(draft.trim() || null)
    setTestOk(null)
    await saveSettings(payload)
  }

  const test = async () => {
    setTesting(true)
    setTestOk(null)
    try {
      await testAiKey(
        provider,
        draft || undefined,
        provider === 'custom' ? customBaseUrl : undefined
      )
      setTestOk(true)
    } catch {
      setTestOk(false)
    } finally {
      setTesting(false)
    }
  }

  const addLoc = async () => {
    const v = newLoc.trim()
    if (!v || !isOnline) return
    try {
      await createLocation.mutateAsync(v)
      setNewLoc('')
    } catch (err) {
      console.error('Failed to create location:', err)
    }
  }

  const removeLoc = async (id) => {
    if (!isOnline) return
    try {
      await deleteLocation.mutateAsync(id)
    } catch (err) {
      console.error('Failed to delete location:', err)
    }
  }

  const addStore = async () => {
    const v = newStore.trim()
    if (!v || !isOnline) return
    try {
      await createStore.mutateAsync(v)
      setNewStore('')
    } catch (err) {
      console.error('Failed to create store:', err)
    }
  }

  const removeStore = async (id) => {
    if (!isOnline) return
    try {
      await deleteStore.mutateAsync(id)
    } catch (err) {
      console.error('Failed to delete store:', err)
    }
  }

  const changeLanguage = (lng) => {
    i18n.changeLanguage(lng)
    saveSettings({ language: lng })
  }

  return (
    <>
      <div className="mb-6">
        <p className="text-md text-text-muted leading-snug max-w-[62ch]">
          {personaText('settingsLead', persona, t)}
        </p>
      </div>

      <section className="mt-8">
        <div className="flex items-baseline justify-between gap-4 mb-4">
          <h2 className="text-base">{t('settings.aiApiKey')}</h2>
        </div>
        <Panel>
          {settingsLoading ? (
            <SkeletonRows n={3} />
          ) : (
            <div className="flex flex-col">
              <Setting title={t('settings.provider')} desc={t('settings.providerDesc')}>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="w-auto"
                  aria-label={t('settings.aria.provider')}
                >
                  <option value="opencode">OpenCode</option>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Gemini</option>
                  <option value="ollama">Ollama Cloud</option>
                  <option value="custom">{t('settings.customProvider')}</option>
                </select>
              </Setting>

              {provider === 'custom' && (
                <>
                  <Setting
                    title={t('settings.customBaseUrl')}
                    desc={t('settings.customBaseUrlDesc')}
                    className="flex-wrap"
                  >
                    <InlineInput
                      value={customBaseUrl}
                      onChange={setCustomBaseUrl}
                      onSubmit={save}
                      placeholder="https://api.example.com/v1"
                      ariaLabel={t('settings.customBaseUrl')}
                    />
                  </Setting>
                  <Setting
                    title={t('settings.customModel')}
                    desc={t('settings.customModelDesc')}
                    className="flex-wrap"
                  >
                    <InlineInput
                      value={customModel}
                      onChange={setCustomModel}
                      onSubmit={save}
                      placeholder="llama3.3:70b"
                      ariaLabel={t('settings.customModel')}
                    />
                  </Setting>
                </>
              )}

              <Setting
                title={t('settings.apiKey')}
                desc={t('settings.apiKeyDesc')}
                className="flex-wrap"
              >
                <InlineInput
                  type="password"
                  value={draft}
                  onChange={setDraft}
                  onSubmit={test}
                  placeholder={
                    settingsData?.has_ai_key
                      ? t('settings.apiKeyChangePlaceholder')
                      : t('settings.apiKeyPlaceholder')
                  }
                  ariaLabel={t('settings.apiKey')}
                  disabled={!draft || testing}
                  action={
                    testing ? (
                      <>
                        <IconBolt size={15} className="animate-spin" /> {t('settings.test')}
                      </>
                    ) : (
                      <>
                        <IconCheck size={15} /> {t('settings.test')}
                      </>
                    )
                  }
                />
              </Setting>

              {testOk === true && (
                <Setting
                  title={<span className="text-ok">{t('settings.connectionSuccess')}</span>}
                  desc={t('settings.connectionSuccessDesc')}
                  highlight="ok"
                />
              )}
              {testOk === false && (
                <Setting
                  title={
                    <span className="text-warn">
                      {t('settings.connectionFailed', 'Connection failed')}
                    </span>
                  }
                  desc={t('settings.connectionFailedDesc', 'Check your API key and try again.')}
                  highlight="warn"
                />
              )}

              <Setting
                title={t('settings.status')}
                desc={settingsData?.has_ai_key ? t('settings.active') : t('settings.inactive')}
              >
                <Button
                  size="sm"
                  onClick={save}
                  disabled={updateSettings.isPending}
                  data-testid="save-key-btn"
                >
                  {saved ? (
                    <>
                      <IconCheck size={15} /> {t('settings.saved')}
                    </>
                  ) : (
                    t('settings.saveKey')
                  )}
                </Button>
              </Setting>
            </div>
          )}
        </Panel>
      </section>

      <section className="mt-8">
        <div className="flex items-baseline justify-between gap-4 mb-4">
          <h2 className="text-lg">{t('settings.aiUsage')}</h2>
        </div>
        <Panel>
          <UsageMeter usage={usageData} />
        </Panel>
      </section>

      <section className="mt-8">
        <div className="flex items-baseline justify-between gap-4 mb-4">
          <h2 className="text-lg">{t('settings.personalization')}</h2>
        </div>
        <Panel>
          {settingsLoading ? (
            <SkeletonRows n={3} />
          ) : (
            <div className="flex flex-col">
              <Setting
                title={t('settings.iAm')}
                desc={t('settings.personalizationDesc')}
                className="flex-wrap"
              >
                <div className="flex flex-wrap gap-3 w-full">
                  <label className="flex-1 min-w-[160px]">
                    <span className="sr-only">{t('settings.aria.myRole')}</span>
                    <input
                      value={personaDraft.userRole}
                      onChange={(e) =>
                        setPersonaDraft((p) => ({
                          ...p,
                          userRole: e.target.value,
                        }))
                      }
                      placeholder={t('settings.myRolePlaceholder')}
                      aria-label={t('settings.aria.myRole')}
                    />
                  </label>
                  <label className="flex-1 min-w-[160px]">
                    <span className="sr-only">{t('settings.aria.aiRole')}</span>
                    <input
                      value={personaDraft.aiRole}
                      onChange={(e) =>
                        setPersonaDraft((p) => ({
                          ...p,
                          aiRole: e.target.value,
                        }))
                      }
                      placeholder={t('settings.aiRolePlaceholder')}
                      aria-label={t('settings.aria.aiRole')}
                    />
                  </label>
                  <Button
                    size="sm"
                    onClick={applyPersona}
                    disabled={personaLoading || updateSettings.isPending}
                  >
                    {personaLoading ? (
                      <>
                        <IconBolt size={15} className="animate-spin" /> {t('settings.loading')}
                      </>
                    ) : personaApplied ? (
                      <>
                        <IconCheck size={15} /> {t('settings.saved')}
                      </>
                    ) : (
                      t('settings.apply')
                    )}
                  </Button>
                </div>
              </Setting>

              <Setting
                title={t('settings.preview')}
                desc={
                  persona.enabled && persona.userRole && persona.aiRole
                    ? personaText('homeLead', persona, t)
                    : t('settings.previewPlaceholder')
                }
              >
                <div className="flex items-center gap-2">
                  <input
                    id="persona-toggle"
                    type="checkbox"
                    checked={personaDraft.enabled}
                    onChange={(e) =>
                      setPersonaDraft((p) => ({
                        ...p,
                        enabled: e.target.checked,
                      }))
                    }
                    className="w-auto p-0 accent-accent"
                  />
                  <label htmlFor="persona-toggle" className="text-sm text-text-muted">
                    {t('settings.enablePersona')}
                  </label>
                </div>
              </Setting>

              <Setting
                desc={
                  <span className="text-xs">
                    {aiKey ? t('settings.personaInfoWithKey') : t('settings.personaInfoNoKey')}
                  </span>
                }
              />

              {personaError && (
                <Setting
                  desc={<span className="text-danger text-sm">{personaError}</span>}
                  highlight="danger"
                />
              )}
            </div>
          )}
        </Panel>
      </section>

      <section className="mt-8">
        <div className="flex items-baseline justify-between gap-4 mb-4">
          <h2 className="text-lg">{t('settings.storageLocations')}</h2>
        </div>
        <Panel>
          {locsLoading ? (
            <SkeletonRows n={3} />
          ) : (
            <div className="flex flex-col">
              {locs.map((l) => (
                <Setting
                  key={l.id}
                  title={
                    <>
                      <IconPin size={14} className="inline align-[-2px] mr-1.5" />
                      {l.label}
                    </>
                  }
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeLoc(l.id)}
                    aria-label={t('settings.aria.deleteLocation', { name: l.label })}
                    disabled={deleteLocation.isPending || !isOnline}
                    title={!isOnline ? t('offline.disabledHint') : undefined}
                  >
                    <IconTrash size={15} />
                  </Button>
                </Setting>
              ))}
              <Setting title={t('settings.addLocation')} desc={t('settings.addLocationHint')}>
                <InlineInput
                  value={newLoc}
                  onChange={setNewLoc}
                  onSubmit={addLoc}
                  placeholder={t('settings.locationName')}
                  ariaLabel={t('settings.aria.newLocation')}
                  disabled={createLocation.isPending || !isOnline}
                  action={
                    <>
                      <IconPlus size={15} /> {t('settings.add')}
                    </>
                  }
                />
              </Setting>
            </div>
          )}
        </Panel>
      </section>

      <section className="mt-8">
        <div className="flex items-baseline justify-between gap-4 mb-4">
          <h2 className="text-lg">{t('settings.recordedStores')}</h2>
        </div>
        <Panel>
          {storesLoading ? (
            <SkeletonRows n={3} />
          ) : (
            <div className="flex flex-col">
              {stores.map((s) => (
                <Setting key={s.id} title={s.label}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeStore(s.id)}
                    aria-label={t('settings.aria.deleteStore', { name: s.label })}
                    disabled={deleteStore.isPending || !isOnline}
                    title={!isOnline ? t('offline.disabledHint') : undefined}
                  >
                    <IconTrash size={15} />
                  </Button>
                </Setting>
              ))}
              <Setting title={t('settings.addStore')} desc={t('settings.addStoreHint')}>
                <InlineInput
                  value={newStore}
                  onChange={setNewStore}
                  onSubmit={addStore}
                  placeholder={t('settings.storeName')}
                  ariaLabel={t('settings.aria.newStore')}
                  disabled={createStore.isPending || !isOnline}
                  action={
                    <>
                      <IconPlus size={15} /> {t('settings.add')}
                    </>
                  }
                />
              </Setting>
            </div>
          )}
        </Panel>
      </section>

      <section className="mt-8">
        <div className="flex items-baseline justify-between gap-4 mb-4">
          <h2 className="text-base">{t('settings.display')}</h2>
        </div>
        <Panel>
          {settingsLoading ? (
            <SkeletonRows n={3} />
          ) : (
            <div className="flex flex-col">
              <Setting title={t('settings.motion')} desc={t('settings.motionDesc')}>
                <ToggleGroup
                  value={motion}
                  options={MOTION_OPTS.map((m) => ({
                    id: m.id,
                    label: t(m.key),
                  }))}
                  onChange={(id) => {
                    setMotion(id)
                    saveSettings({ motion_preference: id })
                  }}
                  ariaLabel={t('settings.aria.motion')}
                />
              </Setting>

              <Setting title={t('settings.language')} desc={t('settings.languageDesc')}>
                <ToggleGroup
                  value={currentLang}
                  options={LANGUAGES.map((l) => ({ id: l.code, label: l.label }))}
                  onChange={changeLanguage}
                  ariaLabel={t('settings.language')}
                />
              </Setting>
            </div>
          )}
        </Panel>
      </section>
    </>
  )
}
