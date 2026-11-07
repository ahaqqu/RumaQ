import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { i18n } from '../i18n/index.js'
import { UsageMeter, SkeletonRows, Setting } from '../components/ui.jsx'
import { AiSettingsSection } from '../components/AiSettingsSection.jsx'
import { usePersona } from '../context/PersonaContext.jsx'
import { personaText } from '../lib/persona.js'
import {
  IconCheck,
  IconTrash,
  IconPin,
  IconBolt,
  IconPlus,
  IconLogout,
  IconUserRound,
} from '../components/icons.jsx'
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
import { useMe, useLogout } from '../lib/queries/me.js'
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

function ToggleGroup({ value, options, onChange, ariaLabel }) {
  return (
    <div
      className="flex gap-1 bg-surface-inset rounded-pill p-1 max-w-full"
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
        className="flex-1 min-w-0"
      />
      <Button
        size="sm"
        variant="secondary"
        onClick={onSubmit}
        disabled={disabled}
        className="shrink-0"
      >
        {action}
      </Button>
    </div>
  )
}

export function Settings({ motion, setMotion }) {
  const { t } = useTranslation()
  const [newLoc, setNewLoc] = useState('')
  const [newStore, setNewStore] = useState('')
  const { persona, setPersona } = usePersona()
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
  const { data: me } = useMe()
  const logout = useLogout()
  const user = me?.user

  const locs = locsData?.locations ?? []
  const stores = storesData?.stores ?? []

  useEffect(() => {
    const handler = (lng) => setCurrentLang(lng)
    i18n.on('languageChanged', handler)
    return () => i18n.off('languageChanged', handler)
  }, [])

  useEffect(() => {
    if (!settingsData) return
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

      // P3 removed the browser-visible provider config this call used to read
      // (`ai_provider` / `ai_base_url` / `ai_model` are gone with the columns),
      // so the persona is SAVED but the AI rewrite is not attempted from here:
      // `regenerateCopy` moves behind the door in P5 (#523 P5). Keeping a call
      // with no provider would send a stale browser key to a guessed vendor.
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

      <AiSettingsSection isOnline={isOnline} />

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
              <Setting title={t('settings.iAm')} desc={t('settings.personalizationDesc')} stack>
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

              <Setting desc={<span className="text-xs">{t('settings.personaInfo')}</span>} />

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
              <Setting title={t('settings.addLocation')} desc={t('settings.addLocationHint')} stack>
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
              <Setting title={t('settings.addStore')} desc={t('settings.addStoreHint')} stack>
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
              <Setting title={t('settings.motion')} desc={t('settings.motionDesc')} stack>
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

              <Setting title={t('settings.language')} desc={t('settings.languageDesc')} stack>
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

      <section className="mt-8">
        <div className="flex items-baseline justify-between gap-4 mb-4">
          <h2 className="text-base">{t('settings.account')}</h2>
        </div>
        <Panel>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl grid place-items-center bg-surface-inset text-text shrink-0">
              <IconUserRound size={20} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold leading-[145%] text-text truncate">
                {user?.name || user?.email || '—'}
              </div>
              {user?.name && user?.email && (
                <div className="text-xs leading-[145%] text-text-muted truncate">{user.email}</div>
              )}
            </div>
            <button
              type="button"
              className="flex items-center gap-2 text-sm font-medium text-danger hover:opacity-80 transition-opacity shrink-0"
              onClick={() => logout.mutate()}
            >
              <IconLogout size={16} /> {t('nav.logout')}
            </button>
          </div>
        </Panel>
      </section>
    </>
  )
}
