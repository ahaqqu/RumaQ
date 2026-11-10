import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, waitFor } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PluginCatalogProvider, usePluginCatalog } from './context.jsx'
import { getMe } from '../lib/api'

// The provider rides the real useMe query (me.js imports ../api), so the
// mocked client feeds it the /api/me payloads the backend contract defines.
vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(message, status) {
      super(message)
      this.status = status
    }
  },
  getMe: vi.fn(),
  logout: vi.fn(),
}))

const user = { id: 'u1', email: 'a@b.com', name: 'Alice', isAdmin: false }

function CatalogProbe() {
  const { nav, navAll, isEnabled } = usePluginCatalog()
  return (
    <div data-testid="probe">
      {JSON.stringify({
        household: nav.household.map((entry) => entry.to),
        allHousehold: navAll.household.map((entry) => entry.to),
        documentsEnabled: isEnabled('documents'),
      })}
    </div>
  )
}

function renderCatalog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <PluginCatalogProvider>
        <CatalogProbe />
      </PluginCatalogProvider>
    </QueryClientProvider>
  )
  return { queryClient, ...view }
}

const probeState = () => JSON.parse(document.querySelector('[data-testid="probe"]').textContent)

beforeEach(() => {
  vi.mocked(getMe).mockReset()
})

describe('PluginCatalogProvider', () => {
  it('treats an ABSENT enabledPlugins field as all plugins enabled (legacy payloads)', async () => {
    // Legacy /api/me payloads, stale PWA bundles and failed enablement reads
    // omit the field — no surface may hide because of it (plan §4.5).
    vi.mocked(getMe).mockResolvedValue({ user })
    renderCatalog()
    await waitFor(() => expect(probeState().documentsEnabled).toBe(true))
    expect(probeState().household).toContain('/documents')
  })

  it('filters catalog contributions down to the enabled plugin set', async () => {
    vi.mocked(getMe).mockResolvedValue({ user, enabledPlugins: [] })
    renderCatalog()
    await waitFor(() => expect(probeState().documentsEnabled).toBe(false))
    expect(probeState().household).not.toContain('/documents')
    // navAll stays unfiltered for the page-title lookup: a disabled plugin's
    // route must still resolve to its real name, not the "Home" fallback.
    expect(probeState().allHousehold).toContain('/documents')
  })

  it('drops malformed array ELEMENTS so a corrupt payload still fails open', async () => {
    // A typed backend never sends these (generated types: string[]), but the
    // fail-open contract (plan §4.5) governs the payload, not the sender: a
    // Set built from [123] would miss every string id and silently hide all
    // plugin surfaces — the fail-closed posture the plan reserves for the
    // server. Non-string elements are dropped before the Set; any surviving
    // string ids keep working.
    vi.mocked(getMe).mockResolvedValue({ user, enabledPlugins: [123, null, 'documents'] })
    renderCatalog()
    await waitFor(() => expect(probeState().documentsEnabled).toBe(true))
    expect(probeState().household).toContain('/documents')
  })

  it('re-derives the catalog when the household-switch refetch lands (#436)', async () => {
    // Household A has the vault disabled: the payload filters the entry out.
    vi.mocked(getMe).mockResolvedValue({ user, enabledPlugins: [] })
    const { queryClient } = renderCatalog()
    await waitFor(() => expect(probeState().documentsEnabled).toBe(false))

    // Switch to household B (vault enabled): useActivateHousehold's settle
    // hook invalidates the whole cache, the always-mounted ['me'] query
    // refetches against the new ACTIVE household, and the provider recomputes.
    vi.mocked(getMe).mockResolvedValue({ user, enabledPlugins: ['documents'] })
    queryClient.invalidateQueries()
    await waitFor(() => expect(probeState().documentsEnabled).toBe(true))
    expect(probeState().household).toContain('/documents')
  })
})
