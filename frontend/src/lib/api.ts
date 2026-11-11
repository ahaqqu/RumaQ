/**
 * RumaQ API client — talks to the Cloudflare Worker backend.
 * All protected endpoints use the rumaq_session cookie (HttpOnly).
 *
 * Built on the typed contract generated from the backend's OpenAPI spec
 * (`bun run api:codegen` → openapi.json → api-client/). Route paths and
 * query parameters are type-checked against the backend; drift between the
 * backend and this client fails `vp check` / CI.
 */
import { client } from './api-client/client.gen.js'
import type { GetApiAdminReviewData, PostApiAdminScrapeData } from './api-client/types.gen.js'
import {
  deleteApiAdminReviewByIdDecision,
  deleteApiAiCapabilitiesByCapability,
  deleteApiAiProvidersById,
  deleteApiCalendarEventsById,
  deleteApiDocumentsById,
  deleteApiDocumentsByIdFilesByFileId,
  deleteApiHouseholdsByIdMembersByMemberId,
  deleteApiLocationsById,
  deleteApiPluginsByPluginIdPurge,
  deleteApiStoresById,
  deleteApiTasksById,
  getApiAdminAiUsage,
  getApiAdminPriceRuns,
  getApiAdminProductsAliasesCandidates,
  getApiAdminProductsByProductKey,
  getApiAdminProductsDuplicates,
  getApiAdminReview,
  getApiAdminReviewMode,
  getApiAdminScrapeCommands,
  getApiAdminScrapeCommandsByIdEvents,
  getApiAdminScrapeStores,
  getApiAiCapabilities,
  getApiAiPresets,
  getApiAiProviders,
  getApiAiUsage,
  getApiAuthEmailStatus,
  getApiCalendar,
  getApiDocuments,
  getApiDocumentsById,
  getApiHealth,
  getApiHome,
  getApiHouseholds,
  getApiHouseholdsByIdInvite,
  getApiHouseholdsByIdMembers,
  getApiItems,
  getApiLocations,
  getApiMe,
  getApiPlans,
  getApiPlugins,
  getApiPrices,
  getApiPricesBrochures,
  getApiPricesByProductKey,
  getApiPricesMeta,
  getApiPricesPromos,
  getApiPurchases,
  getApiPurchasesById,
  getApiPurchasesPatterns,
  getApiSettings,
  getApiStock,
  getApiStores,
  getApiTasks,
  patchApiAiProvidersById,
  patchApiCalendarEventsById,
  patchApiDocumentsById,
  patchApiHouseholdsById,
  patchApiHouseholdsByIdMembersByMemberId,
  patchApiPlansByIdItemsByItemId,
  patchApiSettings,
  patchApiStockById,
  patchApiTasksById,
  postApiAdminProductsAliasesBulkApprove,
  postApiAdminProductsByProductKeyAliasesByAliasIdApprove,
  postApiAdminProductsByProductKeyAliasesByAliasIdReject,
  postApiAdminProductsByProductKeyAuditByAuditIdRevert,
  postApiAdminProductsByProductKeyRename,
  postApiAdminReviewByIdDecision,
  postApiAdminReviewEvaluate,
  postApiAdminScrape,
  postApiAiChat,
  postApiAiGeneratePersona,
  postApiAiProviders,
  postApiAiProvidersByIdTest,
  postApiCalendarEvents,
  postApiDocuments,
  postApiDocumentsByIdFiles,
  postApiDocumentsByIdFilesByFileIdExtractExpiry,
  postApiHouseholds,
  postApiHouseholdsByIdActivate,
  postApiHouseholdsByIdInvite,
  postApiHouseholdsByIdLeave,
  postApiHouseholdsByIdMembers,
  postApiHouseholdsJoin,
  postApiLocations,
  postApiPlans,
  postApiPlansGenerate,
  postApiPluginsByPluginIdPurge,
  postApiPurchases,
  postApiStores,
  postApiTasks,
  postEmailLogin,
  putApiAdminReviewMode,
  putApiAiCapabilitiesByCapability,
  putApiPluginsByPluginIdEnablement,
} from './api-client/index.js'

client.setConfig({ credentials: 'include' })

export class ApiError extends Error {
  readonly status: number
  // Seconds until a rate-limit window resets, when the server sent a
  // Retry-After header — surfaced so the UI can say when to come back
  // instead of inviting an immediate retry into the same window
  // (review T4-B6). null when absent or unparseable.
  readonly retryAfterSeconds: number | null
  // The parsed error body, when the server sent JSON. Most errors only carry
  // `error`, but the canonical product rename/revert 409s are STRUCTURED
  // (conflicts / warnings / current / stale_revert) — the rename form maps
  // those fields to inline copy instead of parsing a message string.
  readonly body: unknown

  constructor(
    message: string,
    status: number,
    retryAfterSeconds: number | null = null,
    body: unknown = undefined
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
    this.body = body
  }
}

// The Retry-After header the 429 responses send (upload and OCR limiters,
// documents.ts / documents-ocr.ts): plain seconds. HTTP-date forms do not
// occur in this API; anything non-numeric degrades to null.
function retryAfterFrom(response: Response): number | null {
  const header = response.headers.get('Retry-After')
  if (header === null) return null
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

async function unwrap<T>(resultPromise: Promise<unknown>): Promise<T> {
  const result = (await resultPromise) as {
    data?: T
    error?: unknown
    // Optional: the generated client leaves it out when the request could not
    // be built at all (invalid body/headers), so there is no response to read.
    response?: Response
  }
  if (!result.response) {
    throw new ApiError('Request failed: could not build request', 0, null, result.error)
  }
  if (result.error !== undefined || !result.response.ok) {
    const body = result.error as { error?: string } | undefined
    throw new ApiError(
      body?.error || `Request failed: ${result.response.status}`,
      result.response.status,
      retryAfterFrom(result.response),
      result.error
    )
  }
  // 204 / empty bodies resolve to `{}` in the generated client; callers of the
  // wrapper have always seen `null` there, so keep that contract explicit.
  if (result.response.status === 204) return null as T
  return (result.data ?? null) as T
}

export function getMe(): Promise<unknown> {
  return unwrap(getApiMe())
}

export function getStock(
  { location, q }: { location?: string; q?: string } = {},
  signal?: AbortSignal
): Promise<unknown> {
  return unwrap(getApiStock({ query: { location, q }, signal }))
}

export function getHealth(): Promise<unknown> {
  return unwrap(getApiHealth())
}

export function login() {
  window.location.href = '/api/auth/login'
}

export async function logout() {
  // POST, not a link (ahaqqu/RumaQ#528 review A1): the session-epoch bump that
  // revokes the token on every device is a state change, and the CSRF guard in
  // backend/src/lib/csrf.ts only covers POST/PUT/PATCH/DELETE. A GET navigation
  // to /api/auth/logout would be forgeable from any site (a top-level GET still
  // carries the SameSite=Lax cookie) and is limited to clearing the cookie.
  // The typed client has no logout path (the backend registers it with `all`,
  // which the generated client does not emit), so this is a plain fetch.
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    window.location.href = '/'
  } catch {
    // POST unreachable (offline, proxy error): fall back to the GET navigation
    // so the cookie is still cleared. The epoch bump is lost, so the token
    // stays valid on other devices — the lesser evil versus a logout that
    // silently leaves the session live.
    window.location.href = '/api/auth/logout'
  }
}

export async function emailAuthStatus(): Promise<{ enabled: boolean }> {
  try {
    return await unwrap<{ enabled: boolean }>(getApiAuthEmailStatus())
  } catch {
    return { enabled: false }
  }
}

export async function emailLogin(email: string, password: string): Promise<unknown> {
  return unwrap(postEmailLogin({ body: { email, password } }))
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
  return unwrap(getApiSettings())
}

export function patchSettings(payload: object): Promise<unknown> {
  return unwrap(patchApiSettings({ body: payload }))
}

export function getLocations(): Promise<unknown> {
  return unwrap(getApiLocations())
}

export function createLocation(label: string): Promise<unknown> {
  return unwrap(postApiLocations({ body: { label } }))
}

export function deleteLocation(id: string): Promise<unknown> {
  return unwrap(deleteApiLocationsById({ path: { id } }))
}

export function getItems(): Promise<unknown> {
  return unwrap(getApiItems())
}

export function getStores(): Promise<unknown> {
  return unwrap(getApiStores())
}

export function createStore(label: string): Promise<unknown> {
  return unwrap(postApiStores({ body: { label } }))
}

export function deleteStore(id: string): Promise<unknown> {
  return unwrap(deleteApiStoresById({ path: { id } }))
}

export function getAiUsage(signal?: AbortSignal): Promise<unknown> {
  return unwrap(getApiAiUsage({ signal }))
}

export type AiUsageRange = '24h' | '7d' | '30d'

export function getAdminAiUsage(range: AiUsageRange, signal?: AbortSignal): Promise<unknown> {
  return unwrap(getApiAdminAiUsage({ query: { range }, signal }))
}

// ─── AI gateway settings (ahaqqu/RumaQ#523 P3, plan §4) ─────────────────────
//
// The provider/capability surface replaces the retired `POST /api/ai-key/test`
// and the legacy `ai_*` fields of PATCH /api/settings. Nothing here ever carries
// key material: `has_key` is the only signal the API returns.

export type AiProviderKind = 'openai-compatible' | 'anthropic' | 'gemini' | 'questions'
export type AiCapability = 'decision' | 'reasoning' | 'vision'
export type AiThinkingLevel = 'low' | 'medium' | 'high'

export type AiProviderPreset = {
  id: string
  label: string
  kind: AiProviderKind
  base_url: string | null
}

export type AiProvider = {
  id: string
  label: string
  kind: AiProviderKind
  preset: string | null
  base_url: string | null
  default_model: string | null
  has_key: boolean
  created_at: string
  updated_at: string
}

export type AiProviderList = {
  can_manage: boolean
  managed_by: string | null
  providers: AiProvider[]
}

export type AiCapabilityAssignment = {
  provider_id: string | null
  provider_label: string | null
  /** The assignment's own model; null = inherit the provider default. */
  model: string | null
  /** What the resolver will call: `model ?? provider.default_model`. */
  effective_model: string | null
  thinking_level: string | null
  source: 'household' | 'none'
}

export type AiCapabilityConfig = {
  can_manage: boolean
  capabilities: Record<AiCapability, AiCapabilityAssignment>
  status: Record<AiCapability, 'household' | 'none'>
}

export type AiProviderTestResult = { ok: boolean; code?: string }

export function getAiPresets(): Promise<{ presets: AiProviderPreset[] }> {
  return unwrap(getApiAiPresets())
}

export function getAiProviders(): Promise<AiProviderList> {
  return unwrap(getApiAiProviders())
}

export function createAiProvider(payload: {
  label: string
  kind: AiProviderKind
  preset?: string
  base_url?: string
  default_model?: string
  api_key: string
}): Promise<{ provider: AiProvider }> {
  return unwrap(postApiAiProviders({ body: payload }))
}

export function updateAiProvider(
  id: string,
  payload: {
    label?: string
    kind?: AiProviderKind
    base_url?: string
    default_model?: string
    api_key?: string
  }
): Promise<{ provider: AiProvider }> {
  return unwrap(patchApiAiProvidersById({ path: { id }, body: payload }))
}

export function deleteAiProvider(id: string): Promise<{ cleared: AiCapability[] }> {
  return unwrap(deleteApiAiProvidersById({ path: { id } }))
}

export function testAiProvider(id: string): Promise<AiProviderTestResult> {
  return unwrap(postApiAiProvidersByIdTest({ path: { id } }))
}

/**
 * The persona rewrite (#523 P5, plan §6 P5): the only way the browser gets
 * AI-written app copy. The payload carries the two role names, the language and
 * the built-in strings the UI renders — never a provider, an endpoint or a key.
 * The server builds the prompt (roles and copy as data), dispatches the
 * household's `reasoning` assignment behind the door and records a usage row.
 *
 * 402 = the household has no usable reasoning assignment; the persona keeps its
 * built-in copy, so the caller treats it as a normal state.
 */
export function generateAiPersonaCopy(payload: {
  user_role: string
  ai_role: string
  language: 'en' | 'id'
  copy: Partial<Record<string, string>>
}): Promise<{ copy: Record<string, string> }> {
  return unwrap(postApiAiGeneratePersona({ body: payload }))
}

export function getAiCapabilities(): Promise<AiCapabilityConfig> {
  return unwrap(getApiAiCapabilities())
}

export function assignAiCapability(
  capability: AiCapability,
  payload: { provider_id: string; model?: string; thinking_level?: AiThinkingLevel | '' }
): Promise<{ capability: AiCapabilityAssignment; status: 'household' | 'none' }> {
  return unwrap(putApiAiCapabilitiesByCapability({ path: { capability }, body: payload }))
}

export function clearAiCapability(
  capability: AiCapability
): Promise<{ capability: AiCapabilityAssignment; status: 'household' | 'none' }> {
  return unwrap(deleteApiAiCapabilitiesByCapability({ path: { capability } }))
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
  return unwrap(patchApiStockById({ path: { id }, body: payload }))
}

export function getHome(signal?: AbortSignal): Promise<unknown> {
  return unwrap(getApiHome({ signal }))
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
  items: {
    name: string
    qty: number
    unit: string
    price: number
    // The receipt's printed line total (#518) — persisted as given; absent →
    // the server computes qty × price.
    line_total?: number | null
    item_id?: string
  }[]
}): Promise<unknown> {
  return unwrap(postApiPurchases({ body: payload }))
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
    getApiPurchases({
      query: {
        store,
        from,
        to,
        q,
        group_by: groupBy as 'month' | 'store' | undefined,
        limit,
        cursor,
      },
      signal,
    })
  )
}

export function getPurchasePatterns(): Promise<unknown> {
  return unwrap(getApiPurchasesPatterns())
}

export function getPurchase(id: string): Promise<unknown> {
  return unwrap(getApiPurchasesById({ path: { id } }))
}

export function sendChatMessage(
  message: string,
  history: { role: 'user' | 'assistant'; content: string }[] = []
): Promise<unknown> {
  const body = Array.isArray(history) && history.length > 0 ? { message, history } : { message }
  return unwrap(postApiAiChat({ body }))
}

export function getPlans(
  status: 'active' | 'archived' | 'completed' | 'all' = 'active',
  signal?: AbortSignal
): Promise<unknown> {
  return unwrap(getApiPlans({ query: { status }, signal }))
}

export function generatePlan(): Promise<unknown> {
  return unwrap(postApiPlansGenerate())
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
  return unwrap(postApiPlans({ body: { items } }))
}

export function updatePlanItem(
  planId: string,
  itemId: string,
  status: 'bought' | 'skipped'
): Promise<unknown> {
  return unwrap(patchApiPlansByIdItemsByItemId({ path: { id: planId, itemId }, body: { status } }))
}

export type PriceSort = 'name' | 'cheapest' | 'savings' | 'expiry'

export function getPrices(
  {
    q,
    source,
    category,
    sort,
  }: { q?: string; source?: string; category?: string; sort?: PriceSort } = {},
  signal?: AbortSignal
): Promise<unknown> {
  return unwrap(getApiPrices({ query: { q, source, category, sort }, signal }))
}

// Sorted lists are product-level pages with a `truncated` flag (issue #291);
// the no-sort legacy response (used by usePriceSources) is unchanged.
export function getPricesMeta(signal?: AbortSignal): Promise<unknown> {
  return unwrap(getApiPricesMeta({ signal }))
}

// Promo catalog (issue #292) — first prices endpoint with a real generated
// response type, so the promos view reads it fully typed.
export function getPromos(signal?: AbortSignal) {
  return unwrap(getApiPricesPromos({ signal }))
}

// Brochure catalog (issue #293) — grouped brochure images with ≤5 example
// products each; images themselves load via plain <img src> against the
// authenticated /api/brochures proxy, not the typed client.
export function getBrochures(signal?: AbortSignal) {
  return unwrap(getApiPricesBrochures({ signal }))
}

export function getPriceDetail(productKey: string, signal?: AbortSignal): Promise<unknown> {
  return unwrap(getApiPricesByProductKey({ path: { productKey }, signal }))
}

export function getPriceRuns(signal?: AbortSignal): Promise<unknown> {
  return unwrap(getApiAdminPriceRuns({ signal }))
}

// Scrape Now (docs/plan/scrape-now.md §4): admin-triggered, store-selectable
// scraping. The POST queues a command the VPS agent claims; commands/events
// feed the live log and the failure-log history. The slug union is DERIVED
// from the codegen'd scrape-command body rather than hand-copied (review
// B3): a new store lands in api-client/types.gen.ts via `bun run api:codegen`,
// and the existing codegen drift check in ci.sh then fails `vp check` here
// until this type follows — the mirror is CI-guarded for free.
export type ScrapeStoreSlug = PostApiAdminScrapeData['body']['stores'][number]

export function getScrapeStores(signal?: AbortSignal): Promise<unknown> {
  return unwrap(getApiAdminScrapeStores({ signal }))
}

export function createScrape(stores: ScrapeStoreSlug[]): Promise<unknown> {
  return unwrap(postApiAdminScrape({ body: { stores } }))
}

export function getScrapeCommands(
  { limit }: { limit?: number } = {},
  signal?: AbortSignal
): Promise<unknown> {
  return unwrap(getApiAdminScrapeCommands({ query: { limit }, signal }))
}

export function getScrapeEvents(
  commandId: string,
  { afterSeq }: { afterSeq?: number } = {},
  signal?: AbortSignal
): Promise<unknown> {
  return unwrap(
    getApiAdminScrapeCommandsByIdEvents({
      path: { id: commandId },
      // The wire type is a digit string; undefined omits it (full log).
      query: { afterSeq: afterSeq === undefined ? undefined : String(afterSeq) },
      signal,
    })
  )
}

// Match review queue (issue #294) — admin-only triage surface for pairs the
// matcher flagged. Decisions are recorded only; they never change price data.

export type ReviewStatusFilter = 'pending' | 'approved' | 'rejected' | 'all'

// The flag-reason vocabulary (issue #628). The backend owns it (REVIEW_REASONS
// in backend/src/lib/match-review.ts) and the generated query type mirrors it;
// this ONE runtime list is what the review page's filter chips iterate, and
// `satisfies` keeps every value a valid generated reason. A test pins it to the
// committed OpenAPI spec, so a fourth backend reason cannot leave the UI
// silently offering the old three.
type GeneratedReviewReason = Exclude<
  NonNullable<GetApiAdminReviewData['query']>['reason'],
  undefined
>
export const REVIEW_REASONS = [
  'price_ratio',
  'verifier_unresolved',
  'taxonomy',
] as const satisfies readonly GeneratedReviewReason[]

export type ReviewReasonFilter = (typeof REVIEW_REASONS)[number]
export type ReviewDecision = 'approved' | 'rejected'
// Issue #484: how the AI assists the queue, and how a human's decision
// relates to the cached AI verdict (the agreement history).
export type ReviewMode = 'manual' | 'assist' | 'auto'
export type ReviewAgreement = 'agreed' | 'disagreed'

export function getReviewItems(
  {
    status,
    reason,
    limit,
    offset,
  }: {
    status?: ReviewStatusFilter
    reason?: ReviewReasonFilter
    limit?: number
    offset?: number
  } = {},
  signal?: AbortSignal
): Promise<unknown> {
  return unwrap(getApiAdminReview({ query: { status, reason, limit, offset }, signal }))
}

export function decideReviewItem(
  id: string,
  decision: ReviewDecision,
  agreement?: ReviewAgreement
): Promise<unknown> {
  return unwrap(
    postApiAdminReviewByIdDecision({
      path: { id },
      body: agreement ? { decision, agreement } : { decision },
    })
  )
}

// AI review (issue #484, backend PR 1): the global mode switch and the
// bounded on-demand evaluation. Neither is ever called on the list path —
// the queue renders cached verdicts only. Manual mode is the zero-call gate
// (the evaluate route also refuses it server-side).
export function getReviewMode(signal?: AbortSignal): Promise<unknown> {
  return unwrap(getApiAdminReviewMode({ signal }))
}

export function setReviewMode(mode: ReviewMode): Promise<unknown> {
  return unwrap(putApiAdminReviewMode({ body: { mode } }))
}

export function evaluateReviewItems(limit: number): Promise<unknown> {
  return unwrap(postApiAdminReviewEvaluate({ body: { limit } }))
}

export function undoReviewDecision(id: string): Promise<unknown> {
  return unwrap(deleteApiAdminReviewByIdDecision({ path: { id } }))
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

// ---------------------------------------------------------------------------
// Admin canonical products (ahaqqu/RumaQ#423). The identity is the rename
// form's source of truth: the canonical row (with the optimistic
// `metadataVersion` every rename must send back), every alias as evidence,
// observation stats, and the last 10 audit rows newest first. The route's 409
// bodies are structured (conflicts / warnings / current), which is why
// ApiError carries the parsed body. Shapes mirror the backend's
// PRODUCT_IDENTITY_SCHEMA (backend/src/apps/api.ts) — the generated schema
// keeps every field optional, so the required fields are narrowed once here.
// ---------------------------------------------------------------------------

export type ProductStatus = 'canonical' | 'provisional' | 'needs_review'
export type ProductAliasStatus = 'candidate' | 'approved' | 'rejected'
export type ProductAliasSource = 'ocr' | 'catalog' | 'admin'

export type CanonicalProduct = {
  id: string
  productKey: string
  name: string
  brand: string | null
  unit: string | null
  status: ProductStatus
  metadataVersion: number
  firstSeenAt: string | null
  lastSeenAt: string | null
  updatedAt: string | null
}

export type ProductAlias = {
  // The handle the approve/reject routes take (PR 2's action target); the
  // identity route returns it for every alias.
  id: string
  name: string
  storeSlug: string
  status: ProductAliasStatus
  source: ProductAliasSource
  firstSeenAt: string
  lastSeenAt: string
}

export type ProductAuditEntry = {
  id: string
  action: 'rename' | 'revert'
  oldName: string
  newName: string
  reason: string | null
  actorUserId: string
  metadataVersionBefore: number
  metadataVersionAfter: number
  revertsAuditId: string | null
  createdAt: string
}

export type ProductIdentity = {
  product: CanonicalProduct
  aliases: ProductAlias[]
  stats: { observations: number; stores: number }
  audit: ProductAuditEntry[]
}

export type RenameProductBody = {
  canonicalName: string
  expectedMetadataVersion: number
  reason?: string
  acknowledgeWarnings?: boolean
}

// 409 duplicate_name payload: another product (or its approved alias) already
// carries the name. There is deliberately no acknowledge path.
export type RenameConflict = { productKey: string; name: string; source: 'product' | 'alias' }

// 409 similar_name payload, and the `warnings` a successful overridden rename
// returns: near-duplicates the admin chose to keep as separate products.
export type SimilarNameWarning = { productKey: string; name: string; similarity: number }

// 200 body of both canonical writes. `indexVersion` is the canonical-index
// version the pipeline reads on its next run.
export type ProductMutationResult = {
  product: CanonicalProduct
  warnings: SimilarNameWarning[]
  audit: ProductAuditEntry[]
  indexVersion: number
}

export function getAdminProduct(
  productKey: string,
  signal?: AbortSignal
): Promise<ProductIdentity> {
  return unwrap(getApiAdminProductsByProductKey({ path: { productKey }, signal }))
}

export function renameProduct(
  productKey: string,
  body: RenameProductBody
): Promise<ProductMutationResult> {
  return unwrap(postApiAdminProductsByProductKeyRename({ path: { productKey }, body }))
}

// Reverts the LATEST rename only (linear history): the backend 409s with
// `stale_revert` for an older rename or a second compensation.
export function revertProductRename(
  productKey: string,
  auditId: string,
  body: { reason?: string } = {}
): Promise<ProductMutationResult> {
  return unwrap(
    postApiAdminProductsByProductKeyAuditByAuditIdRevert({ path: { productKey, auditId }, body })
  )
}

// Read-only duplicate-name report (ahaqqu/RumaQ#485). The admin surfaces the
// canonical products that share a name case-insensitively — the collisions a
// rename racing an ingest, or a rename inside the pipeline's cached-index
// window, can leave behind. Nothing here is enforced or merged; the route is
// a pure read (no index bump). Shapes mirror DUPLICATE_NAME_REPORT_SCHEMA in
// backend/src/apps/api.ts — the generated schema keeps every field optional,
// so the required fields are narrowed once here.
export type DuplicateNameProduct = {
  productKey: string
  name: string
  status: ProductStatus
  updatedAt: string | null
  stores: string[]
  primaryStore: string | null
}

export type DuplicateNameGroup = {
  normalizedName: string
  displayName: string
  productCount: number
  products: DuplicateNameProduct[]
}

export type DuplicateNameReport = {
  limit: number
  truncated: boolean
  groups: DuplicateNameGroup[]
}

export function getDuplicateProductNames(signal?: AbortSignal): Promise<DuplicateNameReport> {
  return unwrap(getApiAdminProductsDuplicates({ signal }))
}

// Candidate-alias decisions (#489). The alias id the identity payload carries
// is the whole request — no body, the verb is the decision. Approve admits the
// store spelling to the canonical index and returns the bumped version; reject
// records the refusal and returns the unchanged version.
export type AliasDecisionAction = 'approve' | 'reject'

export type AliasDecisionResult = {
  alias: ProductAlias
  indexVersion: number
}

export function approveProductAlias(
  productKey: string,
  aliasId: string
): Promise<AliasDecisionResult> {
  return unwrap(
    postApiAdminProductsByProductKeyAliasesByAliasIdApprove({ path: { productKey, aliasId } })
  )
}

export function rejectProductAlias(
  productKey: string,
  aliasId: string
): Promise<AliasDecisionResult> {
  return unwrap(
    postApiAdminProductsByProductKeyAliasesByAliasIdReject({ path: { productKey, aliasId } })
  )
}

// Bulk exact-name alias approval (#515, follow-up to #489). One safe
// catalog-wide action: approve only the candidate aliases whose name exactly
// equals their OWN product's canonical name (case-insensitive, the backend's
// NOCASE equality); every whitespace/wording variant stays a manual decision.
// The counts read drives the panel before the action; the mutation returns the
// run receipt. Shapes mirror ALIAS_CANDIDATE_COUNTS_SCHEMA and
// ALIAS_BULK_APPROVE_SCHEMA in backend/src/apps/api.ts.
export type AliasCandidateCounts = {
  candidates: number
  exactCandidates: number
}

export type AliasBulkApproveResult = {
  exactCandidates: number
  approved: number
  remainingCandidates: number
  indexVersion: number
}

export function getAliasCandidateCounts(signal?: AbortSignal): Promise<AliasCandidateCounts> {
  return unwrap(getApiAdminProductsAliasesCandidates({ signal }))
}

// No body: the action is catalog-wide and has nothing to parameterize. The
// route accepts an absent body (or an empty one) and is idempotent, so a retry
// after a partial 500 continues instead of double-writing.
export function bulkApproveExactAliases(): Promise<AliasBulkApproveResult> {
  return unwrap(postApiAdminProductsAliasesBulkApprove())
}

// ---------------------------------------------------------------------------
// Households (issue #331) — member management, invites, active-household
// switching. Shapes mirror the backend's households app; member profile
// fields (display_name, birth_date) are additive-nullish per the contract.
// ---------------------------------------------------------------------------

export function getHouseholds(signal?: AbortSignal): Promise<unknown> {
  return unwrap(getApiHouseholds({ signal }))
}

export function createHousehold(name: string): Promise<unknown> {
  return unwrap(postApiHouseholds({ body: { name } }))
}

export function renameHousehold(id: string, name: string): Promise<unknown> {
  return unwrap(patchApiHouseholdsById({ path: { id }, body: { name } }))
}

export function activateHousehold(id: string): Promise<unknown> {
  return unwrap(postApiHouseholdsByIdActivate({ path: { id } }))
}

export function getHouseholdMembers(id: string, signal?: AbortSignal): Promise<unknown> {
  return unwrap(getApiHouseholdsByIdMembers({ path: { id }, signal }))
}

// Profile-only member creation (ahaqqu/RumaQ#388): a person with no account —
// display_name is the identity, birth_date optional. Owner-only server-side.
export function createHouseholdMember(
  id: string,
  payload: { display_name: string; birth_date?: string | null }
): Promise<unknown> {
  return unwrap(postApiHouseholdsByIdMembers({ path: { id }, body: payload }))
}

// Member-addressed surfaces take the surrogate member id (0021) — profile-only
// members have no user_id to key on.
export function updateHouseholdMember(
  id: string,
  memberId: string,
  payload: { display_name?: string | null; birth_date?: string | null }
): Promise<unknown> {
  return unwrap(patchApiHouseholdsByIdMembersByMemberId({ path: { id, memberId }, body: payload }))
}

export function removeHouseholdMember(id: string, memberId: string): Promise<unknown> {
  return unwrap(deleteApiHouseholdsByIdMembersByMemberId({ path: { id, memberId } }))
}

export function leaveHousehold(id: string): Promise<unknown> {
  return unwrap(postApiHouseholdsByIdLeave({ path: { id } }))
}

export function getHouseholdInvite(id: string, signal?: AbortSignal): Promise<unknown> {
  return unwrap(getApiHouseholdsByIdInvite({ path: { id }, signal }))
}

// The optional payload marks the invite for one profile-only member
// (ahaqqu/RumaQ#397); undefined = plain invite (today's bodyless POST).
export function createHouseholdInvite(
  id: string,
  payload?: { target_member_id?: string | null }
): Promise<unknown> {
  return unwrap(
    postApiHouseholdsByIdInvite({ path: { id }, ...(payload ? { body: payload } : {}) })
  )
}

export function joinHousehold(code: string): Promise<unknown> {
  return unwrap(postApiHouseholdsJoin({ body: { code } }))
}

// ---------------------------------------------------------------------------
// Plugin settings catalog (ahaqqu/RumaQ#437 — plugin architecture ticket 3).
// Keyed to the ACTIVE household server-side (auth middleware), the same
// household /api/me advertises enabledPlugins for — the catalog, the toggle
// and the nav gating always describe the same household.
// ---------------------------------------------------------------------------

export function getPluginCatalog(signal?: AbortSignal): Promise<unknown> {
  return unwrap(getApiPlugins({ signal }))
}

export function setPluginEnablement(
  pluginId: string,
  status: 'enabled' | 'disabled'
): Promise<unknown> {
  return unwrap(putApiPluginsByPluginIdEnablement({ path: { pluginId }, body: { status } }))
}

// The purge initiation (ticket 5, #439): the typed confirmation rides the
// body; the server re-checks it against the manifest name (never trust the
// client). Nothing is deleted by this call — it marks the drain 'pending';
// the nightly chunk driver does the bytes-before-rows work.
export function requestPluginPurge(pluginId: string, confirm: string): Promise<unknown> {
  return unwrap(postApiPluginsByPluginIdPurge({ path: { pluginId }, body: { confirm } }))
}

// The purge cancel (P1-A3 fix round, PR #474 review): the owner's release
// lever for a drain that can never complete. Nothing is deleted or restored
// by this call — the drain stops where it is and the write gate releases.
export function cancelPluginPurge(pluginId: string): Promise<unknown> {
  return unwrap(deleteApiPluginsByPluginIdPurge({ path: { pluginId } }))
}

// The per-plugin archive export (ticket 6, #440): an owner-only ZIP download
// of the plugin's data for the ACTIVE household — the export-before-purge
// capability. Hand-written like fetchReviewExport: the typed client's JSON
// unwrap has no blob path, and archive bytes must land in a Blob, never be
// parsed as JSON. A vault over the per-archive file budget chains sequential
// archives: the response's X-Export-Next-Cursor header carries the
// continuation cursor — when present, send it back as ?cursor= until the
// header is absent. The cursor is bound to the issuing household; a foreign
// one is a 400.
export async function fetchPluginExport(
  pluginId: string,
  cursor?: string,
  signal?: AbortSignal
): Promise<{ blob: Blob; nextCursor: string | null }> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  const res = await fetch(`/api/plugins/${pluginId}/export${query}`, { signal })
  if (!res.ok) {
    throw new ApiError(`Export failed: ${res.status}`, res.status)
  }
  return { blob: await res.blob(), nextCursor: res.headers.get('X-Export-Next-Cursor') }
}

// ---------------------------------------------------------------------------
// Document vault (ahaqqu/RumaQ#422 rework of the #388 MVP) — private
// per-household documents with free-text names and N files each. Metadata
// rides the typed client; the per-file content endpoint bypasses it
// (fetchReviewExport pattern): the typed client's JSON unwrap has no blob
// path, and document bytes must stream into blob URLs — never parse as JSON.
// No public or presigned URLs exist anywhere; every byte read is a
// cookie-authenticated, same-origin fetch.
// ---------------------------------------------------------------------------

// Same caps as the backend (plugins/documents/lib.ts) — the client
// pre-checks exist to fail fast before bytes ever leave the device.
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024
export const DOCUMENT_MAX_FILES = 20
export const DOCUMENT_NAME_MAX = 120
// The #426 remind-window default + bounds (plugins/documents/lib.ts owns
// the rule; the client mirrors them for its edit form pre-checks and the
// due-soon derivation, and the server re-validates — never trust the
// client).
export const DOCUMENT_DEFAULT_REMIND_DAYS = 30
export const DOCUMENT_REMIND_DAYS_MIN = 1
export const DOCUMENT_REMIND_DAYS_MAX = 365

// Client-side magic-byte sniff over the FIRST bytes of a picked file (the
// same signature table as the backend's sniffDocumentMime). The `accept=`
// attribute only filters the OS picker — a renamed .txt still reaches the
// upload loop and would 415 MID-SEQUENCE, stranding a partially-uploaded
// document. Sniffing the picked batch up front rejects it before anything is
// created; the server re-sniffs (never trust the client). Returns the mime
// the bytes claim, or null when the head matches nothing allowed.
export function sniffDocumentMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return 'application/pdf'
  }
  return null
}

export function getDocuments(
  { q, memberId, expiringWithin }: { q?: string; memberId?: string; expiringWithin?: number } = {},
  signal?: AbortSignal
): Promise<unknown> {
  return unwrap(
    getApiDocuments({ query: { q, memberId, expiring_within: expiringWithin }, signal })
  )
}

// Create = the free-text name + the FIRST file (its optional label rides the
// same multipart). Later files go through addDocumentFile so upload order is
// deterministic.
export function createDocument({
  name,
  file,
  label,
  memberId,
}: {
  name: string
  file: File
  label?: string
  memberId?: string
}): Promise<unknown> {
  // The body is a plain object: the generated client's multipart serializer
  // builds the FormData (and the boundary header) from it. Passing a
  // pre-built FormData would serialise to an EMPTY body — FormData has no own
  // enumerable entries.
  return unwrap(postApiDocuments({ body: { name, file, label, memberId } }))
}

export function addDocumentFile(documentId: string, file: File, label?: string): Promise<unknown> {
  return unwrap(postApiDocumentsByIdFiles({ path: { id: documentId }, body: { file, label } }))
}

export function deleteDocument(id: string): Promise<unknown> {
  return unwrap(deleteApiDocumentsById({ path: { id } }))
}

// Expiry metadata update (#426): expires_on as an ISO date or null to clear
// (clearing also clears the remind window server-side), remind_days_before
// as a 1..365 integer. The backend owns every rule (defaults, cross-field
// checks, the 'update' audit record); the client just sends the shape.
export function updateDocumentExpiry(
  id: string,
  payload: { expires_on?: string | null; remind_days_before?: number }
): Promise<unknown> {
  return unwrap(patchApiDocumentsById({ path: { id }, body: payload }))
}

export function deleteDocumentFile(documentId: string, fileId: string): Promise<unknown> {
  return unwrap(deleteApiDocumentsByIdFilesByFileId({ path: { id: documentId, fileId } }))
}

// Expiry-date OCR (issue #433): the backend reads the file with the USER'S
// OWN AI provider (vision model: ai_vision_model → ai_model; server fallback)
// and returns a SUGGESTION. Nothing is written server-side — the answer only
// becomes data when the user saves it through updateDocumentExpiry.
export function extractDocumentExpiry(
  documentId: string,
  fileId: string
): Promise<{ expires_on: string | null; model: string | null }> {
  return unwrap(
    postApiDocumentsByIdFilesByFileIdExtractExpiry({ path: { id: documentId, fileId } })
  )
}

export function getDocumentMeta(id: string, signal?: AbortSignal): Promise<unknown> {
  return unwrap(getApiDocumentsById({ path: { id }, signal }))
}

// The binary content endpoint, PER FILE — hand-written (see the section note
// above). disposition=inline previews (audited as a view server-side),
// disposition=attachment downloads (audited as a download).
export async function fetchDocumentContent(
  documentId: string,
  fileId: string,
  disposition: 'inline' | 'attachment',
  signal?: AbortSignal
): Promise<Blob> {
  const params = new URLSearchParams({ disposition })
  const res = await fetch(
    `/api/documents/${documentId}/files/${fileId}/content?${params.toString()}`,
    { signal }
  )
  if (!res.ok) {
    throw new ApiError(`Document content failed: ${res.status}`, res.status)
  }
  return res.blob()
}

// ---------------------------------------------------------------------------
// Household tasks (ahaqqu/RumaQ#429) — per-member family task assignments.
// Tasks scope to the active household; assignee ids are the surrogate member
// ids (both modes — linked accounts and profile-only members, 0021).
// ---------------------------------------------------------------------------

export type TaskRecurrence = 'daily' | 'weekly' | 'monthly'

export type TaskListFilters = {
  // 'me' resolves to the caller's member row server-side; any member id
  // filters the board to that person; 'all' (or absent) is the whole board.
  assignee?: string
  status?: 'open' | 'done' | 'all'
  // The "My tasks" sugar — wins over assignee on the backend.
  mine?: '1'
}

export function getTasks(filters: TaskListFilters = {}, signal?: AbortSignal): Promise<unknown> {
  return unwrap(
    getApiTasks({
      query: { assignee: filters.assignee, status: filters.status, mine: filters.mine },
      signal,
    })
  )
}

export function createTask(payload: {
  title: string
  assignee_member_id?: string | null
  due_date?: string | null
  recurrence?: TaskRecurrence | null
}): Promise<unknown> {
  return unwrap(postApiTasks({ body: payload }))
}

// One PATCH endpoint, three actions (the backend contract): edit fields;
// complete with { status: 'done' } alone; approve with { approve: true }
// alone. Mixing actions in one call is a 400 — the page keeps them separate.
export function patchTask(
  id: string,
  payload: {
    title?: string
    due_date?: string | null
    recurrence?: TaskRecurrence | null
    assignee_member_id?: string | null
    status?: 'done'
    approve?: true
  }
): Promise<unknown> {
  return unwrap(patchApiTasksById({ path: { id }, body: payload }))
}

export function deleteTask(id: string): Promise<unknown> {
  return unwrap(deleteApiTasksById({ path: { id } }))
}

// ---------------------------------------------------------------------------
// Household calendar (ahaqqu/RumaQ#430) — the shared family calendar. ONE
// read surface: GET /api/calendar returns the day-ordered UNION of stored
// events (kind: 'event') and derived document-deadline entries (kind:
// 'deadline' — the #426 expiry metadata surfacing automatically, never
// stored). Stored-event CRUD rides /api/calendar/events. Visibility ids are
// the surrogate member ids (both modes, 0021).
// ---------------------------------------------------------------------------

export type CalendarVisibility = 'all' | 'members'

export type CalendarListFilters = {
  // The window bounds, inclusive ISO dates (YYYY-MM-DD); absent = unbounded
  // on that side. The month view sends [first, last] of the visible month.
  from?: string
  to?: string
}

export function getCalendar(
  filters: CalendarListFilters = {},
  signal?: AbortSignal
): Promise<unknown> {
  return unwrap(getApiCalendar({ query: { from: filters.from, to: filters.to }, signal }))
}

export function createCalendarEvent(payload: {
  title: string
  date: string
  time?: string | null
  visibility?: CalendarVisibility
  member_ids?: string[]
}): Promise<unknown> {
  return unwrap(postApiCalendarEvents({ body: payload }))
}

export function patchCalendarEvent(
  id: string,
  payload: {
    title?: string
    date?: string
    time?: string | null
    visibility?: CalendarVisibility
    member_ids?: string[]
  }
): Promise<unknown> {
  return unwrap(patchApiCalendarEventsById({ path: { id }, body: payload }))
}

export function deleteCalendarEvent(id: string): Promise<unknown> {
  return unwrap(deleteApiCalendarEventsById({ path: { id } }))
}
