/**
 * RumaQ API client — talks to the Cloudflare Worker backend.
 * All protected endpoints use the rumaq_session cookie (HttpOnly).
 *
 * Built on the typed contract generated from the backend's OpenAPI spec
 * (`bun run api:codegen` → openapi.json → api-schema.d.ts). Route paths and
 * query parameters are type-checked against the backend; drift between the
 * backend and this client fails `vp check` / CI.
 */
import createClient from 'openapi-fetch'
import type { operations, paths } from './api-schema.js'

const client = createClient<paths>({ credentials: 'include' })

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function unwrap<T>(resultPromise: Promise<unknown>): Promise<T> {
  const result = (await resultPromise) as {
    data?: T
    error?: unknown
    response: Response
  }
  if (result.error !== undefined || !result.response.ok) {
    const body = result.error as { error?: string } | undefined
    throw new ApiError(
      body?.error || `Request failed: ${result.response.status}`,
      result.response.status
    )
  }
  return (result.data ?? null) as T
}

export function getMe(): Promise<unknown> {
  return unwrap(client.GET('/api/me'))
}

export function getStock(
  { location, q }: { location?: string; q?: string } = {},
  signal?: AbortSignal
): Promise<unknown> {
  return unwrap(client.GET('/api/stock', { params: { query: { location, q } }, signal }))
}

export function getHealth(): Promise<unknown> {
  return unwrap(client.GET('/api/health'))
}

export function login() {
  window.location.href = '/api/auth/login'
}

export function logout() {
  window.location.href = '/api/auth/logout'
}

export async function emailAuthStatus(): Promise<{ enabled: boolean }> {
  try {
    return await unwrap<{ enabled: boolean }>(client.GET('/api/auth/email-status'))
  } catch {
    return { enabled: false }
  }
}

export async function emailLogin(email: string, password: string): Promise<unknown> {
  return unwrap(client.POST('/api/auth/email-login', { body: { email, password } }))
}

export async function isAuthenticated(): Promise<boolean> {
  try {
    await getMe()
    return true
  } catch {
    return false
  }
}

export function getSettings(): Promise<unknown> {
  return unwrap(client.GET('/api/settings'))
}

export function patchSettings(payload: object): Promise<unknown> {
  return unwrap(client.PATCH('/api/settings', { body: payload }))
}

export function getLocations(): Promise<unknown> {
  return unwrap(client.GET('/api/locations'))
}

export function createLocation(label: string): Promise<unknown> {
  return unwrap(client.POST('/api/locations', { body: { label } }))
}

export function deleteLocation(id: string): Promise<unknown> {
  return unwrap(client.DELETE('/api/locations/{id}', { params: { path: { id } } }))
}

export function getItems(): Promise<unknown> {
  return unwrap(client.GET('/api/items'))
}

export function getStores(): Promise<unknown> {
  return unwrap(client.GET('/api/stores'))
}

export function createStore(label: string): Promise<unknown> {
  return unwrap(client.POST('/api/stores', { body: { label } }))
}

export function deleteStore(id: string): Promise<unknown> {
  return unwrap(client.DELETE('/api/stores/{id}', { params: { path: { id } } }))
}

export function getAiUsage(signal?: AbortSignal): Promise<unknown> {
  return unwrap(client.GET('/api/ai/usage', { signal }))
}

export type AiUsageRange = '24h' | '7d' | '30d'

export function getAdminAiUsage(range: AiUsageRange, signal?: AbortSignal): Promise<unknown> {
  return unwrap(client.GET('/api/admin/ai/usage', { params: { query: { range } }, signal }))
}

export function testAiKey(
  provider: 'opencode' | 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'custom',
  key?: string,
  baseUrl?: string
): Promise<unknown> {
  return unwrap(client.POST('/api/ai-key/test', { body: { provider, key, base_url: baseUrl } }))
}

export function patchStock(
  id: string,
  payload: {
    qty?: number
    unit?: string
    location_id?: string
    expiry_date?: string
    name?: string
  }
): Promise<unknown> {
  return unwrap(client.PATCH('/api/stock/{id}', { params: { path: { id } }, body: payload }))
}

export function getHome(signal?: AbortSignal): Promise<unknown> {
  return unwrap(client.GET('/api/home', { signal }))
}

export function scanReceipt(file: File): Promise<unknown> {
  const formData = new FormData()
  formData.append('image', file)
  return fetch('/api/purchases/scan', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error((body as { error?: string }).error || `Scan failed: ${res.status}`)
    }
    return res.json()
  })
}

export function createPurchase(payload: {
  date: string
  store_id?: string
  receipt_image_key?: string
  items: { name: string; qty: number; unit: string; price: number; item_id?: string }[]
}): Promise<unknown> {
  return unwrap(client.POST('/api/purchases', { body: payload }))
}

export function getReceiptUrl(purchaseId: string): string {
  return `/api/purchases/${purchaseId}/receipt`
}

export function getPurchases(
  {
    store,
    from,
    to,
    q,
    groupBy,
    limit,
    cursor,
  }: {
    store?: string
    from?: string
    to?: string
    q?: string
    groupBy?: string
    limit?: number
    cursor?: string
  } = {},
  signal?: AbortSignal
): Promise<unknown> {
  return unwrap(
    client.GET('/api/purchases', {
      params: {
        query: {
          store,
          from,
          to,
          q,
          group_by: groupBy as 'month' | 'store' | undefined,
          limit,
          cursor,
        },
      },
      signal,
    })
  )
}

export function getPurchasePatterns(): Promise<unknown> {
  return unwrap(client.GET('/api/purchases/patterns'))
}

export function getPurchase(id: string): Promise<unknown> {
  return unwrap(client.GET('/api/purchases/{id}', { params: { path: { id } } }))
}

export function sendChatMessage(
  message: string,
  history: { role: 'user' | 'assistant'; content: string }[] = []
): Promise<unknown> {
  const body = Array.isArray(history) && history.length > 0 ? { message, history } : { message }
  return unwrap(client.POST('/api/ai/chat', { body }))
}

export function getPlans(
  status: 'active' | 'archived' | 'completed' | 'all' = 'active',
  signal?: AbortSignal
): Promise<unknown> {
  return unwrap(client.GET('/api/plans', { params: { query: { status } }, signal }))
}

export function generatePlan(): Promise<unknown> {
  return unwrap(client.POST('/api/plans/generate', {}))
}

export function savePlan(
  items: {
    name: string
    qty: number
    unit: string
    store_id?: string
    price_estimate?: number
    why?: string
  }[]
): Promise<unknown> {
  return unwrap(client.POST('/api/plans', { body: { items } }))
}

export function updatePlanItem(
  planId: string,
  itemId: string,
  status: 'bought' | 'skipped'
): Promise<unknown> {
  return unwrap(
    client.PATCH('/api/plans/{id}/items/{itemId}', {
      params: { path: { id: planId, itemId } },
      body: { status },
    })
  )
}

export type PriceSort = 'name' | 'cheapest' | 'savings' | 'expiry'

export function getPrices(
  { q, source, sort }: { q?: string; source?: string; sort?: PriceSort } = {},
  signal?: AbortSignal
): Promise<unknown> {
  return unwrap(client.GET('/api/prices', { params: { query: { q, source, sort } }, signal }))
}

// Sorted lists are product-level pages with a `truncated` flag (issue #291);
// the no-sort legacy response (used by usePriceSources) is unchanged.
export function getPricesMeta(signal?: AbortSignal): Promise<unknown> {
  return unwrap(client.GET('/api/prices/meta', { signal }))
}

// Promo catalog (issue #292) — first prices endpoint with a real generated
// response type, so the promos view reads it fully typed.
export function getPromos(signal?: AbortSignal) {
  return unwrap(client.GET('/api/prices/promos', { signal }))
}

// Brochure catalog (issue #293) — grouped brochure images with ≤5 example
// products each; images themselves load via plain <img src> against the
// authenticated /api/brochures proxy, not the typed client.
export function getBrochures(signal?: AbortSignal) {
  return unwrap(client.GET('/api/prices/brochures', { signal }))
}

export function getPriceDetail(productKey: string, signal?: AbortSignal): Promise<unknown> {
  return unwrap(
    client.GET('/api/prices/{productKey}', { params: { path: { productKey } }, signal })
  )
}

export function getPriceRuns(signal?: AbortSignal): Promise<unknown> {
  return unwrap(client.GET('/api/admin/price-runs', { signal }))
}

// Scrape Now (docs/plan/scrape-now.md §4): admin-triggered, store-selectable
// scraping. The POST queues a command the VPS agent claims; commands/events
// feed the live log and the failure-log history. The slug union is DERIVED
// from the codegen'd scrape-command body rather than hand-copied (review
// B3): a new store lands in api-schema.d.ts via `bun run api:codegen`, and
// the existing codegen drift check in ci.sh then fails `vp check` here until
// this type follows — the mirror is CI-guarded for free.
export type ScrapeStoreSlug =
  operations['postApiAdminScrape']['requestBody']['content']['application/json']['stores'][number]

export function getScrapeStores(signal?: AbortSignal): Promise<unknown> {
  return unwrap(client.GET('/api/admin/scrape/stores', { signal }))
}

export function createScrape(stores: ScrapeStoreSlug[]): Promise<unknown> {
  return unwrap(client.POST('/api/admin/scrape', { body: { stores } }))
}

export function getScrapeCommands(
  { limit }: { limit?: number } = {},
  signal?: AbortSignal
): Promise<unknown> {
  return unwrap(client.GET('/api/admin/scrape/commands', { params: { query: { limit } }, signal }))
}

export function getScrapeEvents(
  commandId: string,
  { afterSeq }: { afterSeq?: number } = {},
  signal?: AbortSignal
): Promise<unknown> {
  return unwrap(
    client.GET('/api/admin/scrape/commands/{id}/events', {
      params: {
        path: { id: commandId },
        // The wire type is a digit string; undefined omits it (full log).
        query: { afterSeq: afterSeq === undefined ? undefined : String(afterSeq) },
      },
      signal,
    })
  )
}

// Match review queue (issue #294) — admin-only triage surface for pairs the
// matcher flagged. Decisions are recorded only; they never change price data.

export type ReviewStatusFilter = 'pending' | 'approved' | 'rejected' | 'all'
export type ReviewDecision = 'approved' | 'rejected'

export function getReviewItems(
  { status, limit, offset }: { status?: ReviewStatusFilter; limit?: number; offset?: number } = {},
  signal?: AbortSignal
): Promise<unknown> {
  return unwrap(
    client.GET('/api/admin/review', { params: { query: { status, limit, offset } }, signal })
  )
}

export function decideReviewItem(id: string, decision: ReviewDecision): Promise<unknown> {
  return unwrap(
    client.POST('/api/admin/review/{id}/decision', { params: { path: { id } }, body: { decision } })
  )
}

export function undoReviewDecision(id: string): Promise<unknown> {
  return unwrap(client.DELETE('/api/admin/review/{id}/decision', { params: { path: { id } } }))
}

// The export must bypass the typed client: it downloads a JSON attachment
// (same-origin fetch → blob → anchor download, cookies ride automatically —
// the R2/receipts streaming pattern), not a parsed JSON response.
export async function fetchReviewExport(): Promise<Blob> {
  const res = await fetch('/api/admin/review/export')
  if (!res.ok) {
    throw new ApiError(`Export failed: ${res.status}`, res.status)
  }
  return res.blob()
}
