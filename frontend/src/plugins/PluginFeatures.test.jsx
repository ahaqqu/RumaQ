import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import React from 'react'
import { PluginFeatures } from './PluginFeatures.jsx'

// The section reads only its two query hooks — mock the module, not the
// network: these tests pin RENDERING and the owner-only affordance, while
// the cache plumbing (optimistic toggle + ['me'] invalidation) is pinned in
// lib/queries/plugins.test.js.
vi.mock('../lib/queries/index.js', () => ({
  usePluginCatalog: vi.fn(),
  useSetPluginEnablement: vi.fn(),
}))

import { usePluginCatalog, useSetPluginEnablement } from '../lib/queries/index.js'

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

function mutation(overrides = {}) {
  return { mutate: vi.fn(), isPending: false, isError: false, ...overrides }
}

function renderSection(isOwner) {
  return render(React.createElement(PluginFeatures, { isOwner }))
}

describe('PluginFeatures (settings catalog, issue #437)', () => {
  beforeEach(() => {
    vi.mocked(useSetPluginEnablement).mockReturnValue(mutation())
  })

  it('renders every catalog plugin with label, description and capability chips', () => {
    vi.mocked(usePluginCatalog).mockReturnValue({
      data: { plugins: [documentsRow()] },
      isPending: false,
      isError: false,
    })
    const { container } = renderSection(true)
    expect(container.textContent).toContain('nav.documents')
    expect(container.textContent).toContain('documents.subtitle')
    // The capabilities surface: one chip per declared capability, copy from
    // the plugins.capabilities.* namespace (en + id pinned in
    // registry.test.js).
    expect(container.textContent).toContain('plugins.capabilities.purge')
    expect(container.textContent).toContain('plugins.capabilities.export')
  })

  it('gives the owner a switch reflecting the household layer, wired to the toggle', () => {
    vi.mocked(usePluginCatalog).mockReturnValue({
      data: { plugins: [documentsRow({ enabled: true })] },
      isPending: false,
      isError: false,
    })
    const mutate = vi.fn()
    vi.mocked(useSetPluginEnablement).mockReturnValue(mutation({ mutate }))
    const { container } = renderSection(true)

    const sw = container.querySelector('[role="switch"]')
    expect(sw).not.toBeNull()
    expect(sw.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(sw)
    expect(mutate).toHaveBeenCalledWith({ pluginId: 'documents', status: 'disabled' })
  })

  it('shows the retention promise on a disabled plugin (disable never deletes, §3.4)', () => {
    vi.mocked(usePluginCatalog).mockReturnValue({
      data: { plugins: [documentsRow({ enabled: false, available: false })] },
      isPending: false,
      isError: false,
    })
    const mutate = vi.fn()
    vi.mocked(useSetPluginEnablement).mockReturnValue(mutation({ mutate }))
    const { container } = renderSection(true)

    const sw = container.querySelector('[role="switch"]')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(container.textContent).toContain('plugins.retentionNote')

    fireEvent.click(sw)
    expect(mutate).toHaveBeenCalledWith({ pluginId: 'documents', status: 'enabled' })
  })

  it('reports the ops layer honestly: deployment-off outranks the toggle state', () => {
    vi.mocked(usePluginCatalog).mockReturnValue({
      data: { plugins: [documentsRow({ deployment_available: false, available: false })] },
      isPending: false,
      isError: false,
    })
    const { container } = renderSection(true)
    expect(container.textContent).toContain('plugins.deploymentOff')
    // The switch stays — the household choice is still recordable while the
    // deployment layer is paused; the layer lines explain the 404.
    expect(container.querySelector('[role="switch"]')).not.toBeNull()
    expect(container.textContent).not.toContain('plugins.retentionNote')
  })

  it('reports the plan layer honestly: unentitled shows the 403 sentence', () => {
    vi.mocked(usePluginCatalog).mockReturnValue({
      data: { plugins: [documentsRow({ plan_entitled: false, available: false })] },
      isPending: false,
      isError: false,
    })
    const { container } = renderSection(true)
    expect(container.textContent).toContain('plugins.planExcluded')
  })

  it('renders members read-only: state chip instead of a switch, plus the hint', () => {
    vi.mocked(usePluginCatalog).mockReturnValue({
      data: { plugins: [documentsRow({ enabled: false, available: false })] },
      isPending: false,
      isError: false,
    })
    const { container } = renderSection(false)
    expect(container.querySelector('[role="switch"]')).toBeNull()
    expect(container.textContent).toContain('plugins.membersHint')
    expect(container.textContent).toContain('plugins.stateOff')
  })

  it('surfaces a mutation failure once, panel-wide', () => {
    vi.mocked(usePluginCatalog).mockReturnValue({
      data: { plugins: [documentsRow()] },
      isPending: false,
      isError: false,
    })
    vi.mocked(useSetPluginEnablement).mockReturnValue(mutation({ isError: true }))
    const { container } = renderSection(true)
    const alerts = [...container.querySelectorAll('[role="alert"]')]
    expect(alerts).toHaveLength(1)
    expect(alerts[0].textContent).toContain('plugins.errorGeneric')
  })
})
