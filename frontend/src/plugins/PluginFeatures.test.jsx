import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PluginFeatures } from './PluginFeatures.jsx'
import {
  cancelPluginPurge,
  getPluginCatalog,
  requestPluginPurge,
  setPluginEnablement,
} from '../lib/api'

// The section rides the REAL query hooks — only the network layer is mocked
// (the context.test.jsx idiom). That matters for the failed-toggle alert: a
// second useMutation observer never sees a mutation it did not trigger, so
// seeding error state through a hook mock can never prove the alert actually
// fires. Here a rejected toggle flows through the hoisted panel-owned
// mutation end-to-end. The pure cache plumbing (optimistic toggle + ['me']
// invalidation) stays pinned in lib/queries/plugins.test.js.
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal()),
  getPluginCatalog: vi.fn(),
  setPluginEnablement: vi.fn(),
  requestPluginPurge: vi.fn(),
  cancelPluginPurge: vi.fn(),
}))

// The server row the catalog endpoint answers for the documents plugin —
// the posture fields drive the honest layer display (issue #437).
const documentsRow = (overrides = {}) => ({
  id: 'documents',
  name: 'Documents',
  capabilities: ['purge', 'export'],
  default_enabled: true,
  enabled: true,
  source: 'default',
  deployment_available: true,
  plan_entitled: true,
  available: true,
  ...overrides,
})

function renderSection(isOwner) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <PluginFeatures isOwner={isOwner} />
    </QueryClientProvider>
  )
  return { queryClient, ...view }
}

// Resolves once the catalog rows rendered, handing back the (first) switch.
const waitForSwitch = (container) =>
  waitFor(() => {
    const sw = container.querySelector('[role="switch"]')
    expect(sw).not.toBeNull()
    return sw
  })

beforeEach(() => {
  vi.mocked(getPluginCatalog).mockReset()
  vi.mocked(setPluginEnablement).mockReset()
  vi.mocked(requestPluginPurge).mockReset()
  vi.mocked(cancelPluginPurge).mockReset()
})

describe('PluginFeatures (settings catalog, issue #437)', () => {
  it('renders every catalog plugin with label, description and capability chips', async () => {
    vi.mocked(getPluginCatalog).mockResolvedValue({ plugins: [documentsRow()] })
    const { container } = renderSection(true)
    await waitForSwitch(container)
    expect(container.textContent).toContain('nav.documents')
    expect(container.textContent).toContain('documents.subtitle')
    // The capabilities surface: one chip per declared capability, copy from
    // the plugins.capabilities.* namespace (en + id pinned in
    // registry.test.js).
    expect(container.textContent).toContain('plugins.capabilities.purge')
    expect(container.textContent).toContain('plugins.capabilities.export')
  })

  it('gives the owner a switch reflecting the household layer, wired to the toggle', async () => {
    vi.mocked(getPluginCatalog).mockResolvedValue({ plugins: [documentsRow({ enabled: true })] })
    vi.mocked(setPluginEnablement).mockResolvedValue(documentsRow({ enabled: false }))
    const { container } = renderSection(true)

    const sw = await waitForSwitch(container)
    expect(sw.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(sw)
    await waitFor(() => expect(setPluginEnablement).toHaveBeenCalledWith('documents', 'disabled'))
  })

  it('shows the retention promise on a disabled plugin (disable never deletes, §3.4)', async () => {
    vi.mocked(getPluginCatalog).mockResolvedValue({
      plugins: [documentsRow({ enabled: false, available: false })],
    })
    vi.mocked(setPluginEnablement).mockResolvedValue(documentsRow())
    const { container } = renderSection(true)

    const sw = await waitForSwitch(container)
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(container.textContent).toContain('plugins.retentionNote')

    fireEvent.click(sw)
    await waitFor(() => expect(setPluginEnablement).toHaveBeenCalledWith('documents', 'enabled'))
  })

  it('reports the ops layer honestly: deployment-off outranks the toggle state', async () => {
    vi.mocked(getPluginCatalog).mockResolvedValue({
      plugins: [documentsRow({ deployment_available: false, available: false })],
    })
    const { container } = renderSection(true)
    await waitForSwitch(container)
    expect(container.textContent).toContain('plugins.deploymentOff')
    // The switch stays — the household choice is still recordable while the
    // deployment layer is paused; the layer lines explain the 404.
    expect(container.querySelector('[role="switch"]')).not.toBeNull()
    expect(container.textContent).not.toContain('plugins.retentionNote')
  })

  it('reports the plan layer honestly: unentitled shows the 403 sentence', async () => {
    vi.mocked(getPluginCatalog).mockResolvedValue({
      plugins: [documentsRow({ plan_entitled: false, available: false })],
    })
    const { container } = renderSection(true)
    await waitForSwitch(container)
    expect(container.textContent).toContain('plugins.planExcluded')
  })

  it('renders members read-only: state chip instead of a switch, plus the hint', async () => {
    vi.mocked(getPluginCatalog).mockResolvedValue({
      plugins: [documentsRow({ enabled: false, available: false })],
    })
    const { container } = renderSection(false)
    await waitFor(() => expect(container.textContent).toContain('plugins.stateOff'))
    expect(container.querySelector('[role="switch"]')).toBeNull()
    expect(container.textContent).toContain('plugins.membersHint')
  })

  it('shows only the toggled row pending while the mutation is in flight', async () => {
    vi.mocked(getPluginCatalog).mockResolvedValue({ plugins: [documentsRow()] })
    // Never settles: the mutation stays pending for the whole test.
    vi.mocked(setPluginEnablement).mockReturnValue(new Promise(() => {}))
    const { container } = renderSection(true)

    const sw = await waitForSwitch(container)
    fireEvent.click(sw)
    await waitFor(() => expect(container.querySelector('[role="switch"]').disabled).toBe(true))
  })

  it('surfaces a failed toggle once, panel-wide, and rolls the switch back', async () => {
    // The REAL hook end-to-end (no hook mocks): the toggle rejects, the
    // optimistic flip rolls back to the honest cache state, and the hoisted
    // panel-owned mutation renders exactly one alert — the failure feedback
    // a second observer could never have seen (S1-A1, PR #470 review).
    vi.mocked(getPluginCatalog).mockResolvedValue({ plugins: [documentsRow({ enabled: true })] })
    vi.mocked(setPluginEnablement).mockRejectedValue(new Error('forbidden'))
    const { container } = renderSection(true)

    const sw = await waitForSwitch(container)
    fireEvent.click(sw)

    await waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull())
    // Exactly one alert, panel-wide, with the generic failure copy.
    const alerts = [...container.querySelectorAll('[role="alert"]')]
    expect(alerts).toHaveLength(1)
    expect(alerts[0].textContent).toContain('plugins.errorGeneric')
    // The rollback: the switch snapped back to the honest (enabled) state —
    // the alert is the failure signal, the switch position is the truth.
    expect(container.querySelector('[role="switch"]').getAttribute('aria-checked')).toBe('true')
  })
})

// The purge lifecycle surface (ticket 5, #439): owner-only danger action,
// typed-confirmation dialog (a checkbox is a misclick away — the typed
// string is the deliberate act §3.4 requires), honest drain-state lines.
// The REAL hook end-to-end (no hook mocks) — the mutation's onSuccess close
// and the alert-on-failure behavior are what a second observer could never
// have seen seeded.
describe('PluginFeatures — purge lifecycle (ticket 5, #439)', () => {
  it('offers the owner the danger action on a purge-capable plugin; members get neither button nor state action', async () => {
    vi.mocked(getPluginCatalog).mockResolvedValue({ plugins: [documentsRow()] })
    const owner = renderSection(true)
    const button = await waitFor(() => {
      const btn = [...owner.container.querySelectorAll('button')].find((b) =>
        b.textContent.includes('plugins.purge.action')
      )
      expect(btn).toBeTruthy()
      return btn
    })
    owner.unmount()

    vi.mocked(getPluginCatalog).mockResolvedValue({ plugins: [documentsRow()] })
    const member = renderSection(false)
    await waitFor(() => expect(member.container.textContent).toContain('plugins.stateOn'))
    expect(
      [...member.container.querySelectorAll('button')].some((b) =>
        b.textContent.includes('plugins.purge.action')
      )
    ).toBe(false)
    void button
  })

  it('opens the typed-confirmation dialog; submit stays disabled until the name matches exactly', async () => {
    vi.mocked(getPluginCatalog).mockResolvedValue({ plugins: [documentsRow()] })
    vi.mocked(requestPluginPurge).mockResolvedValue(documentsRow())
    const { container } = renderSection(true)

    const action = await waitFor(() => {
      const btn = [...container.querySelectorAll('button')].find((b) =>
        b.textContent.includes('plugins.purge.action')
      )
      expect(btn).toBeTruthy()
      return btn
    })
    fireEvent.click(action)
    await waitFor(() => {
      const el = container.querySelector('[role="dialog"]')
      expect(el).not.toBeNull()
      return el
    })
    expect(container.textContent).toContain('plugins.purge.dialogWarning')

    const input = container.querySelector('#purge-confirm-input')
    const submit = [...container.querySelectorAll('button')].find((b) =>
      b.textContent.includes('plugins.purge.dialogConfirm')
    )
    // A checkbox would pass here; the typed gate must not.
    expect(submit.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'documents' } }) // case matters
    expect(submit.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'Documents' } })
    expect(submit.disabled).toBe(false)

    fireEvent.click(submit)
    await waitFor(() => expect(requestPluginPurge).toHaveBeenCalledWith('documents', 'Documents'))
  })

  it('keeps the dialog open on a failed initiation and renders the alert', async () => {
    vi.mocked(getPluginCatalog).mockResolvedValue({ plugins: [documentsRow()] })
    vi.mocked(requestPluginPurge).mockRejectedValue(new Error('boom'))
    const { container } = renderSection(true)

    const action = await waitFor(() => {
      const btn = [...container.querySelectorAll('button')].find((b) =>
        b.textContent.includes('plugins.purge.action')
      )
      expect(btn).toBeTruthy()
      return btn
    })
    fireEvent.click(action)
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).not.toBeNull())

    fireEvent.change(container.querySelector('#purge-confirm-input'), {
      target: { value: 'Documents' },
    })
    const submit = [...container.querySelectorAll('button')].find((b) =>
      b.textContent.includes('plugins.purge.dialogConfirm')
    )
    fireEvent.click(submit)
    await waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull())
    expect(container.textContent).toContain('plugins.purge.errorGeneric')
    // The dialog did NOT close on failure — the alert is the only surface.
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('hides the action and shows the uploads-paused line while a drain is in flight', async () => {
    vi.mocked(getPluginCatalog).mockResolvedValue({
      plugins: [
        documentsRow({
          purge: { state: 'running', requested_at: '2026-11-06 03:00:00', completed_at: null },
        }),
      ],
    })
    const { container } = renderSection(true)
    await waitFor(() => expect(container.textContent).toContain('plugins.purge.stateRunning'))
    expect(
      [...container.querySelectorAll('button')].some((b) =>
        b.textContent.includes('plugins.purge.action')
      )
    ).toBe(false)
  })

  it('gives the owner the cancel lever during a drain (P1-A3) — and members none', async () => {
    const drainingRow = () =>
      documentsRow({
        purge: { state: 'running', requested_at: '2026-11-06 03:00:00', completed_at: null },
      })
    // Owner: the cancel button rides the state line and calls the endpoint.
    vi.mocked(getPluginCatalog).mockResolvedValue({ plugins: [drainingRow()] })
    vi.mocked(cancelPluginPurge).mockResolvedValue(documentsRow({ purge: null }))
    const owner = renderSection(true)
    const cancel = await waitFor(() => {
      const btn = [...owner.container.querySelectorAll('button')].find((b) =>
        b.textContent.includes('plugins.purge.cancel')
      )
      expect(btn).toBeTruthy()
      return btn
    })
    fireEvent.click(cancel)
    await waitFor(() => expect(cancelPluginPurge).toHaveBeenCalledWith('documents'))
    owner.unmount()

    // Member: the state line renders, no cancel lever.
    vi.mocked(getPluginCatalog).mockResolvedValue({ plugins: [drainingRow()] })
    const member = renderSection(false)
    await waitFor(() =>
      expect(member.container.textContent).toContain('plugins.purge.stateRunning')
    )
    expect(
      [...member.container.querySelectorAll('button')].some((b) =>
        b.textContent.includes('plugins.purge.cancel')
      )
    ).toBe(false)
  })

  it('shows the completion line once the drain is done', async () => {
    vi.mocked(getPluginCatalog).mockResolvedValue({
      plugins: [
        documentsRow({
          purge: {
            state: 'done',
            requested_at: '2026-11-06 03:00:00',
            completed_at: '2026-11-07 03:00:00',
          },
        }),
      ],
    })
    const { container } = renderSection(true)
    await waitFor(() => expect(container.textContent).toContain('plugins.purge.stateDone'))
  })
})
