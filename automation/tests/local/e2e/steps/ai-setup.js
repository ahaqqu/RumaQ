import { expect } from '@playwright/test'
import { clearPersistedQueryCache } from './shared.steps.js'

// ahaqqu/RumaQ#523 P3: the local stack carries no AI provider, and the legacy
// PATCH /api/settings ai_key write is retired with the columns migration 0042
// drops. A scenario turns AI on the way a household owner does in Settings:
// create a provider row, then assign the capabilities it should serve.
//
// These are the real public endpoints — no test route, no direct SQL — and the
// key value never leaves the row: TEST_MODE stubs the provider transport, so the
// model call is simulated and no vendor sees the request.
//
// The app persists its query cache in IndexedDB (idb-keyval) and settings have a
// five-minute staleTime, so a page (re)load would otherwise restore the stale
// pre-setup "not configured" state. Dropping the persisted cache forces a fresh
// settings fetch on the next load.
export async function configureAi(page, capabilities = ['decision', 'reasoning', 'vision']) {
  const created = await page.request.post('/api/ai/providers', {
    data: {
      label: 'E2E provider',
      kind: 'openai-compatible',
      preset: 'openai',
      api_key: 'sk-test-key-12345',
    },
  })
  expect(created.status(), await created.text()).toBe(201)
  const { provider } = await created.json()
  expect(provider?.id).toBeTruthy()

  for (const capability of capabilities) {
    // A capability with no model anywhere is "not configured", so each
    // assignment pins one; it is never sent to a vendor in TEST_MODE.
    const assigned = await page.request.put(`/api/ai/capabilities/${capability}`, {
      data: { provider_id: provider.id, model: 'test-model' },
    })
    expect(assigned.status(), `assigning ${capability}: ${await assigned.text()}`).toBe(200)
  }

  // The browser holds a settings snapshot with `ai_status: none` from before
  // these writes; drop it so the next document load reads the API.
  await clearPersistedQueryCache(page)
}
