import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { i18n } from '../i18n/index.js'
import { UsageMeter, SkeletonRows } from '../components/ui.jsx'
import { usePersona } from '../context/PersonaContext.jsx'
import { personaText, deriveHue } from '../lib/persona.js'
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
  useAiProviders,
  useAiPresets,
  useAiCapabilities,
  useCreateAiProvider,
  useUpdateAiProvider,
  useDeleteAiProvider,
  useTestAiProvider,
  useAssignAiCapability,
  useClearAiCapability,
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

function Setting({ title, desc, children, className, highlight, stack = false }) {
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

// ─── AI gateway settings (ahaqqu/RumaQ#523 P3, plan §4.4) ───────────────────
//
// Two sections, both household-scoped: the providers the household owns, and
// the three capability assignments that decide which provider serves what.
//
// The rules this component exists to render honestly:
//   - NO seeded or preselected provider, and no "use the server default" option
//     anywhere (D7/D8). A household with nothing configured sees the empty
//     state, and the capability controls do not exist until a provider does.
//   - A MEMBER sees the same data read-only: every manage affordance is gated on
//     `can_manage` from the API, never on a client-side guess about the role.
//   - The key is write-only: the form takes it, the API never returns it, and
//     `has_key` is the only signal the list can show.
//   - A blank model field INHERITS the provider's default model; both blank is
//     the normal "not configured" state, not an error (plan §4.5).

const AI_CAPABILITY_ROWS = [
  { id: 'decision', labelKey: 'settings.ai.decision', descKey: 'settings.ai.decisionDesc' },
  { id: 'reasoning', labelKey: 'settings.ai.reasoning', descKey: 'settings.ai.reasoningDesc' },
  { id: 'vision', labelKey: 'settings.ai.vision', descKey: 'settings.ai.visionDesc' },
]

// The wire kinds (D2). Not vendors: the vendor a row came from is its `preset`,
// which never has a default either.
const AI_KINDS = ['openai-compatible', 'anthropic', 'gemini', 'questions']

const MAX_AI_PROVIDERS = 10

function emptyProviderForm() {
  return { label: '', kind: '', preset: '', baseUrl: '', defaultModel: '', apiKey: '' }
}

function emptyCapabilityDrafts(assignments) {
  return Object.fromEntries(
    AI_CAPABILITY_ROWS.map((row) => {
      const assignment = assignments?.[row.id]
      return [
        row.id,
        {
          providerId: assignment?.provider_id ?? '',
          // Deliberately blank: the field means "inherit the provider default",
          // and the resolved model is shown beside it, not smuggled into a value
          // that a save would then pin.
          model: '',
          thinking: assignment?.thinking_level ?? '',
        },
      ]
    })
  )
}

function AiSettingsSection({ isOnline }) {
  const { t } = useTranslation()
  const { data: providerData, isLoading: providersLoading } = useAiProviders()
  const { data: presetData } = useAiPresets()
  const { data: capabilityData, isLoading: capabilitiesLoading } = useAiCapabilities()
  const createProvider = useCreateAiProvider()
  const updateProvider = useUpdateAiProvider()
  const deleteProvider = useDeleteAiProvider()
  const testProvider = useTestAiProvider()
  const assignCapability = useAssignAiCapability()
  const clearCapability = useClearAiCapability()

  const providers = providerData?.providers ?? []
  const canManage = providerData?.can_manage === true
  const managedBy = providerData?.managed_by ?? null
  const presets = presetData?.presets ?? []
  const atCap = providers.length >= MAX_AI_PROVIDERS

  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(emptyProviderForm)
  const [formError, setFormError] = useState(null)
  const [testResults, setTestResults] = useState({})
  const [capabilityDrafts, setCapabilityDrafts] = useState(() => emptyCapabilityDrafts())
  const [capabilityError, setCapabilityError] = useState(null)
  const [pendingCapability, setPendingCapability] = useState(null)

  // Hydrate the three rows from the server after every read. The capability
  // block is invalidated by each write, so this also resets the drafts to the
  // saved state once a save settles.
  useEffect(() => {
    if (!capabilityData) return
    setCapabilityDrafts(emptyCapabilityDrafts(capabilityData.capabilities))
  }, [capabilityData])

  const openAdd = () => {
    setEditingId(null)
    setForm(emptyProviderForm())
    setFormError(null)
    setFormOpen(true)
  }

  const openEdit = (provider) => {
    setEditingId(provider.id)
    setForm({
      label: provider.label,
      kind: provider.kind,
      preset: provider.preset ?? '',
      baseUrl: provider.base_url ?? '',
      defaultModel: provider.default_model ?? '',
      apiKey: '',
    })
    setFormError(null)
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    setEditingId(null)
    setFormError(null)
  }

  // Choosing a preset fills the wire and the canonical endpoint it implies; the
  // picker itself starts empty, so nothing is preselected for the user.
  const choosePreset = (presetId) => {
    const preset = presets.find((entry) => entry.id === presetId)
    setForm((current) => ({
      ...current,
      preset: presetId,
      kind: preset ? preset.kind : current.kind,
      baseUrl: preset ? (preset.base_url ?? '') : current.baseUrl,
    }))
  }

  const submitProvider = async () => {
    const label = form.label.trim()
    const apiKey = form.apiKey.trim()
    if (!label || !form.kind) {
      setFormError(t('settings.ai.formIncomplete'))
      return
    }
    if (!editingId && !apiKey) {
      setFormError(t('settings.ai.keyRequired'))
      return
    }
    // The PATCH schema takes no `preset` (a preset is the row's provenance, and
    // its endpoint is already materialised), so an edit never sends one.
    const payload = { label, kind: form.kind }
    if (editingId) {
      // '' CLEARS the column in the PATCH contract, so an edit always sends both
      // fields — otherwise emptying one of them would silently keep the old value.
      payload.base_url = form.baseUrl.trim()
      payload.default_model = form.defaultModel.trim()
    } else {
      if (form.preset) payload.preset = form.preset
      if (form.baseUrl.trim()) payload.base_url = form.baseUrl.trim()
      if (form.defaultModel.trim()) payload.default_model = form.defaultModel.trim()
    }
    if (apiKey) payload.api_key = apiKey
    setFormError(null)
    try {
      if (editingId) {
        await updateProvider.mutateAsync({ id: editingId, payload })
      } else {
        await createProvider.mutateAsync(payload)
      }
      closeForm()
    } catch (error) {
      setFormError(error?.message ?? t('settings.ai.saveFailed'))
    }
  }

  const runTest = async (provider) => {
    setTestResults((current) => ({ ...current, [provider.id]: null }))
    try {
      const result = await testProvider.mutateAsync(provider.id)
      setTestResults((current) => ({ ...current, [provider.id]: result }))
    } catch (error) {
      setTestResults((current) => ({
        ...current,
        [provider.id]: { ok: false, code: error?.message },
      }))
    }
  }

  const askDelete = async (provider) => {
    const cleared = AI_CAPABILITY_ROWS.filter(
      (row) => capabilityData?.capabilities?.[row.id]?.provider_id === provider.id
    ).map((row) => t(row.labelKey))
    const message = cleared.length
      ? t('settings.ai.deleteConfirm', { label: provider.label, capabilities: cleared.join(', ') })
      : t('settings.ai.deleteConfirmPlain', { label: provider.label })
    if (!window.confirm(message)) return
    try {
      await deleteProvider.mutateAsync(provider.id)
    } catch (error) {
      setFormError(error?.message ?? t('settings.ai.deleteFailed'))
    }
  }

  const saveCapability = async (capability) => {
    const draft = capabilityDrafts[capability]
    setCapabilityError(null)
    setPendingCapability(capability)
    try {
      if (!draft.providerId) {
        // "Choose a provider" + Save clears the assignment: the capability
        // becomes not configured (DELETE /api/ai/capabilities/:capability).
        await clearCapability.mutateAsync(capability)
      } else {
        const payload = { provider_id: draft.providerId, model: draft.model.trim() }
        // Vision has no reasoning knob; sending one would be a 400 by design.
        if (capability !== 'vision') payload.thinking_level = draft.thinking
        await assignCapability.mutateAsync({ capability, payload })
      }
    } catch (error) {
      setCapabilityError(error?.message ?? t('settings.ai.saveFailed'))
    } finally {
      setPendingCapability(null)
    }
  }

  const capabilityStatus = (capability) => {
    const assignment = capabilityData?.capabilities?.[capability]
    if (!assignment || assignment.source === 'none' || !assignment.provider_id) {
      return t('settings.ai.notConfigured')
    }
    if (assignment.model) {
      return t('settings.ai.usingWithModel', {
        label: assignment.provider_label,
        model: assignment.model,
      })
    }
    return t('settings.ai.using', { label: assignment.provider_label })
  }

  return (
    <>
      <section className="mt-8">
        <div className="flex items-baseline justify-between gap-4 mb-4">
          <h2 className="text-base">{t('settings.ai.providersTitle')}</h2>
        </div>
        <Panel>
          {providersLoading ? (
            <SkeletonRows n={2} />
          ) : (
            <div className="flex flex-col">
              <Setting
                desc={
                  providers.length > 0
                    ? `${t('settings.ai.providersLead')} ${t('settings.ai.providersLeadHas')}`
                    : t('settings.ai.providersLead')
                }
              />
              {!canManage && (
                <Setting
                  desc={
                    managedBy
                      ? t('settings.ai.managedBy', { name: managedBy })
                      : t('settings.ai.managedByUnknown')
                  }
                />
              )}

              {providers.map((provider) => (
                <Setting
                  key={provider.id}
                  stack={canManage}
                  title={
                    <>
                      {provider.label}
                      <span className="text-text-muted font-normal"> · {provider.kind}</span>
                    </>
                  }
                  desc={
                    <span className="text-xs">
                      {provider.base_url ?? provider.preset ?? t('settings.ai.presetEndpoint')}
                      {provider.default_model ? ` · ${provider.default_model}` : ''}
                      {' · '}
                      {provider.has_key ? t('settings.ai.keySaved') : t('settings.ai.noKey')}
                    </span>
                  }
                >
                  {canManage && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => runTest(provider)}
                        disabled={!isOnline || testProvider.isPending}
                        data-testid={`ai-test-${provider.id}`}
                      >
                        {t('settings.ai.test')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => openEdit(provider)}
                        disabled={!isOnline}
                      >
                        {t('settings.ai.edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => askDelete(provider)}
                        disabled={!isOnline || deleteProvider.isPending}
                        aria-label={t('settings.ai.deleteAria', { label: provider.label })}
                        data-testid={`ai-delete-${provider.id}`}
                      >
                        <IconTrash size={15} />
                      </Button>
                    </div>
                  )}
                </Setting>
              ))}

              {providers.map((provider) => {
                const result = testResults[provider.id]
                if (!result) return null
                return (
                  <Setting
                    key={`test-${provider.id}`}
                    highlight={result.ok ? 'ok' : 'warn'}
                    desc={
                      result.ok
                        ? t('settings.ai.testOk')
                        : t('settings.ai.testFailed', { code: result.code ?? 'provider_error' })
                    }
                  />
                )
              })}

              {providers.length === 0 && (
                <Setting
                  title={t('settings.ai.emptyTitle')}
                  desc={canManage ? t('settings.ai.emptyOwner') : t('settings.ai.emptyMember')}
                />
              )}

              {canManage && atCap && (
                <Setting desc={t('settings.ai.maxReached', { max: MAX_AI_PROVIDERS })} />
              )}

              {canManage && !formOpen && !atCap && (
                <Setting>
                  <Button size="sm" onClick={openAdd} data-testid="ai-add-provider">
                    <IconPlus size={15} />
                    {providers.length === 0
                      ? t('settings.ai.addFirst')
                      : t('settings.ai.addProvider')}
                  </Button>
                </Setting>
              )}

              {canManage && formOpen && (
                <Setting
                  title={editingId ? t('settings.ai.editTitle') : t('settings.ai.addTitle')}
                  stack
                >
                  <div className="flex flex-col gap-2 w-full">
                    <input
                      value={form.label}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, label: event.target.value }))
                      }
                      placeholder={t('settings.ai.labelPlaceholder')}
                      aria-label={t('settings.ai.label')}
                      data-testid="ai-provider-label"
                    />
                    <div className="flex flex-col sm:flex-row gap-2">
                      {!editingId && (
                        <select
                          value={form.preset}
                          onChange={(event) => choosePreset(event.target.value)}
                          aria-label={t('settings.ai.preset')}
                          data-testid="ai-provider-preset"
                        >
                          <option value="">{t('settings.ai.presetPlaceholder')}</option>
                          {presets.map((preset) => (
                            <option key={preset.id} value={preset.id}>
                              {preset.label}
                            </option>
                          ))}
                        </select>
                      )}
                      <select
                        value={form.kind}
                        onChange={(event) =>
                          setForm((current) => ({ ...current, kind: event.target.value }))
                        }
                        aria-label={t('settings.ai.kind')}
                        data-testid="ai-provider-kind"
                      >
                        <option value="">{t('settings.ai.kindPlaceholder')}</option>
                        {AI_KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {kind}
                          </option>
                        ))}
                      </select>
                    </div>
                    <input
                      value={form.baseUrl}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, baseUrl: event.target.value }))
                      }
                      placeholder={t('settings.ai.baseUrlPlaceholder')}
                      aria-label={t('settings.ai.baseUrl')}
                      data-testid="ai-provider-base-url"
                    />
                    <input
                      value={form.defaultModel}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, defaultModel: event.target.value }))
                      }
                      placeholder={t('settings.ai.defaultModelPlaceholder')}
                      aria-label={t('settings.ai.defaultModel')}
                      data-testid="ai-provider-default-model"
                    />
                    <input
                      type="password"
                      value={form.apiKey}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, apiKey: event.target.value }))
                      }
                      placeholder={
                        editingId ? t('settings.ai.apiKeyKeep') : t('settings.ai.apiKeyPlaceholder')
                      }
                      aria-label={t('settings.ai.apiKey')}
                      data-testid="ai-provider-key"
                    />
                    {formError && (
                      <div className="text-sm text-danger" role="alert">
                        {formError}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={submitProvider}
                        disabled={!isOnline || createProvider.isPending || updateProvider.isPending}
                        data-testid="ai-provider-save"
                      >
                        {t('settings.ai.saveProvider')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={closeForm}>
                        {t('settings.ai.cancel')}
                      </Button>
                    </div>
                  </div>
                </Setting>
              )}
            </div>
          )}
        </Panel>
      </section>

      <section className="mt-8">
        <div className="flex items-baseline justify-between gap-4 mb-4">
          <h2 className="text-base">{t('settings.ai.capabilitiesTitle')}</h2>
        </div>
        <Panel>
          {providersLoading || capabilitiesLoading ? (
            <SkeletonRows n={3} />
          ) : (
            <div className="flex flex-col">
              <Setting desc={t('settings.ai.capabilitiesLead')} />
              {providers.length === 0 ? (
                // No provider yet: the three rows are status lines, never empty
                // selectors (plan §4.4 state A).
                <>
                  <Setting desc={t('settings.ai.capabilitiesEmpty')} />
                  {AI_CAPABILITY_ROWS.map((row) => (
                    <Setting
                      key={row.id}
                      title={t(row.labelKey)}
                      desc={t('settings.ai.notConfigured')}
                    />
                  ))}
                </>
              ) : (
                AI_CAPABILITY_ROWS.map((row) => {
                  const draft = capabilityDrafts[row.id] ?? {
                    providerId: '',
                    model: '',
                    thinking: '',
                  }
                  const assignment = capabilityData?.capabilities?.[row.id]
                  return (
                    <Setting
                      key={row.id}
                      stack={canManage}
                      title={t(row.labelKey)}
                      desc={t(row.descKey)}
                    >
                      {canManage ? (
                        <div className="flex flex-col gap-2 w-full sm:max-w-[420px]">
                          <select
                            value={draft.providerId}
                            onChange={(event) =>
                              setCapabilityDrafts((current) => ({
                                ...current,
                                [row.id]: { ...draft, providerId: event.target.value },
                              }))
                            }
                            aria-label={t('settings.ai.providerFor', {
                              capability: t(row.labelKey),
                            })}
                            data-testid={`ai-capability-provider-${row.id}`}
                          >
                            <option value="">{t('settings.ai.chooseProvider')}</option>
                            {providers.map((provider) => (
                              <option key={provider.id} value={provider.id}>
                                {provider.label}
                              </option>
                            ))}
                          </select>
                          <input
                            value={draft.model}
                            onChange={(event) =>
                              setCapabilityDrafts((current) => ({
                                ...current,
                                [row.id]: { ...draft, model: event.target.value },
                              }))
                            }
                            placeholder={t('settings.ai.modelPlaceholder')}
                            aria-label={t('settings.ai.modelFor', { capability: t(row.labelKey) })}
                            data-testid={`ai-capability-model-${row.id}`}
                          />
                          {row.id !== 'vision' && (
                            <select
                              value={draft.thinking}
                              onChange={(event) =>
                                setCapabilityDrafts((current) => ({
                                  ...current,
                                  [row.id]: { ...draft, thinking: event.target.value },
                                }))
                              }
                              aria-label={t('settings.ai.thinkingFor', {
                                capability: t(row.labelKey),
                              })}
                              data-testid={`ai-capability-thinking-${row.id}`}
                            >
                              <option value="">{t('settings.ai.thinkingDefault')}</option>
                              <option value="low">{t('settings.thinkingLow')}</option>
                              <option value="medium">{t('settings.thinkingMedium')}</option>
                              <option value="high">{t('settings.thinkingHigh')}</option>
                            </select>
                          )}
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => saveCapability(row.id)}
                              disabled={!isOnline || pendingCapability === row.id}
                              data-testid={`ai-capability-save-${row.id}`}
                            >
                              {t('settings.ai.saveCapability')}
                            </Button>
                            <span
                              className="text-sm text-text-muted"
                              data-testid={`ai-capability-status-${row.id}`}
                            >
                              {capabilityStatus(row.id)}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <span
                          className="text-sm text-text-muted"
                          data-testid={`ai-capability-status-${row.id}`}
                        >
                          {capabilityStatus(row.id)}
                        </span>
                      )}
                      {canManage && assignment?.source === 'household' && assignment.model && (
                        <span className="text-xs text-text-muted">
                          {t('settings.ai.effectiveModel', { model: assignment.model })}
                        </span>
                      )}
                    </Setting>
                  )
                })
              )}
              {capabilityError && (
                <Setting
                  desc={<span className="text-danger text-sm">{capabilityError}</span>}
                  highlight="danger"
                />
              )}
            </div>
          )}
        </Panel>
      </section>
    </>
  )
}

export function Settings({ aiKey, motion, setMotion }) {
  const { t } = useTranslation()
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
