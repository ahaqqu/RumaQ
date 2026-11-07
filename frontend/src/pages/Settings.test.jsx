import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { Settings } from './Settings.jsx'
import { usePersona } from '../context/PersonaContext.jsx'

const mockLocations = [
  { id: 'loc-1', label: 'Kitchen', sort_order: 1 },
  { id: 'loc-2', label: 'Fridge', sort_order: 2 },
]

const mockStores = [
  { id: 'store-1', label: 'Indomaret' },
  { id: 'store-2', label: 'Alfamart' },
]

// #523 P3: the legacy `ai_*` fields, `has_ai_key` and `server_ai_available` are
// gone from the payload (the columns are dropped). The settings read now only
// carries preferences; the AI block lives behind the two dedicated reads.
const mockSettings = {
  motion_preference: 'standard',
  currency: 'idr',
  persona_user_role: null,
  persona_ai_role: null,
  persona_enabled: false,
  theme_hue: null,
  active_household_id: 'house-1',
  active_household_name: 'Test Household',
  ai_providers: [],
  ai_status: { decision: 'none', reasoning: 'none', vision: 'none' },
}

const emptyCapabilities = {
  decision: {
    provider_id: null,
    provider_label: null,
    model: null,
    thinking_level: null,
    source: 'none',
  },
  reasoning: {
    provider_id: null,
    provider_label: null,
    model: null,
    thinking_level: null,
    source: 'none',
  },
  vision: {
    provider_id: null,
    provider_label: null,
    model: null,
    thinking_level: null,
    source: 'none',
  },
}

// Mutable server-state fixtures, reset per test. The mocked hooks read them, so
// a test flips `aiProviderData.can_manage` to render the member view without
// re-mocking the module.
const aiProviderData = { can_manage: true, managed_by: null, providers: [] }
const aiCapabilityData = {
  can_manage: true,
  capabilities: { ...emptyCapabilities },
  status: { decision: 'none', reasoning: 'none', vision: 'none' },
}
const aiPresetData = {
  presets: [
    {
      id: 'openai',
      label: 'OpenAI',
      kind: 'openai-compatible',
      base_url: 'https://api.openai.com/v1',
    },
    {
      id: 'gemini',
      label: 'Gemini',
      kind: 'gemini',
      base_url: 'https://generativelanguage.googleapis.com/v1beta',
    },
    { id: 'custom', label: 'Custom provider', kind: 'openai-compatible', base_url: null },
  ],
}

const aiMutations = {
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
  assign: vi.fn(),
  clear: vi.fn(),
}

const mockUsage = {
  used: 2,
  input_tokens: 640,
  output_tokens: 150,
  cached_tokens: null,
  provider: 'gemini',
}

const mockMutateAsync = vi.fn()

vi.mock('../lib/persona.js', () => ({
  personaText: vi.fn((key) => key),
  deriveHue: vi.fn(() => 230),
}))

const logoutMutate = vi.fn()

vi.mock('../lib/queries/me.js', () => ({
  useMe: () => ({
    data: { user: { id: 'u1', email: 'a@b.com', name: 'Alice', picture: null } },
    isLoading: false,
  }),
  useLogout: () => ({ mutate: logoutMutate, isPending: false }),
}))

vi.mock('../lib/queries/index.js', () => ({
  useSettings: () => ({ data: mockSettings, isLoading: false }),
  useUpdateSettings: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
  useLocations: () => ({
    data: { locations: mockLocations },
    isLoading: false,
  }),
  useCreateLocation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteLocation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useStores: () => ({ data: { stores: mockStores }, isLoading: false }),
  useCreateStore: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteStore: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUsage: () => ({ data: mockUsage }),
  useAiProviders: () => ({ data: aiProviderData, isLoading: false }),
  useAiPresets: () => ({ data: aiPresetData }),
  useAiCapabilities: () => ({ data: aiCapabilityData, isLoading: false }),
  useCreateAiProvider: () => ({ mutateAsync: aiMutations.create, isPending: false }),
  useUpdateAiProvider: () => ({ mutateAsync: aiMutations.update, isPending: false }),
  useDeleteAiProvider: () => ({ mutateAsync: aiMutations.remove, isPending: false }),
  useTestAiProvider: () => ({ mutateAsync: aiMutations.test, isPending: false }),
  useAssignAiCapability: () => ({ mutateAsync: aiMutations.assign, isPending: false }),
  useClearAiCapability: () => ({ mutateAsync: aiMutations.clear, isPending: false }),
}))

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  })
}

function renderWithQuery(ui) {
  return render(
    React.createElement(QueryClientProvider, {
      client: createQueryClient(),
      children: ui,
    })
  )
}

function buttons(container) {
  return Array.from(container.querySelectorAll('button'))
}

function byText(container, text) {
  return buttons(container).find((btn) => btn.textContent?.includes(text))
}

function assignedProvider(id = 'p-1', overrides = {}) {
  return {
    id,
    label: 'Home key',
    kind: 'gemini',
    preset: 'gemini',
    base_url: null,
    default_model: 'a-model',
    has_key: true,
    created_at: '2026-10-01 00:00:00',
    updated_at: '2026-10-01 00:00:00',
    ...overrides,
  }
}

function resetAiFixtures() {
  aiProviderData.can_manage = true
  aiProviderData.managed_by = null
  aiProviderData.providers = []
  aiCapabilityData.can_manage = true
  aiCapabilityData.capabilities = { ...emptyCapabilities }
  aiCapabilityData.status = { decision: 'none', reasoning: 'none', vision: 'none' }
  for (const fn of Object.values(aiMutations)) fn.mockReset()
}

describe('Settings', () => {
  const baseProps = {
    motion: 'standard',
    setMotion: vi.fn(),
  }

  beforeEach(() => {
    resetAiFixtures()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders page lead', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    expect(container.querySelector('[class*="max-w-[62ch]"]')).toBeTruthy()
  })

  it('renders both AI sections and the AI usage section', () => {
    const { getByText } = renderWithQuery(React.createElement(Settings, baseProps))
    expect(getByText('settings.ai.providersTitle')).toBeTruthy()
    expect(getByText('settings.ai.capabilitiesTitle')).toBeTruthy()
    expect(getByText('settings.aiUsage')).toBeTruthy()
  })

  // ─── AI providers ────────────────────────────────────────────────────────

  it('empty state: no provider means no add form, no capability controls', () => {
    const { container, getByText } = renderWithQuery(React.createElement(Settings, baseProps))
    expect(getByText('settings.ai.emptyTitle')).toBeTruthy()
    // The capability section is EMPTY-STATED, not three empty selects: nothing
    // is preselected and there is no provider to preselect (plan §4.4).
    expect(container.querySelector('[data-testid^="ai-capability-provider-"]')).toBeNull()
    expect(container.querySelector('[data-testid^="ai-capability-model-"]')).toBeNull()
    expect(getByText('settings.ai.capabilitiesEmpty')).toBeTruthy()
    // Three fixed capability rows still render, honestly not configured.
    expect(container.textContent).toContain('settings.ai.decision')
    expect(container.textContent).toContain('settings.ai.reasoning')
    expect(container.textContent).toContain('settings.ai.vision')
  })

  it('the add form starts with NOTHING preselected (no preset, no protocol)', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    fireEvent.click(container.querySelector('[data-testid="ai-add-provider"]'))

    expect(container.querySelector('[data-testid="ai-provider-preset"]').value).toBe('')
    expect(container.querySelector('[data-testid="ai-provider-kind"]').value).toBe('')
    // And no server-default affordance anywhere: the platform key is retired.
    expect(container.textContent).not.toMatch(/server|shared key/i)
  })

  it('choosing a preset fills the protocol and its canonical endpoint', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    fireEvent.click(container.querySelector('[data-testid="ai-add-provider"]'))
    fireEvent.change(container.querySelector('[data-testid="ai-provider-preset"]'), {
      target: { value: 'gemini' },
    })
    expect(container.querySelector('[data-testid="ai-provider-kind"]').value).toBe('gemini')
    expect(container.querySelector('[data-testid="ai-provider-base-url"]').value).toBe(
      'https://generativelanguage.googleapis.com/v1beta'
    )
  })

  it('adds a provider through the API with a write-only key', async () => {
    aiMutations.create.mockResolvedValue({ provider: assignedProvider() })
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    fireEvent.click(container.querySelector('[data-testid="ai-add-provider"]'))

    fireEvent.change(container.querySelector('[data-testid="ai-provider-label"]'), {
      target: { value: 'Home key' },
    })
    fireEvent.change(container.querySelector('[data-testid="ai-provider-preset"]'), {
      target: { value: 'gemini' },
    })
    fireEvent.change(container.querySelector('[data-testid="ai-provider-default-model"]'), {
      target: { value: 'a-model' },
    })
    fireEvent.change(container.querySelector('[data-testid="ai-provider-key"]'), {
      target: { value: 'sk-secret' },
    })
    fireEvent.click(container.querySelector('[data-testid="ai-provider-save"]'))

    await waitFor(() =>
      expect(aiMutations.create).toHaveBeenCalledWith({
        label: 'Home key',
        kind: 'gemini',
        preset: 'gemini',
        base_url: 'https://generativelanguage.googleapis.com/v1beta',
        default_model: 'a-model',
        api_key: 'sk-secret',
      })
    )
  })

  it('requires a key on create and shows the server error on failure', async () => {
    aiMutations.create.mockRejectedValue(new Error('A provider with that label already exists'))
    const { container, findByRole } = renderWithQuery(React.createElement(Settings, baseProps))
    fireEvent.click(container.querySelector('[data-testid="ai-add-provider"]'))
    fireEvent.change(container.querySelector('[data-testid="ai-provider-label"]'), {
      target: { value: 'Home key' },
    })
    fireEvent.change(container.querySelector('[data-testid="ai-provider-kind"]'), {
      target: { value: 'gemini' },
    })
    // No key yet: the client refuses before the request.
    fireEvent.click(container.querySelector('[data-testid="ai-provider-save"]'))
    expect(aiMutations.create).not.toHaveBeenCalled()
    expect(container.textContent).toContain('settings.ai.keyRequired')

    fireEvent.change(container.querySelector('[data-testid="ai-provider-key"]'), {
      target: { value: 'sk-secret' },
    })
    fireEvent.click(container.querySelector('[data-testid="ai-provider-save"]'))
    expect((await findByRole('alert')).textContent).toContain('already exists')
  })

  it('edits a provider without resending the preset and can clear base URL + model', async () => {
    aiProviderData.providers = [
      assignedProvider('p-1', {
        base_url: 'https://example.test/v1',
        default_model: 'a-model',
      }),
    ]
    aiMutations.update.mockResolvedValue({ provider: assignedProvider() })
    const { container, getByText } = renderWithQuery(React.createElement(Settings, baseProps))
    // Edit opens with the row's current values; the preset picker is gone (the
    // PATCH body has no `preset` — sending one is a 400).
    fireEvent.click(getByText('settings.ai.edit'))
    expect(container.querySelector('[data-testid="ai-provider-preset"]')).toBeNull()
    fireEvent.change(container.querySelector('[data-testid="ai-provider-base-url"]'), {
      target: { value: '' },
    })
    fireEvent.change(container.querySelector('[data-testid="ai-provider-default-model"]'), {
      target: { value: '' },
    })
    fireEvent.click(container.querySelector('[data-testid="ai-provider-save"]'))

    await waitFor(() =>
      expect(aiMutations.update).toHaveBeenCalledWith({
        id: 'p-1',
        payload: { label: 'Home key', kind: 'gemini', base_url: '', default_model: '' },
      })
    )
  })

  it('keeps the stored key when the edit leaves the key field blank', async () => {
    aiProviderData.providers = [assignedProvider()]
    aiMutations.update.mockResolvedValue({ provider: assignedProvider() })
    const { container, getByText } = renderWithQuery(React.createElement(Settings, baseProps))
    fireEvent.click(getByText('settings.ai.edit'))
    fireEvent.click(container.querySelector('[data-testid="ai-provider-save"]'))
    await waitFor(() => expect(aiMutations.update).toHaveBeenCalled())
    expect(aiMutations.update.mock.calls[0][0].payload).not.toHaveProperty('api_key')
  })

  it('runs the connection test and renders a code (never the provider body)', async () => {
    aiProviderData.providers = [assignedProvider()]
    aiMutations.test.mockResolvedValue({ ok: false, code: 'auth' })
    const { container, getByTestId } = renderWithQuery(React.createElement(Settings, baseProps))
    fireEvent.click(getByTestId('ai-test-p-1'))
    await waitFor(() => expect(aiMutations.test).toHaveBeenCalledWith('p-1'))
    await waitFor(() => expect(container.textContent).toContain('settings.ai.testFailed'))
  })

  it('warns which capabilities become not configured before deleting a provider', async () => {
    aiProviderData.providers = [assignedProvider()]
    aiCapabilityData.capabilities = {
      ...emptyCapabilities,
      reasoning: {
        provider_id: 'p-1',
        provider_label: 'Home key',
        model: 'a-model',
        thinking_level: null,
        source: 'household',
      },
    }
    aiCapabilityData.status = { decision: 'none', reasoning: 'household', vision: 'none' }
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    aiMutations.remove.mockResolvedValue({ cleared: ['reasoning'] })

    const { getByTestId } = renderWithQuery(React.createElement(Settings, baseProps))
    fireEvent.click(getByTestId('ai-delete-p-1'))

    // The warning names the capability that will go dark — the whole point of
    // the cascade report (plan §4.1).
    const message = confirm.mock.calls[0][0]
    expect(message).toContain('settings.ai.deleteConfirm')
    expect(confirm.mock.calls[0][1]).toBeUndefined()
    await waitFor(() => expect(aiMutations.remove).toHaveBeenCalledWith('p-1'))
  })

  it('does not delete when the confirmation is declined', async () => {
    aiProviderData.providers = [assignedProvider()]
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { getByTestId } = renderWithQuery(React.createElement(Settings, baseProps))
    fireEvent.click(getByTestId('ai-delete-p-1'))
    expect(aiMutations.remove).not.toHaveBeenCalled()
  })

  // ─── AI capabilities ─────────────────────────────────────────────────────

  it('renders the three capability cards once a provider exists', () => {
    aiProviderData.providers = [assignedProvider()]
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    for (const capability of ['decision', 'reasoning', 'vision']) {
      const select = container.querySelector(`[data-testid="ai-capability-provider-${capability}"]`)
      expect(select).toBeTruthy()
      // Nothing is preselected: the first option is the empty "choose" one.
      expect(select.value).toBe('')
      expect(
        container.querySelector(`[data-testid="ai-capability-model-${capability}"]`).value
      ).toBe('')
    }
    // Vision has NO thinking level — the capability has no such knob (§4.2).
    expect(container.querySelector('[data-testid="ai-capability-thinking-decision"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="ai-capability-thinking-reasoning"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="ai-capability-thinking-vision"]')).toBeNull()
  })

  it('assigns a capability with a blank model (inherit the provider default)', async () => {
    aiProviderData.providers = [assignedProvider()]
    aiMutations.assign.mockResolvedValue({ capability: {}, status: 'household' })
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))

    fireEvent.change(container.querySelector('[data-testid="ai-capability-provider-reasoning"]'), {
      target: { value: 'p-1' },
    })
    fireEvent.change(container.querySelector('[data-testid="ai-capability-thinking-reasoning"]'), {
      target: { value: 'medium' },
    })
    fireEvent.click(container.querySelector('[data-testid="ai-capability-save-reasoning"]'))

    await waitFor(() =>
      expect(aiMutations.assign).toHaveBeenCalledWith({
        capability: 'reasoning',
        payload: { provider_id: 'p-1', model: '', thinking_level: 'medium' },
      })
    )
  })

  it('never sends a thinking level for vision', async () => {
    aiProviderData.providers = [assignedProvider()]
    aiMutations.assign.mockResolvedValue({ capability: {}, status: 'household' })
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    fireEvent.change(container.querySelector('[data-testid="ai-capability-provider-vision"]'), {
      target: { value: 'p-1' },
    })
    fireEvent.click(container.querySelector('[data-testid="ai-capability-save-vision"]'))
    await waitFor(() =>
      expect(aiMutations.assign).toHaveBeenCalledWith({
        capability: 'vision',
        payload: { provider_id: 'p-1', model: '' },
      })
    )
  })

  it('choosing "Choose a provider" + Save clears the assignment', async () => {
    aiProviderData.providers = [assignedProvider()]
    aiCapabilityData.capabilities = {
      ...emptyCapabilities,
      decision: {
        provider_id: 'p-1',
        provider_label: 'Home key',
        model: 'a-model',
        thinking_level: null,
        source: 'household',
      },
    }
    aiMutations.clear.mockResolvedValue({ capability: {}, status: 'none' })
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    // The hydrated select points at the assigned provider…
    const select = container.querySelector('[data-testid="ai-capability-provider-decision"]')
    await waitFor(() => expect(select.value).toBe('p-1'))
    // …and going back to the empty option clears it.
    fireEvent.change(select, { target: { value: '' } })
    fireEvent.click(container.querySelector('[data-testid="ai-capability-save-decision"]'))
    await waitFor(() => expect(aiMutations.clear).toHaveBeenCalledWith('decision'))
  })

  it('shows the effective model and the not-configured state', () => {
    aiProviderData.providers = [assignedProvider()]
    aiCapabilityData.capabilities = {
      ...emptyCapabilities,
      reasoning: {
        provider_id: 'p-1',
        provider_label: 'Home key',
        model: 'pinned-model',
        thinking_level: 'low',
        source: 'household',
      },
    }
    aiCapabilityData.status = { decision: 'none', reasoning: 'household', vision: 'none' }
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    expect(
      container.querySelector('[data-testid="ai-capability-status-reasoning"]').textContent
    ).toContain('settings.ai.usingWithModel')
    expect(
      container.querySelector('[data-testid="ai-capability-status-decision"]').textContent
    ).toContain('settings.ai.notConfigured')
  })

  // ─── member read-only ───────────────────────────────────────────────────

  it('a member sees the configuration read-only, with no manage affordance', () => {
    aiProviderData.can_manage = false
    aiProviderData.managed_by = 'Alice'
    aiProviderData.providers = [assignedProvider()]
    aiCapabilityData.can_manage = false
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))

    expect(container.textContent).toContain('settings.ai.managedBy')
    // No add, test, edit, delete or save control anywhere in either section.
    expect(container.querySelector('[data-testid="ai-add-provider"]')).toBeNull()
    expect(container.querySelector('[data-testid^="ai-test-"]')).toBeNull()
    expect(container.querySelector('[data-testid^="ai-delete-"]')).toBeNull()
    expect(container.querySelector('[data-testid^="ai-capability-save-"]')).toBeNull()
    expect(container.querySelector('[data-testid^="ai-capability-provider-"]')).toBeNull()
    // The status lines are still there: a member can SEE what the household uses.
    expect(
      container.querySelector('[data-testid="ai-capability-status-decision"]').textContent
    ).toContain('settings.ai.notConfigured')
  })

  // ─── unchanged preference surfaces ───────────────────────────────────────

  it('renders persona inputs', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const inputs = container.querySelectorAll('input')
    expect(inputs.length).toBeGreaterThan(0)
  })

  it('renders storage locations section', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    expect(container.textContent).toContain('settings.storageLocations')
  })

  it('renders recorded stores section', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    expect(container.textContent).toContain('settings.recordedStores')
  })

  it('renders display section', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    expect(container.textContent).toContain('settings.display')
  })

  it('adds a new location', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const locInput = container.querySelector('input[placeholder="settings.locationName"]')
    if (locInput) {
      fireEvent.change(locInput, { target: { value: 'Garage' } })
    }
    const addBtn = byText(container, 'settings.add')
    if (addBtn) {
      fireEvent.click(addBtn)
    }
  })

  it('removes a location', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const deleteBtns = buttons(container).filter((btn) => btn.querySelector('svg'))
    if (deleteBtns.length > 0) {
      fireEvent.click(deleteBtns[0])
    }
  })

  it('handles language change', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const langBtns = container.querySelectorAll('[aria-pressed]')
    if (langBtns.length > 0) {
      fireEvent.click(langBtns[0])
    }
  })

  it('handles motion change', () => {
    const setMotion = vi.fn()
    const { container } = renderWithQuery(
      React.createElement(Settings, { ...baseProps, setMotion })
    )
    const motionBtns = container.querySelectorAll('[role="group"] button')
    if (motionBtns.length > 0) {
      fireEvent.click(motionBtns[0])
      expect(setMotion).toHaveBeenCalled()
    }
  })

  it('handles persona toggle', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const checkbox = container.querySelector('#persona-toggle')
    if (checkbox) {
      fireEvent.click(checkbox)
      expect(checkbox.checked).toBe(true)
    }
  })

  it('handles persona role inputs', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const myRole = container.querySelector('input[aria-label="settings.aria.myRole"]')
    const aiRole = container.querySelector('input[aria-label="settings.aria.aiRole"]')
    if (myRole) {
      fireEvent.change(myRole, { target: { value: 'raja' } })
    }
    if (aiRole) {
      fireEvent.change(aiRole, { target: { value: 'prajurit' } })
    }
  })

  it('applies persona with apply button', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const applyBtn = byText(container, 'settings.apply')
    if (applyBtn) {
      fireEvent.click(applyBtn)
    }
  })

  it('saves the persona without calling the browser-side AI rewrite (P5 owns it)', async () => {
    // #523 P3 removed the provider/base-URL/model fields the old rewrite read;
    // calling it with undefined identifiers threw a ReferenceError. The page
    // must save the persona and never reach the browser provider path.
    const { regenerateCopy } = usePersona()
    regenerateCopy.mockClear()
    const { getByText } = renderWithQuery(React.createElement(Settings, baseProps))
    fireEvent.click(getByText('settings.apply'))
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalled())
    expect(regenerateCopy).not.toHaveBeenCalled()
  })

  it('saves persona preferences through the settings PATCH', async () => {
    mockMutateAsync.mockResolvedValue({ ...mockSettings })
    const { getByText } = renderWithQuery(React.createElement(Settings, baseProps))
    fireEvent.click(getByText('settings.apply'))
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalled())
    const payload = mockMutateAsync.mock.calls[0][0]
    expect(payload).not.toHaveProperty('ai_key')
    expect(payload).not.toHaveProperty('ai_provider')
    expect(payload).toHaveProperty('persona_enabled')
  })

  it('adds location with Enter key', () => {
    const { container } = renderWithQuery(React.createElement(Settings, baseProps))
    const locInput = container.querySelector('input[placeholder="settings.locationName"]')
    if (locInput) {
      fireEvent.change(locInput, { target: { value: 'Pantry' } })
      fireEvent.keyDown(locInput, { key: 'Enter' })
    }
  })

  it('renders the account section and calls logout from Settings', () => {
    const { getByText } = renderWithQuery(React.createElement(Settings, baseProps))
    // The global t() mock renders raw keys in tests
    expect(getByText('settings.account')).toBeTruthy()
    expect(getByText('Alice')).toBeTruthy()
    fireEvent.click(getByText('nav.logout'))
    expect(logoutMutate).toHaveBeenCalled()
  })
})
