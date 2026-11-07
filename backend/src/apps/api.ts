import { Hono } from 'hono'
import { logger } from 'hono/logger'
import type { Context, MiddlewareHandler } from 'hono'

import { sValidator } from '@hono/standard-validator'
import { openAPIRouteHandler, describeRoute } from 'hono-openapi'
import type { OpenAPIV3_1 } from 'openapi-types'
import {
  object,
  string,
  optional,
  picklist,
  number,
  integer,
  minValue,
  maxValue,
  maxLength,
  minLength,
  pipe,
  regex,
  transform,
  boolean,
} from 'valibot'
import {
  SCRAPE_STORE_SLUGS,
  backfillCategoriesPayloadSchema,
  scrapeCommandCreateSchema,
  scrapeEventsPostSchema,
  scrapeFinishSchema,
  validateIngestV2,
} from '@rumaq/contract'
import type { Env } from '../types.js'
import { createCors } from '../cors.js'
import { isApiPath } from '../plugins/core-prefixes.js'
import { propsAuthMiddleware } from '../auth.js'
import { timingSafeEqualStrings } from '../lib/crypto.js'
import { runReportSchema, getPricesStatus } from '../lib/ingest.js'
import {
  CanonicalIndexIntegrityError,
  getCanonicalIndex,
  ingestPricesV2,
} from '../lib/ingest-v2.js'
import {
  LATEST_OBSERVATION_SUBQUERY,
  LATEST_OBSERVATION_PREDICATE,
  getPromoCatalog,
  listPriceCategories,
} from '../lib/prices.js'
import { applyCategoryBackfill, listUncategorizedProducts } from '../lib/taxonomy-backfill.js'
import {
  BROCHURE_CONTENT_TYPES,
  BROCHURE_MAX_BYTES,
  getBrochureCatalog,
  parseBrochureKey,
  sweepUnreferencedBrochures,
} from '../lib/brochures.js'
import { requireEntitlement, type Entitlement } from '../lib/entitlements.js'
import {
  appendScrapeEvents,
  claimNextScrapeCommand,
  createScrapeCommand,
  finishScrapeCommand,
  listScrapeCommands,
  listScrapeEvents,
  ScrapeConflictError,
  ScrapeNotFoundError,
} from '../lib/scrape.js'
import { recordRunReport, listPriceRuns } from '../lib/price-runs.js'
import {
  REVIEW_REASONS,
  recordReviewItems,
  listReviewItems,
  decideReviewItem,
  undoReviewDecision,
  exportReviewDecisions,
} from '../lib/match-review.js'
import {
  REVIEW_AUTO_MIN_CONFIDENCE,
  REVIEW_EVALUATE_MAX,
  REVIEW_MODES,
  REVIEW_SWITCH_SWEEP_LIMIT,
  type ReviewMode,
  applyCachedAutoVerdicts,
  evaluatePendingReviews,
  getReviewMode,
  resolveReviewAiAccess,
  runReviewAiSweep,
  setReviewMode,
} from '../lib/review-ai.js'
import {
  AliasNotFoundError,
  AliasStateError,
  AuditNotFoundError,
  BulkAliasApproveError,
  DuplicateNameError,
  InvalidNameError,
  InvalidReasonError,
  ProductNotFoundError,
  SimilarNameError,
  StaleProductError,
  StaleRevertError,
  approveAlias,
  bulkApproveExactNameAliases,
  countAliasCandidates,
  getDuplicateNameReport,
  getProductIdentity,
  rejectAlias,
  renameProduct,
  revertProductRename,
} from '../lib/canonical-products.js'
import { requireAdmin } from '../lib/admin.js'
import { groundPlanItem } from '../lib/grounding.js'
import { escapeLike } from '../lib/sql.js'
import { ipRateLimitMiddleware } from '../lib/rate-limit.js'
import { resolveEnabledPluginIds } from '../plugins/enablement.js'
import { PLUGIN_MANIFESTS } from '../plugins/manifests.js'
import { computeRunOutDays } from '../lib/stock.js'
import { computePatterns } from '../lib/patterns.js'
import {
  validateImage,
  buildKey,
  uploadReceipt,
  getSignedUrl,
  extFromType,
} from '../lib/receipts.js'
import {
  AiError,
  EMPTY_USAGE,
  recordAiUsageEvent,
  resolveAccess,
  vision,
  type AiCall,
  type TokenUsage,
} from '../lib/ai/index.js'
import {
  generatePersonaCopy,
  PERSONA_COPY_KEYS,
  type PersonaCopyInput,
  type PersonaCopyLanguage,
} from '../lib/persona.js'
import { loadHouseholdAiConfig } from '../lib/ai/capabilities.js'
import { buildScanPrompt, parseScanResult } from '../lib/receipt-scan.js'
import {
  AiProviderSettingsError,
  assignCapability,
  clearCapability,
  createProvider,
  deleteProvider,
  listPresets,
  listProviders,
  testProvider,
  updateProvider,
} from '../lib/ai/provider-settings.js'
import {
  HouseholdForbiddenError,
  HouseholdNotFoundError,
  getMembership,
  requireOwner,
} from '../lib/households.js'
import { isRateLimited } from '../lib/rate-limit.js'
import { sendChatMessage } from '../lib/chat.js'
import {
  settingsPatchSchema,
  locationSchema,
  storeSchema,
  aiProviderCreateSchema,
  aiProviderPatchSchema,
  aiCapabilityAssignSchema,
  personaCopySchema,
  stockPatchSchema,
  purchaseCreateSchema,
  chatSchema,
} from '../schemas.js'
import {
  planItemPatchSchema,
  planCreateSchema,
  generateAiPlan,
  normalizeItemName,
} from '../lib/plans.js'

const stockQuery = object({
  location: optional(string()),
  q: optional(string()),
})

const pricesQuery = object({
  q: optional(string()),
  source: optional(string()),
  // Issue #373: exact category-slug filter (the meta endpoint's categories
  // list is the value domain). Absent = unfiltered, the historical shape.
  category: optional(pipe(string(), minLength(1), maxLength(100))),
  // Absent sort keeps the legacy flat name-ordered query and its exact
  // response shape, so unsorted consumers (usePriceSources) never regress.
  sort: optional(picklist(['name', 'cheapest', 'savings', 'expiry'])),
})

const plansQuery = object({
  status: optional(picklist(['active', 'archived', 'completed', 'all'])),
})

const purchasesQuery = object({
  store: optional(string()),
  from: optional(string()),
  to: optional(string()),
  q: optional(string()),
  group_by: optional(picklist(['month', 'store'])),
  // Hono delivers query params as strings — accept a digit string and coerce
  // (the OpenAPI annotation below still documents an integer).
  limit: optional(pipe(string(), transform(Number), number(), integer(), minValue(1))),
  cursor: optional(string()),
})

const scrapeEventsQuery = object({
  afterSeq: optional(pipe(string(), regex(/^\d+$/, 'Expected a non-negative integer.'))),
})

const scrapeCommandsQuery = object({
  // Hono delivers query params as strings — accept a digit string and coerce
  // (the OpenAPI annotation below still documents an integer).
  limit: optional(
    pipe(string(), transform(Number), number(), integer(), minValue(1), maxValue(50))
  ),
})

const reviewQuery = object({
  status: optional(picklist(['pending', 'approved', 'rejected', 'all'])),
  limit: optional(
    pipe(string(), transform(Number), number(), integer(), minValue(1), maxValue(200))
  ),
  offset: optional(pipe(string(), transform(Number), number(), integer(), minValue(0))),
})

// Admin AI usage analytics (issue #353): ts-exact ranges, 400 on anything else.
const aiUsageRangeQuery = object({
  range: picklist(['24h', '7d', '30d']),
})

const AI_USAGE_RANGE_MS: Record<'24h' | '7d' | '30d', number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

// cache_hit_rate = cached/input over the range. null when no input was
// recorded or the provider(s) reported no cache data — unknown, not 0.
function cacheHitRate(cachedTokens: number | null, inputTokens: number): number | null {
  if (inputTokens <= 0 || cachedTokens === null) return null
  return cachedTokens / inputTokens
}

// Admin review verdicts (issue #294): approve = "yes, same product, trust
// this match"; reject = "no, split them". Recorded only — v1 decisions
// change nothing downstream (docs/294-design-pm.md §4).
//
// Issue #484: `agreement` rides the same body. Present = the human is
// accepting or rejecting the CACHED AI verdict (decided_source 'ai_assist',
// human_agreement recorded); absent = a plain human decision.
const reviewDecisionSchema = object({
  decision: picklist(['approved', 'rejected']),
  agreement: optional(picklist(['agreed', 'disagreed'])),
})

// AI review mode (issue #484): the global admin switch — manual / approve-with-
// AI (default) / full auto. The evaluate body is an optional per-request cap.
const reviewModeSchema = object({
  mode: picklist(REVIEW_MODES),
})

const reviewEvaluateSchema = object({
  limit: optional(pipe(number(), integer(), minValue(1), maxValue(REVIEW_EVALUATE_MAX))),
})

// Admin canonical product rename (#423). The lib trims/collapses the name; the
// wire schema enforces the contract's rawText(500) ceiling and keeps control
// characters out of both text fields, so bad input 400s in the standard valibot
// shape (the lib re-checks, for direct callers).
const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u

const productRenameSchema = object({
  canonicalName: pipe(
    string(),
    minLength(1),
    maxLength(500),
    regex(NO_CONTROL_CHARS, 'Canonical name must not contain control characters.')
  ),
  expectedMetadataVersion: pipe(number(), integer(), minValue(0)),
  reason: optional(
    pipe(
      string(),
      maxLength(200),
      regex(NO_CONTROL_CHARS, 'Reason must not contain control characters.')
    )
  ),
  acknowledgeWarnings: optional(boolean()),
})

const productRevertSchema = object({
  reason: optional(
    pipe(
      string(),
      maxLength(200),
      regex(NO_CONTROL_CHARS, 'Reason must not contain control characters.')
    )
  ),
})

const apiApp = new Hono<Env>()

apiApp.use(logger())
apiApp.use('*', createCors())

// General per-user/per-IP API rate limiting (shared middleware in
// lib/rate-limit.ts — the households app runs the identical stack). Applied
// after CORS but before auth so that unauthenticated bursts are throttled too.
apiApp.use('*', (c, next) => {
  // Service-to-service ingest authenticates with a bearer secret and runs
  // once daily — exempt it from the per-IP limiter.
  if (c.req.path.startsWith('/api/internal/')) {
    return next()
  }
  return ipRateLimitMiddleware(c, next)
})

apiApp.onError((err, c) => {
  console.error(err)
  c.res.headers.set('Cache-Control', 'private, no-cache')
  return c.json({ error: err.message || 'Internal server error' }, 500)
})

apiApp.get(
  '/api/openapi.json',
  openAPIRouteHandler(apiApp, {
    documentation: {
      info: { title: 'RumaQ API', version: '0.1.0' },
      components: {
        securitySchemes: {
          cookieAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: 'rumaq_session',
          },
        },
      },
    },
  })
)

// Internal price-data routes for the rumaq-scraper pipeline
// (docs/plan/haqita-integration.md §5.2/§7.1). Service-to-service:
// bearer-secret auth instead of a session, exempt from the per-IP rate
// limiter above, and excluded from the generated OpenAPI/docs surface.
const requireIngestSecret: MiddlewareHandler<Env> = async (c, next) => {
  // Dual-accept rotation window (ahaqqu/RumaQ#376): while rotating, the
  // Worker briefly holds both the current secret (HAQITA_INGEST_SECRET) and
  // its successor (HAQITA_INGEST_SECRET_NEXT) so the scraper's cutover never
  // 401s the nightly. Every non-empty candidate is compared on every request
  // — no precedence, no early exit — so a match on one secret cannot be
  // timed apart from the other.
  // Rejections emit one structured line (#451): both ingest-auth incidents
  // (#425, #448) were undiagnosable after the fact because the Worker never
  // logged WHY a call was rejected. Route + candidate count separate the
  // surfaces; token LENGTH only — the token's content is never logged.
  // tokenLength is UTF-16 code units (JS .length) while the compare path
  // hashes UTF-8 bytes — identical for ASCII secrets; don't "fix" either side.
  const logRejection = (
    evt: 'ingest_401' | 'ingest_503',
    tokenLength: number,
    candidateCount: number
  ) =>
    console.log(
      JSON.stringify({
        evt,
        route: new URL(c.req.url).pathname,
        tokenLength,
        candidates: candidateCount,
        matched: false,
        ray: c.req.header('cf-ray') ?? null,
      })
    )
  const header = c.req.header('Authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const candidates = [c.env.HAQITA_INGEST_SECRET, c.env.HAQITA_INGEST_SECRET_NEXT].filter(
    (secret): secret is string => typeof secret === 'string' && secret.length > 0
  )
  if (candidates.length === 0) {
    logRejection('ingest_503', token.length, 0)
    return c.json({ error: 'Ingest endpoint not configured' }, 503)
  }
  let accepted = false
  for (const secret of candidates) {
    if (token && (await timingSafeEqualStrings(token, secret))) {
      accepted = true
    }
  }
  if (!accepted) {
    logRejection('ingest_401', token.length, candidates.length)
    return c.json({ error: 'Unauthorized' }, 401, {
      'WWW-Authenticate': 'Bearer realm="rumaq-ingest"',
    })
  }
  await next()
}

apiApp.post('/api/internal/ingest/prices', requireIngestSecret, async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  const validated = validateIngestV2(body)
  if (!validated.success) {
    return c.json({ error: 'Validation failed', issues: validated.issues }, 400)
  }
  const result = await ingestPricesV2(c.env.DB, validated.output)
  // Brochure retention sweep: piggybacks on the ingest — the daily tick that
  // is exactly when the referenced set changes — never a cron (a preview
  // worker inheriting the trigger would sweep production from preview code).
  // Best-effort: a sweep failure is a logged no-op and never fails the
  // ingest response or alters its shape.
  try {
    if (c.env.BROCHURES) {
      await sweepUnreferencedBrochures(c.env.DB, c.env.BROCHURES, {
        log: (message) => console.log(message),
      })
    }
  } catch (error) {
    console.warn('[brochures] retention sweep failed:', error)
  }
  return c.json(result, 200, { 'Cache-Control': 'no-store' })
})

// Read-only canonical snapshot for the scraper's match pass. The pipeline
// caches it locally; this endpoint never reads observations or prices.
// A stored row that cannot satisfy the contract is a typed failure: the log
// carries the offending product, the client gets a stable data-free body
// (contract §7 — never the valibot/internal message, the generic onError
// path would echo err.message).
apiApp.get('/api/internal/canonical-index', requireIngestSecret, async (c) => {
  try {
    const index = await getCanonicalIndex(c.env.DB)
    return c.json(index, 200, { 'Cache-Control': 'no-store' })
  } catch (error) {
    if (!(error instanceof CanonicalIndexIntegrityError)) throw error
    return c.json({ error: 'Canonical index does not match the contract' }, 500, {
      'Cache-Control': 'no-store',
    })
  }
})

// Brochure image upload from the rumaq-scraper (issue #293): the scraper
// holds no R2 credentials — this PUT rides the same bearer channel as the
// ingest routes and writes the object at the validated key. Idempotent, so
// at-least-once replay is safe. 404 on a malformed key doubles as the
// deploy-order signal: the Worker must carry this route before the scraper
// updates, and a permanent 404 is a config error the nightly must surface.
apiApp.put('/api/internal/brochures/:storeSlug/:date/:file', requireIngestSecret, async (c) => {
  if (!c.env.BROCHURES) {
    return c.json({ error: 'Brochure storage not configured' }, 503)
  }
  const key = parseBrochureKey(c.req.param('storeSlug'), c.req.param('date'), c.req.param('file'))
  if (!key) {
    return c.json({ error: 'Invalid brochure key' }, 404)
  }
  const contentType = (c.req.header('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (!BROCHURE_CONTENT_TYPES.has(contentType)) {
    return c.json({ error: 'Unsupported brochure image type' }, 415)
  }
  const body = await c.req.arrayBuffer()
  if (body.byteLength === 0 || body.byteLength > BROCHURE_MAX_BYTES) {
    return c.json({ error: 'Brochure image size out of range' }, 413)
  }
  await c.env.BROCHURES.put(key, body, {
    httpMetadata: { contentType },
    customMetadata: { uploadedAt: new Date().toISOString() },
  })
  return c.json({ ok: true })
})

// Run report from the rumaq-scraper (§7.1): one POST per finished live run,
// including failures. Feeds the admin scraping monitor.
apiApp.post(
  '/api/internal/ingest/runs',
  requireIngestSecret,
  sValidator('json', runReportSchema),
  async (c) => {
    const report = c.req.valid('json')
    await recordRunReport(c.env.DB, report)
    // Issue #294 ride-along: persist the flagged pairs. Empty/absent (old
    // scraper) is a no-op; a failed pair insert 500s the report so the
    // scraper's retry re-runs the idempotent upserts (at-least-once).
    await recordReviewItems(c.env.DB, report.runStartedAt, report.match?.reviewItemPairs ?? [])
    return c.json({ ok: true, status: 'recorded' })
  }
)

// Scrape Now command queue for the VPS agent (docs/plan/scrape-now.md §3):
// the agent polls /next to claim a queued admin command, streams the run's
// output lines back as events, and posts a terminal finish. Same
// bearer-secret channel as the ingest routes; retries are idempotent.
apiApp.get('/api/internal/scrape/next', requireIngestSecret, async (c) => {
  const command = await claimNextScrapeCommand(c.env.DB)
  const res = c.json({ command })
  res.headers.set('Cache-Control', 'private, no-cache')
  return res
})

apiApp.post(
  '/api/internal/scrape/commands/:id/events',
  requireIngestSecret,
  sValidator('json', scrapeEventsPostSchema),
  async (c) => {
    const commandId = c.req.param('id')
    try {
      await appendScrapeEvents(c.env.DB, commandId, c.req.valid('json').events)
      return c.json({ ok: true })
    } catch (error) {
      if (error instanceof ScrapeNotFoundError) return c.json({ error: error.message }, 404)
      if (error instanceof ScrapeConflictError) return c.json({ error: error.message }, 409)
      throw error
    }
  }
)

apiApp.post(
  '/api/internal/scrape/commands/:id/finish',
  requireIngestSecret,
  sValidator('json', scrapeFinishSchema),
  async (c) => {
    const commandId = c.req.param('id')
    try {
      // Only running→terminal; a repeated finish after a retry is a no-op.
      await finishScrapeCommand(c.env.DB, commandId, c.req.valid('json'))
      return c.json({ ok: true })
    } catch (error) {
      if (error instanceof ScrapeNotFoundError) return c.json({ error: error.message }, 404)
      throw error
    }
  }
)

// Freshness probe for the 6-hourly smoke staleness check (§7.1): the CI
// workflow reads this with the same bearer secret and alerts when nightly
// observations stop arriving.
apiApp.get('/api/internal/prices/status', requireIngestSecret, async (c) => {
  const status = await getPricesStatus(c.env.DB)
  const res = c.json(status)
  res.headers.set('Cache-Control', 'private, no-cache')
  return res
})

// Replay-backfill work list (issue #373, checklist item 5): pages the
// product keys + names still missing a category so the scraper-side offline
// job can classify them (derived layer — read, classify, write back; never a
// re-scrape). The job re-reads page 0 until it returns hasMore=false, which
// keeps the walk honest against the shrinking list AND makes it
// restart-safe.
const backfillQueueQuery = object({
  // Hono delivers query params as strings — accept a digit string and coerce
  // (the scrapeCommandsQuery precedent). The lib clamps limit to its page
  // ceiling, so only the floor is validated here.
  limit: optional(pipe(string(), transform(Number), number(), integer(), minValue(1))),
  offset: optional(pipe(string(), transform(Number), number(), integer(), minValue(0))),
})

apiApp.get(
  '/api/internal/prices/backfill/queue',
  requireIngestSecret,
  sValidator('query', backfillQueueQuery),
  async (c) => {
    const page = await listUncategorizedProducts(c.env.DB, {
      limit: c.req.valid('query').limit,
      offset: c.req.valid('query').offset,
    })
    const res = c.json(page)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

// Replay-backfill write-back (issue #373): the classified answers. Both
// writes are guarded by IS NULL (lib/taxonomy-backfill.ts) so a retry or a
// whole-job replay is an idempotent no-op and a live gate=on value is never
// clobbered. Unknown keys are counted in the response, never fatal.
apiApp.post(
  '/api/internal/prices/backfill/categories',
  requireIngestSecret,
  sValidator('json', backfillCategoriesPayloadSchema),
  async (c) => {
    const result = await applyCategoryBackfill(c.env.DB, c.req.valid('json'))
    const res = c.json(result)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.get(
  '/api/health',
  describeRoute({
    description: 'Public health check.',
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          },
        },
      },
    },
  }),
  (c) => {
    c.res.headers.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
    return c.json({ ok: true })
  }
)

apiApp.get(
  '/api/auth/email-status',
  describeRoute({
    description: 'Reports whether email/password auth is enabled.',
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { enabled: { type: 'boolean' } },
            },
          },
        },
      },
    },
  }),
  (c) => {
    c.res.headers.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
    return c.json({ enabled: c.env.EMAIL_AUTH_ENABLED === 'true' })
  }
)

// Premium entitlement guard factory (ahaqqu/RumaQ#376): one Entitlement per
// prices route, resolved through lib/entitlements.ts. Runs after the session
// guard (registration order), so userId is always set; a denial is a bare
// 403 that never names the user's plan.
const requirePricesEntitlement =
  (entitlement: Entitlement): MiddlewareHandler<Env> =>
  async (c, next) => {
    const verdict = await requireEntitlement(c.env, c.get('userId'), entitlement)
    if (verdict.ok) {
      await next()
      return
    }
    return c.json({ error: verdict.error }, verdict.status)
  }

apiApp.use('/api/me', propsAuthMiddleware)
apiApp.use('/api/stock', propsAuthMiddleware)
apiApp.use('/api/stock/:id', propsAuthMiddleware)
apiApp.use('/api/home', propsAuthMiddleware)
apiApp.use('/api/settings', propsAuthMiddleware)
apiApp.use('/api/ai/usage', propsAuthMiddleware)
// The AI gateway settings surface (#523 P3). apiApp.use(path) does NOT cover
// subpaths (#292), so every path gets its own line, statics before params.
apiApp.use('/api/ai/providers', propsAuthMiddleware)
apiApp.use('/api/ai/providers/:id', propsAuthMiddleware)
apiApp.use('/api/ai/providers/:id/test', propsAuthMiddleware)
apiApp.use('/api/ai/presets', propsAuthMiddleware)
apiApp.use('/api/ai/capabilities', propsAuthMiddleware)
apiApp.use('/api/ai/capabilities/:capability', propsAuthMiddleware)
apiApp.use('/api/ai/generate/persona', propsAuthMiddleware)
apiApp.use('/api/locations', propsAuthMiddleware)
apiApp.use('/api/locations/:id', propsAuthMiddleware)
apiApp.use('/api/items', propsAuthMiddleware)
apiApp.use('/api/stores', propsAuthMiddleware)
apiApp.use('/api/stores/:id', propsAuthMiddleware)
apiApp.use('/api/purchases', propsAuthMiddleware)
apiApp.use('/api/purchases/scan', propsAuthMiddleware)
apiApp.use('/api/purchases/patterns', propsAuthMiddleware)
apiApp.use('/api/purchases/:id', propsAuthMiddleware)
apiApp.use('/api/purchases/:id/receipt', propsAuthMiddleware)
apiApp.use('/api/ai/chat', propsAuthMiddleware)
apiApp.use('/api/plans', propsAuthMiddleware)
apiApp.use('/api/plans/generate', propsAuthMiddleware)
apiApp.use('/api/plans/:id/items/:itemId', propsAuthMiddleware)
apiApp.use('/api/prices', propsAuthMiddleware)
apiApp.use('/api/prices/:productKey', propsAuthMiddleware)
// Premium gating hooks (ahaqqu/RumaQ#376): one entitlement check per prices
// route, wired right behind the session guards. Behavior-neutral tonight —
// the 'free' plan carries every entitlement and user_plans has no writer
// (lib/entitlements.ts). The explore routes get their own use lines (the
// #292 discipline: apiApp.use(path) does not cover subpaths); the history
// check rides the /api/prices/:productKey route registration itself, because
// a use-line on that param pattern would also match the three static leaves
// above and double-gate them with prices.history.
apiApp.use('/api/prices', requirePricesEntitlement('prices.explore'))
apiApp.use('/api/prices/meta', requirePricesEntitlement('prices.explore'))
apiApp.use('/api/prices/promos', requirePricesEntitlement('prices.explore'))
apiApp.use('/api/prices/brochures', requirePricesEntitlement('prices.explore'))
apiApp.use('/api/admin/price-runs', propsAuthMiddleware)
apiApp.use('/api/admin/ai/usage', propsAuthMiddleware)
apiApp.use('/api/admin/scrape', propsAuthMiddleware)
apiApp.use('/api/admin/scrape/stores', propsAuthMiddleware)
apiApp.use('/api/admin/scrape/commands', propsAuthMiddleware)
apiApp.use('/api/admin/scrape/commands/:id/events', propsAuthMiddleware)
// The review queue (issue #294): apiApp.use(path) does NOT cover subpaths
// (#292 landmine) — every path gets its own line, statics before params.
apiApp.use('/api/admin/review', propsAuthMiddleware)
apiApp.use('/api/admin/review/export', propsAuthMiddleware)
apiApp.use('/api/admin/review/mode', propsAuthMiddleware)
apiApp.use('/api/admin/review/evaluate', propsAuthMiddleware)
apiApp.use('/api/admin/review/:id/decision', propsAuthMiddleware)
// Canonical product admin (#423), plus alias decisions (#489): the same
// per-path discipline as the review queue — the identity read, the rename, the
// revert, and each alias decision get a line (#292: a use-line does not cover
// subpaths). The static duplicate-name report (#485) has no line of its own:
// the `:productKey` line below matches it, which is exactly the props-auth
// gate it needs, and it is registered before the identity route so the static
// path wins.
apiApp.use('/api/admin/products/:productKey', propsAuthMiddleware)
apiApp.use('/api/admin/products/:productKey/rename', propsAuthMiddleware)
apiApp.use('/api/admin/products/:productKey/audit/:auditId/revert', propsAuthMiddleware)
apiApp.use('/api/admin/products/:productKey/aliases/:aliasId/approve', propsAuthMiddleware)
apiApp.use('/api/admin/products/:productKey/aliases/:aliasId/reject', propsAuthMiddleware)
// Bulk exact-name alias approval (#515): its paths are STATIC and sit two
// segments below /api/admin/products, so none of the lines above match them
// (the `:productKey` line is one segment; #292 — a use-line covers no
// subpaths). Each route therefore gets its own gate.
apiApp.use('/api/admin/products/aliases/candidates', propsAuthMiddleware)
apiApp.use('/api/admin/products/aliases/bulk-approve', propsAuthMiddleware)

apiApp.get(
  '/api/me',
  describeRoute({
    description: 'Returns the current authenticated user.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                user: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    email: { type: 'string' },
                    name: { type: 'string', nullable: true } as any,
                    picture: { type: 'string', nullable: true } as any,
                    isAdmin: { type: 'boolean' },
                  },
                },
                enabledPlugins: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Plugin ids enabled for the ACTIVE household (plugin architecture #435). Additive and optional: ABSENT means every catalog plugin is enabled — legacy clients, a rolled-back deploy, or a failed enablement read all read the same safe default. Enforcement lives server-side in the plugin gate (404 fail-closed), never in this list.',
                },
              },
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
    },
  }),
  async (c) => {
    const user = await c.env.DB.prepare(
      'SELECT id, email, name, picture, is_admin FROM users WHERE id = ?'
    )
      .bind(c.get('userId'))
      .first<{
        id: string
        email: string | null
        name: string | null
        picture: string | null
        is_admin: number
      }>()

    // Plugin advertisement (§4.5): the enabled set keyed to the ACTIVE
    // household (auth resolved it above), ids only. The additive-nullish
    // rule (#435): a response WITHOUT the field means all catalog plugins
    // enabled — legacy clients, a rolled-back deploy and a failed enablement
    // read (the resolver returns null) all land on the same safe default.
    // Advertisement fails OPEN while the plugin gate still fails CLOSED —
    // a client can never gain access it lacks.
    const enabledPlugins = await resolveEnabledPluginIds(
      c.env.DB,
      c.get('householdId'),
      PLUGIN_MANIFESTS
    )

    // Response shape is the openapi contract — project the row explicitly so
    // the raw is_admin column never leaks into the JSON.
    const payload: {
      user: {
        id: string
        email: string | null
        name: string | null
        picture: string | null
        isAdmin: boolean
      } | null
      enabledPlugins?: string[]
    } = {
      user: user
        ? {
            id: user.id,
            email: user.email,
            name: user.name,
            picture: user.picture,
            isAdmin: user.is_admin === 1,
          }
        : null,
    }
    if (enabledPlugins !== null) {
      payload.enabledPlugins = enabledPlugins
    }
    const res = c.json(payload)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.get(
  '/api/stock',
  describeRoute({
    description: 'Current inventory for the active household.',
    security: [{ cookieAuth: [] }],
    parameters: [
      { in: 'query', name: 'location', required: false, schema: { type: 'string' } },
      { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
    ],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                stock: {
                  type: 'array',
                  items: { type: 'object' },
                },
              },
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
    },
  }),
  sValidator('query', stockQuery),
  async (c) => {
    const { location, q } = c.req.valid('query')

    let sql = `SELECT s.id, i.name, s.qty, s.unit, s.expiry_date, s.run_out_days, s.basis, l.label AS location
       FROM stock s
       JOIN items i ON i.id = s.item_id
       LEFT JOIN locations l ON l.id = s.location_id
       WHERE s.household_id = ?`
    const params: unknown[] = [c.get('householdId')]

    if (location) {
      sql += ' AND l.id = ?'
      params.push(location)
    }
    if (q) {
      sql += ' AND i.name LIKE ?'
      params.push(`%${q}%`)
    }

    sql += ' ORDER BY COALESCE(s.run_out_days, 999), s.expiry_date'

    const { results } = await c.env.DB.prepare(sql)
      .bind(...params)
      .all()
    const res = c.json({ stock: results })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.patch(
  '/api/stock/:id',
  describeRoute({
    description: 'Updates a stock item.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              qty: { type: 'number', minimum: 0 },
              unit: { type: 'string' },
              location_id: { type: 'string' },
              expiry_date: { type: 'string' },
              name: { type: 'string' },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'OK' },
      400: { description: 'Validation error' },
      401: { description: 'Unauthorized' },
      404: { description: 'Not found' },
    },
  }),
  sValidator('json', stockPatchSchema),
  async (c) => {
    const stockId = c.req.param('id')
    const householdId = c.get('householdId')
    const body = c.req.valid('json')

    const stockRow = await c.env.DB.prepare(
      'SELECT s.*, i.name AS item_name FROM stock s JOIN items i ON i.id = s.item_id WHERE s.id = ? AND s.household_id = ?'
    )
      .bind(stockId, householdId)
      .first<{
        id: string
        item_id: string
        qty: number
        unit: string | null
        location_id: string | null
        expiry_date: string | null
        item_name: string
      }>()

    if (!stockRow) {
      return c.json({ error: 'Stock item not found' }, 404)
    }

    if (body.location_id !== undefined) {
      const loc = await c.env.DB.prepare(
        'SELECT id FROM locations WHERE id = ? AND household_id = ?'
      )
        .bind(body.location_id, householdId)
        .first()
      if (!loc) {
        return c.json({ error: 'Location not found in this household' }, 400)
      }
    }

    let itemId = stockRow.item_id
    if (body.name !== undefined) {
      const trimmed = body.name.trim()
      if (trimmed.length > 0) {
        const existing = await c.env.DB.prepare(
          'SELECT id FROM items WHERE household_id = ? AND LOWER(name) = LOWER(?)'
        )
          .bind(householdId, trimmed)
          .first<{ id: string }>()

        if (existing) {
          itemId = existing.id
        } else {
          itemId = crypto.randomUUID()
          await c.env.DB.prepare('INSERT INTO items (id, household_id, name) VALUES (?, ?, ?)')
            .bind(itemId, householdId, trimmed)
            .run()
        }
      }
    }

    const updates: string[] = []
    const params: unknown[] = []

    if (body.qty !== undefined) {
      updates.push('qty = ?')
      params.push(body.qty)
    }
    if (body.unit !== undefined) {
      updates.push('unit = ?')
      params.push(body.unit)
    }
    if (body.location_id !== undefined) {
      updates.push('location_id = ?')
      params.push(body.location_id)
    }
    if (body.expiry_date !== undefined) {
      updates.push('expiry_date = ?')
      params.push(body.expiry_date)
    }
    if (body.name !== undefined) {
      updates.push('item_id = ?')
      params.push(itemId)
    }

    const finalQty = body.qty ?? stockRow.qty
    const runOut = await computeRunOutDays(householdId, itemId, finalQty, c.env.DB)
    updates.push('run_out_days = ?', 'basis = ?')
    params.push(runOut.run_out_days, runOut.basis)

    params.push(stockId, householdId)
    await c.env.DB.prepare(
      `UPDATE stock SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ? AND household_id = ?`
    )
      .bind(...params)
      .run()

    const updated = await c.env.DB.prepare(
      `SELECT s.id, i.name, s.qty, s.unit, s.expiry_date, s.run_out_days, s.basis, l.label AS location
       FROM stock s
       JOIN items i ON i.id = s.item_id
       LEFT JOIN locations l ON l.id = s.location_id
       WHERE s.id = ? AND s.household_id = ?`
    )
      .bind(stockId, householdId)
      .first()

    const res = c.json({ stock: updated })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.get(
  '/api/home',
  describeRoute({
    description: 'Home dashboard stats for the active household.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: { description: 'OK' },
      401: { description: 'Unauthorized' },
    },
  }),
  async (c) => {
    const householdId = c.get('householdId')

    const totalResult = await c.env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM stock WHERE household_id = ? AND qty > 0'
    )
      .bind(householdId)
      .first<{ cnt: number }>()
    const totalItems = totalResult?.cnt ?? 0

    const today = new Date().toISOString().slice(0, 10)

    const expiringResult = await c.env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM stock
       WHERE household_id = ? AND qty > 0 AND expiry_date IS NOT NULL
       AND expiry_date >= ? AND expiry_date <= date(?, '+7 days')`
    )
      .bind(householdId, today, today)
      .first<{ cnt: number }>()
    const expiring7d = expiringResult?.cnt ?? 0

    const runningOutResult = await c.env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM stock
       WHERE household_id = ? AND qty > 0
       AND COALESCE(run_out_days, 999) <= 7`
    )
      .bind(householdId)
      .first<{ cnt: number }>()
    const runningOut7d = runningOutResult?.cnt ?? 0

    const lowStock = await c.env.DB.prepare(
      `SELECT s.id, i.name, s.qty, s.unit, s.expiry_date, s.run_out_days, s.basis, l.label AS location
       FROM stock s
       JOIN items i ON i.id = s.item_id
       LEFT JOIN locations l ON l.id = s.location_id
       WHERE s.household_id = ? AND s.qty > 0
       AND (COALESCE(s.run_out_days, 999) <= 7
         OR (s.expiry_date IS NOT NULL AND s.expiry_date <= date(?, '+7 days')))
       ORDER BY COALESCE(s.run_out_days, 999), s.expiry_date
       LIMIT 20`
    )
      .bind(householdId, today)
      .all()

    const attentionResult = await c.env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM stock
       WHERE household_id = ? AND qty > 0
       AND (COALESCE(run_out_days, 999) <= 7
         OR (expiry_date IS NOT NULL AND expiry_date <= date(?, '+7 days')))`
    )
      .bind(householdId, today)
      .first<{ cnt: number }>()
    const attentionCount = attentionResult?.cnt ?? 0

    const spendResult = await c.env.DB.prepare(
      `SELECT COALESCE(SUM(total), 0) AS spend, COUNT(*) AS receipts
       FROM purchases
       WHERE household_id = ? AND substr(date, 1, 7) = substr(?, 1, 7)`
    )
      .bind(householdId, today)
      .first<{ spend: number; receipts: number }>()
    const currentMonthSpend = spendResult?.spend ?? 0
    const currentMonthReceipts = spendResult?.receipts ?? 0

    const res = c.json({
      total_items: totalItems,
      expiring_7d: expiring7d,
      running_out_7d: runningOut7d,
      low_stock: lowStock.results ?? [],
      attention_count: attentionCount,
      current_month_spend: currentMonthSpend,
      current_month_receipts: currentMonthReceipts,
      expiring_soon: [],
      next_trip: null,
    })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.get(
  '/api/settings',
  describeRoute({
    description: 'Returns the current authenticated user settings.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: [
                'motion_preference',
                'language',
                'persona_user_role',
                'persona_ai_role',
                'persona_enabled',
                'theme_hue',
                'active_household_id',
                'active_household_name',
                'ai_providers',
                'ai_capabilities',
                'ai_status',
              ],
              properties: {
                motion_preference: { type: 'string' },
                language: { type: ['string', 'null'] },
                persona_user_role: { type: ['string', 'null'] },
                persona_ai_role: { type: ['string', 'null'] },
                persona_enabled: { type: 'boolean' },
                theme_hue: { type: ['integer', 'null'] },
                active_household_id: { type: 'string' },
                active_household_name: { type: ['string', 'null'] },
                ai_providers: {
                  type: 'array',
                  description:
                    "The household's provider rows (#523 P1). Never includes key material — has_key is the only signal.",
                  items: {
                    type: 'object',
                    required: [
                      'id',
                      'label',
                      'kind',
                      'base_url',
                      'default_model',
                      'has_key',
                      'created_at',
                      'updated_at',
                    ],
                    properties: {
                      id: { type: 'string' },
                      label: { type: 'string' },
                      kind: {
                        type: 'string',
                        enum: ['openai-compatible', 'anthropic', 'gemini', 'questions'],
                      },
                      base_url: { type: ['string', 'null'] },
                      default_model: {
                        type: ['string', 'null'],
                        description:
                          'Provider-level default model; a capability with no model inherits it (#523).',
                      },
                      has_key: { type: 'boolean' },
                      created_at: { type: 'string' },
                      updated_at: { type: 'string' },
                    },
                  },
                },
                ai_capabilities: {
                  type: 'object',
                  description:
                    'One assignment per capability (null fields = not configured); source=household means the row exists.',
                  required: ['decision', 'reasoning', 'vision'],
                  properties: {
                    decision: {
                      type: 'object',
                      required: [
                        'provider_id',
                        'provider_label',
                        'model',
                        'thinking_level',
                        'source',
                      ],
                      properties: {
                        provider_id: { type: ['string', 'null'] },
                        provider_label: { type: ['string', 'null'] },
                        model: { type: ['string', 'null'] },
                        thinking_level: { type: ['string', 'null'] },
                        source: { type: 'string', enum: ['household', 'none'] },
                      },
                    },
                    reasoning: {
                      type: 'object',
                      required: [
                        'provider_id',
                        'provider_label',
                        'model',
                        'thinking_level',
                        'source',
                      ],
                      properties: {
                        provider_id: { type: ['string', 'null'] },
                        provider_label: { type: ['string', 'null'] },
                        model: { type: ['string', 'null'] },
                        thinking_level: { type: ['string', 'null'] },
                        source: { type: 'string', enum: ['household', 'none'] },
                      },
                    },
                    vision: {
                      type: 'object',
                      required: [
                        'provider_id',
                        'provider_label',
                        'model',
                        'thinking_level',
                        'source',
                      ],
                      properties: {
                        provider_id: { type: ['string', 'null'] },
                        provider_label: { type: ['string', 'null'] },
                        model: { type: ['string', 'null'] },
                        thinking_level: { type: ['string', 'null'] },
                        source: { type: 'string', enum: ['household', 'none'] },
                      },
                    },
                  },
                },
                ai_status: {
                  type: 'object',
                  required: ['decision', 'reasoning', 'vision'],
                  properties: {
                    decision: { type: 'string', enum: ['household', 'none'] },
                    reasoning: { type: 'string', enum: ['household', 'none'] },
                    vision: { type: 'string', enum: ['household', 'none'] },
                  },
                },
              },
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
    },
  }),
  async (c) => {
    // The legacy `user_settings.ai_*` projection is GONE (#523 P3, plan §4.3):
    // migration 0042 dropped the columns and the household's providers /
    // assignments below are the only AI configuration this payload carries.
    const settings = await c.env.DB.prepare(
      `SELECT motion_preference, language, persona_user_role, persona_ai_role,
              persona_enabled, theme_hue, active_household_id
        FROM user_settings WHERE user_id = ?`
    )
      .bind(c.get('userId'))
      .first<{
        motion_preference: string
        language: string | null
        persona_user_role: string | null
        persona_ai_role: string | null
        persona_enabled: number
        theme_hue: number | null
        active_household_id: string | null
      }>()

    // The household identity echoes the middleware's RESOLVED household
    // (review A3) — the one value every other route scopes by — not the raw
    // user_settings.active_household_id, which can be stale (a removed
    // member's pointer) and would diverge from the second resolver here.
    const resolvedHouseholdId = c.get('householdId')
    const household = await c.env.DB.prepare('SELECT name FROM households WHERE id = ?')
      .bind(resolvedHouseholdId)
      .first<{ name: string }>()

    // The additive AI-gateway block (#523 P1): the household's providers, its
    // three assignments, and the resolver's usable status per capability. One
    // read; no key material leaves this module.
    const aiConfig = await loadHouseholdAiConfig(c.env, resolvedHouseholdId)

    const res = c.json({
      motion_preference: settings?.motion_preference ?? 'standard',
      language: settings?.language ?? null,
      persona_user_role: settings?.persona_user_role ?? null,
      persona_ai_role: settings?.persona_ai_role ?? null,
      persona_enabled: settings?.persona_enabled === 1,
      theme_hue: settings?.theme_hue ?? null,
      active_household_id: resolvedHouseholdId,
      active_household_name: household?.name ?? null,
      ai_providers: aiConfig.providers,
      ai_capabilities: aiConfig.capabilities,
      ai_status: aiConfig.status,
    })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.patch(
  '/api/settings',
  describeRoute({
    description: 'Updates the current user settings.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            description:
              'Preference fields only. AI configuration lives at /api/ai/providers and /api/ai/capabilities; the legacy ai_* fields are gone with the columns migration 0042 dropped (#523 P3).',
            properties: {
              persona_user_role: { type: 'string' },
              persona_ai_role: { type: 'string' },
              persona_enabled: { type: 'boolean' },
              motion_preference: { type: 'string', enum: ['none', 'reduced', 'standard'] },
              language: { type: 'string', enum: ['id', 'en'] },
              theme_hue: { type: 'number' },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'OK' },
      400: { description: 'Validation error' },
      401: { description: 'Unauthorized' },
    },
  }),
  sValidator('json', settingsPatchSchema),
  async (c) => {
    const body = c.req.valid('json')
    const updates: string[] = []
    const params: unknown[] = []

    // No AI branch: the legacy `ai_*` fields are not part of this schema any
    // more (#523 P3). Providers and capability assignments are written through
    // /api/ai/providers and /api/ai/capabilities.
    const fields = body
    if (fields.persona_user_role !== undefined) {
      updates.push('persona_user_role = ?')
      params.push(fields.persona_user_role)
    }
    if (fields.persona_ai_role !== undefined) {
      updates.push('persona_ai_role = ?')
      params.push(fields.persona_ai_role)
    }
    if (fields.persona_enabled !== undefined) {
      updates.push('persona_enabled = ?')
      params.push(fields.persona_enabled ? 1 : 0)
    }
    if (fields.motion_preference !== undefined) {
      updates.push('motion_preference = ?')
      params.push(fields.motion_preference)
    }
    if (fields.language !== undefined) {
      updates.push('language = ?')
      params.push(fields.language)
    }
    if (fields.theme_hue !== undefined) {
      updates.push('theme_hue = ?')
      params.push(fields.theme_hue)
    }

    if (updates.length > 0) {
      params.push(c.get('userId'))
      await c.env.DB.prepare(
        `UPDATE user_settings SET ${updates.join(', ')}, updated_at = datetime('now') WHERE user_id = ?`
      )
        .bind(...params.map((p) => (p === undefined || p === null ? null : p)))
        .run()
    }

    const settings = await c.env.DB.prepare(
      `SELECT motion_preference, language, persona_user_role, persona_ai_role,
              persona_enabled, theme_hue
        FROM user_settings WHERE user_id = ?`
    )
      .bind(c.get('userId'))
      .first<{
        motion_preference: string
        language: string | null
        persona_user_role: string | null
        persona_ai_role: string | null
        persona_enabled: number
        theme_hue: number | null
      }>()

    const res = c.json({
      motion_preference: settings?.motion_preference ?? 'standard',
      language: settings?.language ?? null,
      persona_user_role: settings?.persona_user_role ?? null,
      persona_ai_role: settings?.persona_ai_role ?? null,
      persona_enabled: settings?.persona_enabled === 1,
      theme_hue: settings?.theme_hue ?? null,
    })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

// ─── AI gateway settings (ahaqqu/RumaQ#523 P3, plan §4) ─────────────────────
//
// Six endpoints replace the single dead `PATCH /api/settings` AI branch and the
// retired `POST /api/ai-key/test`. Rules enforced here (the body rules live in
// lib/ai/provider-settings.ts):
//   - every route is authenticated (the `apiApp.use` lines above);
//   - READS are open to every member (a member must see what their household
//     spends); every WRITE runs `requireOwner` first and answers 403 otherwise;
//   - `can_manage` comes from the household role, so the UI never guesses;
//   - nothing ever serialises a key: `has_key` is the only signal.

const PROVIDER_TEST_RATE_WINDOW_MS = 60_000
const PROVIDER_TEST_RATE_MAX = 30

// The persona rewrite (#523 P5) is ONE billed reasoning call per Apply, so it
// reuses the provider-test window (30/min per user) — the shared shape for the
// small, user-triggered AI surfaces: a per-user fixed window, applied after the
// 402 gate, answered 429 + Retry-After. It is a burst guard, NOT a budget cap
// (D9): no usage counter gates an AI call anywhere in the product.
const PERSONA_RATE_WINDOW_MS = 60_000
const PERSONA_RATE_MAX = 30

/**
 * The one translation from the settings module's typed refusals (and the owner
 * gate's) onto HTTP. `apiApp.onError` is the generic 500 handler — the typed
 * 403/404 of the household gate would otherwise fall through it, so the routes
 * catch and map here instead.
 */
function aiSettingsError(c: Context<Env>, err: unknown): Response {
  if (err instanceof AiProviderSettingsError) return c.json({ error: err.message }, err.status)
  if (err instanceof HouseholdNotFoundError) return c.json({ error: err.message }, 404)
  if (err instanceof HouseholdForbiddenError) return c.json({ error: err.message }, 403)
  throw err
}

const PROVIDER_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  required: [
    'id',
    'label',
    'kind',
    'preset',
    'base_url',
    'default_model',
    'has_key',
    'created_at',
    'updated_at',
  ],
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    kind: { type: 'string', enum: ['openai-compatible', 'anthropic', 'gemini', 'questions'] },
    preset: { type: ['string', 'null'] },
    base_url: { type: ['string', 'null'] },
    default_model: { type: ['string', 'null'] },
    has_key: { type: 'boolean' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
}

const CAPABILITY_ASSIGNMENT_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  required: [
    'provider_id',
    'provider_label',
    'model',
    'effective_model',
    'thinking_level',
    'source',
  ],
  properties: {
    provider_id: { type: ['string', 'null'] },
    provider_label: { type: ['string', 'null'] },
    model: {
      type: ['string', 'null'],
      description: "The assignment's own model; null = inherit the provider's default_model",
    },
    effective_model: {
      type: ['string', 'null'],
      description:
        'What the resolver will call: model ?? the provider default; null = not configured',
    },
    thinking_level: { type: ['string', 'null'] },
    source: { type: 'string', enum: ['household', 'none'] },
  },
}

apiApp.get(
  '/api/ai/presets',
  describeRoute({
    description:
      'Lists the AI provider presets a household MAY add: id, label, wire kind and canonical base URL only. Seeds nothing, preselects nothing, defines no default, and carries no model ids — a model is owner-typed data on a provider row (#523 P3, plan §4.1/§4.5).',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['presets'],
              properties: {
                presets: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['id', 'label', 'kind', 'base_url'],
                    properties: {
                      id: { type: 'string' },
                      label: { type: 'string' },
                      kind: {
                        type: 'string',
                        enum: ['openai-compatible', 'anthropic', 'gemini', 'questions'],
                      },
                      base_url: {
                        type: ['string', 'null'],
                        description: 'Canonical endpoint; null when the household must supply one',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
    },
  }),
  (c) => {
    const res = c.json({ presets: listPresets() })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.get(
  '/api/ai/providers',
  describeRoute({
    description:
      "Lists the acting household's AI providers. Every member may read it; `can_manage` is the household role, so a member is never offered a control that would 403. No response path carries key material — `has_key` is the only signal (#523 P3).",
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['can_manage', 'managed_by', 'providers'],
              properties: {
                can_manage: { type: 'boolean' },
                managed_by: {
                  type: ['string', 'null'],
                  description:
                    "The household owner's display name, for the member's read-only line",
                },
                providers: { type: 'array', items: PROVIDER_SCHEMA },
              },
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
    },
  }),
  async (c) => {
    const householdId = c.get('householdId')
    const userId = c.get('userId')
    const membership = await getMembership(c.env.DB, householdId, userId)
    if (!membership) {
      return c.json({ error: 'Household not found' }, 404)
    }
    const providers = await listProviders(c.env, householdId)

    // The owner's name powers the member's "Managed by …" line. NULL when the
    // household somehow has no owner row (the role CHECK makes that unusual,
    // but the UI must render either way).
    let managedBy: string | null = null
    if (membership.role !== 'owner') {
      const owner = await c.env.DB.prepare(
        `SELECT COALESCE(NULLIF(u.name, ''), u.email) AS name
           FROM household_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.household_id = ? AND m.role = 'owner'
          ORDER BY m.joined_at, m.user_id
          LIMIT 1`
      )
        .bind(householdId)
        .first<{ name: string | null }>()
      managedBy = owner?.name ?? null
    }

    const res = c.json({
      can_manage: membership.role === 'owner',
      managed_by: managedBy,
      providers,
    })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.post(
  '/api/ai/providers',
  describeRoute({
    description:
      "Adds an AI provider to the acting household. Owner-only (403 for a member). The key is write-only and sealed with the provider row's id as additional authenticated data — no endpoint ever returns it. 409 on a duplicate label (case-insensitive), 400 past the ten-provider cap or when the row would have no endpoint.",
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['label', 'kind', 'api_key'],
            additionalProperties: false,
            properties: {
              label: { type: 'string', minLength: 1, maxLength: 60 },
              kind: {
                type: 'string',
                enum: ['openai-compatible', 'anthropic', 'gemini', 'questions'],
              },
              preset: { type: 'string', maxLength: 40 },
              base_url: { type: 'string', maxLength: 500 },
              default_model: {
                type: 'string',
                maxLength: 200,
                description:
                  'Optional provider-level default; a capability with a blank model inherits it',
              },
              api_key: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Created',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['provider'],
              properties: { provider: PROVIDER_SCHEMA },
            },
          },
        },
      },
      400: { description: 'Validation error, provider cap, or no resolvable endpoint' },
      401: { description: 'Unauthorized' },
      403: { description: 'Only household owners can change AI settings' },
      409: { description: 'Duplicate provider label' },
    },
  }),
  sValidator('json', aiProviderCreateSchema),
  async (c) => {
    const householdId = c.get('householdId')
    try {
      await requireOwner(c.env.DB, householdId, c.get('userId'))
      const provider = await createProvider(c.env, householdId, c.req.valid('json'))
      const res = c.json({ provider }, 201)
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    } catch (err) {
      return aiSettingsError(c, err)
    }
  }
)

apiApp.patch(
  '/api/ai/providers/:id',
  describeRoute({
    description:
      'Updates one household AI provider. Owner-only. The key stays write-only: an omitted `api_key` leaves the stored one, `api_key: ""` clears it (409 while a capability uses the provider), and any value re-seals it. `base_url: ""` / `default_model: ""` clear those columns. 404 for a provider id from another household; 409 on a duplicate label.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string', minLength: 1, maxLength: 60 },
              kind: {
                type: 'string',
                enum: ['openai-compatible', 'anthropic', 'gemini', 'questions'],
              },
              base_url: { type: 'string', maxLength: 500 },
              default_model: { type: 'string', maxLength: 200 },
              api_key: { type: 'string' },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['provider'],
              properties: { provider: PROVIDER_SCHEMA },
            },
          },
        },
      },
      400: { description: 'Validation error or a row that would have no endpoint' },
      401: { description: 'Unauthorized' },
      403: { description: 'Only household owners can change AI settings' },
      404: { description: 'Provider not found in this household' },
      409: {
        description:
          'Duplicate label, or an edit that would strand an assigned capability: clearing its key, or clearing the default model that assignment inherits',
      },
    },
  }),
  sValidator('json', aiProviderPatchSchema),
  async (c) => {
    const householdId = c.get('householdId')
    try {
      await requireOwner(c.env.DB, householdId, c.get('userId'))
      const provider = await updateProvider(
        c.env,
        householdId,
        c.req.param('id'),
        c.req.valid('json')
      )
      const res = c.json({ provider })
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    } catch (err) {
      return aiSettingsError(c, err)
    }
  }
)

apiApp.delete(
  '/api/ai/providers/:id',
  describeRoute({
    description:
      'Deletes one household AI provider. Owner-only. Returns the capabilities the provider was serving: those assignments are cleared in the same batch, so the UI can warn before the delete and the caller knows what became not configured.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'Deleted',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['cleared'],
              properties: {
                cleared: {
                  type: 'array',
                  items: { type: 'string', enum: ['decision', 'reasoning', 'vision'] },
                },
              },
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Only household owners can change AI settings' },
      404: { description: 'Provider not found in this household' },
    },
  }),
  async (c) => {
    const householdId = c.get('householdId')
    try {
      await requireOwner(c.env.DB, householdId, c.get('userId'))
      const result = await deleteProvider(c.env, householdId, c.req.param('id'))
      const res = c.json(result)
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    } catch (err) {
      return aiSettingsError(c, err)
    }
  }
)

apiApp.post(
  '/api/ai/providers/:id/test',
  describeRoute({
    description:
      'Tests one household provider’s stored credentials with its own free probe: a `/models` listing for chat kinds, and an EMPTY-questions request for a typed (`questions`) endpoint, whose expected 400 proves authentication without buying an answer. Owner-only (it uses the household credential) and rate-limited per user. The answer is `{ ok: true }` or `{ ok: false, code }` — never the provider body.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'Probe finished — `ok` says whether the key authenticated',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['ok'],
              properties: {
                ok: { type: 'boolean' },
                code: {
                  type: 'string',
                  description:
                    'Failure code (auth, rate_limited, timeout, provider_error, invalid_response, unsupported, unreadable_key) — present only when ok is false',
                },
              },
            },
          },
        },
      },
      400: { description: 'The provider has no key or no resolvable endpoint' },
      401: { description: 'Unauthorized' },
      403: { description: 'Only household owners can change AI settings' },
      404: { description: 'Provider not found in this household' },
      429: { description: 'Too many connection tests' },
    },
  }),
  async (c) => {
    const householdId = c.get('householdId')
    try {
      // The role gate comes FIRST on every write (plan §4.2): a member must see
      // the same 403 on their 31st request as on their first, never a 429 that
      // implies the write would otherwise be allowed.
      await requireOwner(c.env.DB, householdId, c.get('userId'))
      // The probe spends the household's credential budget, so it is limited per
      // user AFTER authorization.
      const { limited, retryAfter } = isRateLimited(
        `ai-provider-test:${c.get('userId')}`,
        PROVIDER_TEST_RATE_WINDOW_MS,
        PROVIDER_TEST_RATE_MAX
      )
      if (limited) {
        return c.json({ error: 'Too many provider tests. Please slow down.' }, 429, {
          'Retry-After': String(retryAfter),
        })
      }
      const result = await testProvider(c.env, householdId, c.req.param('id'))
      const res = c.json(result)
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    } catch (err) {
      return aiSettingsError(c, err)
    }
  }
)

apiApp.get(
  '/api/ai/capabilities',
  describeRoute({
    description:
      "Returns the acting household's three capability assignments: the provider each points at, the model the resolver will actually call (the assignment's model, else the provider's default) and the capability's usable status ('household' = a call would reach a provider, 'none' = 402). Every member may read it (#523 P3).",
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['can_manage', 'capabilities', 'status'],
              properties: {
                can_manage: { type: 'boolean' },
                capabilities: {
                  type: 'object',
                  required: ['decision', 'reasoning', 'vision'],
                  properties: {
                    decision: CAPABILITY_ASSIGNMENT_SCHEMA,
                    reasoning: CAPABILITY_ASSIGNMENT_SCHEMA,
                    vision: CAPABILITY_ASSIGNMENT_SCHEMA,
                  },
                },
                status: {
                  type: 'object',
                  required: ['decision', 'reasoning', 'vision'],
                  properties: {
                    decision: { type: 'string', enum: ['household', 'none'] },
                    reasoning: { type: 'string', enum: ['household', 'none'] },
                    vision: { type: 'string', enum: ['household', 'none'] },
                  },
                },
              },
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
    },
  }),
  async (c) => {
    const householdId = c.get('householdId')
    const membership = await getMembership(c.env.DB, householdId, c.get('userId'))
    if (!membership) {
      return c.json({ error: 'Household not found' }, 404)
    }
    const config = await loadHouseholdAiConfig(c.env, householdId)
    const res = c.json({
      can_manage: membership.role === 'owner',
      capabilities: config.capabilities,
      status: config.status,
    })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.put(
  '/api/ai/capabilities/:capability',
  describeRoute({
    description:
      "Assigns one capability to one of the household's providers (upsert — one assignment per capability). Owner-only. `model` blank inherits the provider's default model; both blank is the normal not-configured state, not an error. 400 when the provider's wire cannot serve the capability, when a thinking level is sent for `vision` or a typed provider, or when the provider has no usable key/endpoint; 404 when the provider id is not this household's.",
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['provider_id'],
            additionalProperties: false,
            properties: {
              provider_id: { type: 'string' },
              model: {
                type: 'string',
                maxLength: 200,
                description: 'Blank = inherit the provider default',
              },
              thinking_level: { type: 'string', enum: ['low', 'medium', 'high', ''] },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['capability', 'status'],
              properties: {
                capability: CAPABILITY_ASSIGNMENT_SCHEMA,
                status: { type: 'string', enum: ['household', 'none'] },
              },
            },
          },
        },
      },
      400: {
        description: 'Kind/capability mismatch, forbidden thinking level, or unusable provider',
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Only household owners can change AI settings' },
      404: { description: 'Provider not found in this household' },
    },
  }),
  sValidator('json', aiCapabilityAssignSchema),
  async (c) => {
    const householdId = c.get('householdId')
    try {
      await requireOwner(c.env.DB, householdId, c.get('userId'))
      const result = await assignCapability(
        c.env,
        householdId,
        c.req.param('capability'),
        c.req.valid('json')
      )
      const res = c.json(result)
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    } catch (err) {
      return aiSettingsError(c, err)
    }
  }
)

apiApp.delete(
  '/api/ai/capabilities/:capability',
  describeRoute({
    description:
      'Clears one capability assignment (the capability becomes not configured: 402 on its routes). Owner-only and idempotent — clearing an unassigned capability is a 200, not a 404.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'Cleared',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['capability', 'status'],
              properties: {
                capability: CAPABILITY_ASSIGNMENT_SCHEMA,
                status: { type: 'string', enum: ['household', 'none'] },
              },
            },
          },
        },
      },
      400: { description: 'Unknown capability' },
      401: { description: 'Unauthorized' },
      403: { description: 'Only household owners can change AI settings' },
    },
  }),
  async (c) => {
    const householdId = c.get('householdId')
    try {
      await requireOwner(c.env.DB, householdId, c.get('userId'))
      const result = await clearCapability(c.env, householdId, c.req.param('capability'))
      const res = c.json(result)
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    } catch (err) {
      return aiSettingsError(c, err)
    }
  }
)

// One completed AI call → one ai_usage_events row. Shared by the chat, scan
// and plan-generate routes; usage is analytics only and never gates a call.
// The row carries the access's capability/household/funding dimensions (#523
// P1) and no longer writes key_source (D9 replaced it).
/** The member's today slice of `ai_usage_events` (and the household's total). */
type UsageTotals = {
  used: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number | null
}

/** One capability's today slice — `capability` is null on pre-gateway history. */
type UsageCapabilityRow = UsageTotals & {
  capability: string | null
  typed_calls: number
}

/** The admin range's per-capability row (same cut, range-wide, `calls` wording). */
type AdminUsageCapabilityRow = {
  capability: string | null
  calls: number
  typed_calls: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number | null
}

/**
 * One completed call's usage row: the ACTING member's `user_id` with the call's
 * own dimensions — `household_id` (who owns the provider and pays), the
 * capability that was served, and the funding source (#523 P4, plan §5.3).
 */
function recordAiCallUsage(
  env: Env['Bindings'],
  userId: string,
  call: AiCall,
  usage: TokenUsage
): Promise<void> {
  return recordAiUsageEvent(env, { userId, call, usage })
}

/**
 * The failed attempt's usage row ("failure carries the bill", plan §2.2): the
 * provider read the inputs even when its answer was unusable, so every failure
 * AFTER a call has a row.
 *
 * The bill comes from the error when the door dispatched and failed
 * (`AiError.call`/`usage`), and from the caller's captured attempt when the call
 * itself succeeded and the failure is the feature rejecting its answer (an
 * unparseable scan reply is a plain `Error`, and the provider still billed it —
 * the #523 P4 regression this argument repairs). `not_configured` is the one
 * failure with no call and no bill, so it writes nothing.
 */
function recordAiFailureUsage(
  env: Env['Bindings'],
  userId: string,
  attempt: { call: AiCall; usage: TokenUsage },
  err: unknown
): Promise<void> {
  if (err instanceof AiError) {
    return err.call
      ? recordAiUsageEvent(env, { userId, call: err.call, usage: err.usage })
      : Promise.resolve()
  }
  return recordAiUsageEvent(env, { userId, call: attempt.call, usage: attempt.usage })
}

apiApp.get(
  '/api/ai/usage',
  describeRoute({
    description:
      "Returns today's AI usage (UTC day) for the acting member, broken down by capability, with the household total beside it. Usage is recorded but never capped.",
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: [
                'used',
                'input_tokens',
                'output_tokens',
                'cached_tokens',
                'capabilities',
                'household',
              ],
              properties: {
                used: {
                  type: 'integer',
                  description: 'Completed AI calls today (UTC) made by the acting member',
                },
                input_tokens: { type: 'integer' },
                output_tokens: { type: 'integer' },
                cached_tokens: {
                  type: ['integer', 'null'],
                  description:
                    'Provider-reported cached input tokens; null when the provider reports none',
                },
                capabilities: {
                  type: 'array',
                  description:
                    "The acting member's calls today broken down by capability; a null capability is pre-gateway history whose capability was never recorded",
                  items: {
                    type: 'object',
                    required: [
                      'capability',
                      'used',
                      'typed_calls',
                      'input_tokens',
                      'output_tokens',
                      'cached_tokens',
                    ],
                    properties: {
                      capability: {
                        type: ['string', 'null'],
                        description:
                          "The capability that was served: 'decision', 'reasoning', 'vision', or null for pre-gateway history",
                      },
                      used: { type: 'integer' },
                      typed_calls: {
                        type: 'integer',
                        description:
                          'Calls answered by a typed (questions) provider — not token-billed',
                      },
                      input_tokens: { type: 'integer' },
                      output_tokens: { type: 'integer' },
                      cached_tokens: { type: ['integer', 'null'] },
                    },
                  },
                },
                household: {
                  type: 'object',
                  description:
                    "Today's calls by every member of the household the request acts in (the household cut; readable by every member)",
                  required: ['used', 'input_tokens', 'output_tokens', 'cached_tokens'],
                  properties: {
                    used: { type: 'integer' },
                    input_tokens: { type: 'integer' },
                    output_tokens: { type: 'integer' },
                    cached_tokens: { type: ['integer', 'null'] },
                  },
                },
              },
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
    },
  }),
  async (c) => {
    const userId = c.get('userId')
    const householdId = c.get('householdId')
    const today = new Date().toISOString().slice(0, 10)

    // "Your calls, not the household's" (plan §4.1) + the household total beside
    // it (plan §4.4), both cut by capability (#523 P4). There is deliberately no
    // `provider` field any more: a call's provider is a per-capability fact, so
    // the breakdown says which capability spent what instead of naming one
    // provider a household may not even use for that call.
    const totals = await c.env.DB.prepare(
      `SELECT COUNT(*) AS used,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              SUM(cached_tokens) AS cached_tokens
         FROM ai_usage_events
        WHERE user_id = ? AND date = ?`
    )
      .bind(userId, today)
      .first<UsageTotals>()

    const { results: capabilityRows } = await c.env.DB.prepare(
      `SELECT capability,
              COUNT(*) AS used,
              SUM(CASE WHEN provider = 'questions' THEN 1 ELSE 0 END) AS typed_calls,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              SUM(cached_tokens) AS cached_tokens
         FROM ai_usage_events
        WHERE user_id = ? AND date = ?
        GROUP BY capability
        -- The enum's own order (decision, reasoning, vision); unknown/null last.
        ORDER BY capability IS NULL, capability`
    )
      .bind(userId, today)
      .all<UsageCapabilityRow>()

    const householdTotals = await c.env.DB.prepare(
      `SELECT COUNT(*) AS used,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              SUM(cached_tokens) AS cached_tokens
         FROM ai_usage_events
        WHERE household_id = ? AND date = ?`
    )
      .bind(householdId, today)
      .first<UsageTotals>()

    const res = c.json({
      used: totals?.used ?? 0,
      input_tokens: totals?.input_tokens ?? 0,
      output_tokens: totals?.output_tokens ?? 0,
      // SUM over all-null cached figures is NULL: unreported, not zero.
      cached_tokens: totals?.cached_tokens ?? null,
      capabilities: (capabilityRows ?? []).map((row) => ({
        capability: row.capability,
        used: row.used,
        typed_calls: row.typed_calls,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cached_tokens: row.cached_tokens,
      })),
      household: {
        used: householdTotals?.used ?? 0,
        input_tokens: householdTotals?.input_tokens ?? 0,
        output_tokens: householdTotals?.output_tokens ?? 0,
        cached_tokens: householdTotals?.cached_tokens ?? null,
      },
    })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

// Admin AI usage analytics (issue #353): totals plus a per-user breakdown
// over a ts-exact recent range. 403 for non-admin users (requireAdmin).
apiApp.get(
  '/api/admin/ai/usage',
  describeRoute({
    description:
      'AI usage totals with per-capability, per-user and per-household breakdowns over a recent range (admin-only).',
    security: [{ cookieAuth: [] }],
    parameters: [
      {
        in: 'query',
        name: 'range',
        required: true,
        schema: { type: 'string', enum: ['24h', '7d', '30d'] },
      },
    ],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['range', 'since', 'totals', 'users', 'households'],
              properties: {
                range: { type: 'string', enum: ['24h', '7d', '30d'] },
                since: { type: 'string', description: 'ISO instant the range starts at' },
                totals: {
                  type: 'object',
                  required: [
                    'calls',
                    'input_tokens',
                    'output_tokens',
                    'cached_tokens',
                    'cache_hit_rate',
                    'capabilities',
                  ],
                  properties: {
                    calls: { type: 'integer' },
                    input_tokens: { type: 'integer' },
                    output_tokens: { type: 'integer' },
                    cached_tokens: { type: ['integer', 'null'] },
                    cache_hit_rate: {
                      type: ['number', 'null'],
                      description: 'cached/input; null when input is 0 or cache unreported',
                    },
                    capabilities: {
                      type: 'array',
                      description:
                        'Totals broken down by capability; typed_calls are calls a typed (questions) provider answered, which report no tokens (not token-billed)',
                      items: {
                        type: 'object',
                        required: [
                          'capability',
                          'calls',
                          'typed_calls',
                          'input_tokens',
                          'output_tokens',
                          'cached_tokens',
                        ],
                        properties: {
                          capability: {
                            type: ['string', 'null'],
                            description:
                              "The capability that was served: 'decision', 'reasoning', 'vision', or null for pre-gateway history",
                          },
                          calls: { type: 'integer' },
                          typed_calls: { type: 'integer' },
                          input_tokens: { type: 'integer' },
                          output_tokens: { type: 'integer' },
                          cached_tokens: { type: ['integer', 'null'] },
                        },
                      },
                    },
                  },
                },
                users: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: [
                      'user_id',
                      'email',
                      'calls',
                      'input_tokens',
                      'output_tokens',
                      'cached_tokens',
                      'cache_hit_rate',
                      'last_used',
                    ],
                    properties: {
                      user_id: { type: 'string' },
                      email: { type: ['string', 'null'] },
                      calls: { type: 'integer' },
                      input_tokens: { type: 'integer' },
                      output_tokens: { type: 'integer' },
                      cached_tokens: { type: ['integer', 'null'] },
                      cache_hit_rate: { type: ['number', 'null'] },
                      last_used: { type: 'string' },
                    },
                  },
                },
                households: {
                  type: 'array',
                  description:
                    'Totals broken down by the household that paid (the cross-household cut; D9 funding view)',
                  items: {
                    type: 'object',
                    required: [
                      'household_id',
                      'name',
                      'calls',
                      'input_tokens',
                      'output_tokens',
                      'cached_tokens',
                      'cache_hit_rate',
                      'last_used',
                    ],
                    properties: {
                      household_id: { type: ['string', 'null'] },
                      name: { type: ['string', 'null'] },
                      calls: { type: 'integer' },
                      input_tokens: { type: 'integer' },
                      output_tokens: { type: 'integer' },
                      cached_tokens: { type: ['integer', 'null'] },
                      cache_hit_rate: { type: ['number', 'null'] },
                      last_used: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      400: { description: 'Validation error (unknown range)' },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
    },
  }),
  requireAdmin,
  sValidator('query', aiUsageRangeQuery),
  async (c) => {
    const range = c.req.valid('query').range
    const since = new Date(Date.now() - AI_USAGE_RANGE_MS[range]).toISOString()

    const totals = await c.env.DB.prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              SUM(cached_tokens) AS cached_tokens
         FROM ai_usage_events
        WHERE ts >= ?`
    )
      .bind(since)
      .first<{
        calls: number
        input_tokens: number
        output_tokens: number
        cached_tokens: number | null
      }>()

    // The cross-household cut (D1's funding view, plan §4.1): who paid, per
    // capability, over the same range. One query each, grouped in SQL.
    const { results: capabilityRows } = await c.env.DB.prepare(
      `SELECT capability,
              COUNT(*) AS calls,
              SUM(CASE WHEN provider = 'questions' THEN 1 ELSE 0 END) AS typed_calls,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              SUM(cached_tokens) AS cached_tokens
         FROM ai_usage_events
        WHERE ts >= ?
        GROUP BY capability
        -- The enum's own order (decision, reasoning, vision); unknown/null last.
        ORDER BY capability IS NULL, capability`
    )
      .bind(since)
      .all<AdminUsageCapabilityRow>()

    const { results: userRows } = await c.env.DB.prepare(
      `SELECT e.user_id,
              u.email,
              COUNT(*) AS calls,
              COALESCE(SUM(e.input_tokens), 0) AS input_tokens,
              COALESCE(SUM(e.output_tokens), 0) AS output_tokens,
              SUM(e.cached_tokens) AS cached_tokens,
              MAX(e.ts) AS last_used
         FROM ai_usage_events e
         LEFT JOIN users u ON u.id = e.user_id
        WHERE e.ts >= ?
        GROUP BY e.user_id
        -- user_id tiebreaks equal last_used stamps so the order is stable.
        ORDER BY last_used DESC, user_id ASC`
    )
      .bind(since)
      .all<{
        user_id: string
        email: string | null
        calls: number
        input_tokens: number
        output_tokens: number
        cached_tokens: number | null
        last_used: string
      }>()

    // Rows whose household was deleted keep their history with household_id
    // SET NULL (0041): they group under a null household, name null.
    const { results: householdRows } = await c.env.DB.prepare(
      `SELECT e.household_id AS household_id,
              h.name AS name,
              COUNT(*) AS calls,
              COALESCE(SUM(e.input_tokens), 0) AS input_tokens,
              COALESCE(SUM(e.output_tokens), 0) AS output_tokens,
              SUM(e.cached_tokens) AS cached_tokens,
              MAX(e.ts) AS last_used
         FROM ai_usage_events e
         LEFT JOIN households h ON h.id = e.household_id
        WHERE e.ts >= ?
        GROUP BY e.household_id
        -- household_id tiebreaks equal last_used stamps so the order is stable.
        ORDER BY last_used DESC, household_id ASC`
    )
      .bind(since)
      .all<{
        household_id: string | null
        name: string | null
        calls: number
        input_tokens: number
        output_tokens: number
        cached_tokens: number | null
        last_used: string
      }>()

    const res = c.json({
      range,
      since,
      totals: {
        calls: totals?.calls ?? 0,
        input_tokens: totals?.input_tokens ?? 0,
        output_tokens: totals?.output_tokens ?? 0,
        cached_tokens: totals?.cached_tokens ?? null,
        cache_hit_rate: cacheHitRate(totals?.cached_tokens ?? null, totals?.input_tokens ?? 0),
        capabilities: (capabilityRows ?? []).map((row) => ({
          capability: row.capability,
          calls: row.calls,
          typed_calls: row.typed_calls,
          input_tokens: row.input_tokens,
          output_tokens: row.output_tokens,
          cached_tokens: row.cached_tokens,
        })),
      },
      users: userRows.map((row) => ({
        user_id: row.user_id,
        email: row.email ?? null,
        calls: row.calls,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cached_tokens: row.cached_tokens,
        cache_hit_rate: cacheHitRate(row.cached_tokens, row.input_tokens),
        last_used: row.last_used,
      })),
      households: (householdRows ?? []).map((row) => ({
        household_id: row.household_id,
        name: row.name ?? null,
        calls: row.calls,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cached_tokens: row.cached_tokens,
        cache_hit_rate: cacheHitRate(row.cached_tokens, row.input_tokens),
        last_used: row.last_used,
      })),
    })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.post(
  '/api/ai/generate/persona',
  describeRoute({
    description:
      "Rewrites the app's interface copy in the user's declared persona roles, behind the door (#523 P5). The browser sends the two role names and the interface strings it renders; the prompt, the provider row and the key stay server-side, and the call is a REASONING capability call recorded in ai_usage_events. Roles and copy are treated as DATA (JSON-quoted in the prompt), never as instructions. Answers 402 when the household has no usable reasoning assignment, in which case the UI simply keeps its built-in copy.",
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['user_role', 'ai_role', 'copy'],
            properties: {
              user_role: { type: 'string', minLength: 1, maxLength: 200 },
              ai_role: { type: 'string', minLength: 1, maxLength: 200 },
              language: { type: 'string', enum: ['en', 'id'] },
              copy: {
                type: 'object',
                description:
                  'The interface strings to rewrite, keyed by the persona.* slots the UI renders. At least one entry; unknown keys are rejected.',
                // Derived from the canonical list: the browser's copy contract is
                // pinned to this doc, so a hand-written second copy could accept a
                // backend-only slot that the UI never sends (plan §6 P5).
                properties: Object.fromEntries(
                  PERSONA_COPY_KEYS.map((key) => [key, { type: 'string' }])
                ),
                additionalProperties: false,
              },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description:
          'The rewritten copy, keyed exactly like the request. A slot the model omitted falls back to the string that was sent.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['copy'],
              properties: {
                copy: {
                  type: 'object',
                  additionalProperties: { type: 'string' },
                },
              },
            },
          },
        },
      },
      400: { description: 'Validation error' },
      401: { description: 'Unauthorized' },
      402: { description: 'AI provider not configured' },
      429: { description: 'Too many persona rewrites' },
      502: { description: 'AI provider error, or an unusable rewrite answer' },
    },
  }),
  sValidator('json', personaCopySchema),
  async (c) => {
    const userId = c.get('userId')
    const householdId = c.get('householdId')
    const { user_role, ai_role, language, copy } = c.req.valid('json')

    // The rewrite is a REASONING call (#523 P5, plan §5.5): chat, plans and the
    // persona copy all bill the same capability, resolved once for this request.
    const aiCtx = { env: c.env, userId, householdId }
    const access = await resolveAccess(aiCtx, 'reasoning')
    if (!access) {
      return c.json(
        {
          error: 'AI provider not configured. Go to Settings to set up your AI key.',
        },
        402
      )
    }

    // The limiter sits AFTER the 402 gate: only a household that can actually
    // spend needs throttling, and an unconfigured one keeps getting the honest
    // answer instead of a 429 that implies a request would otherwise run.
    const { limited, retryAfter } = isRateLimited(
      `ai-persona:${userId}`,
      PERSONA_RATE_WINDOW_MS,
      PERSONA_RATE_MAX
    )
    if (limited) {
      return c.json({ error: 'Too many persona rewrites. Please slow down.' }, 429, {
        'Retry-After': String(retryAfter),
      })
    }

    const requested = copy as PersonaCopyInput
    const promptLanguage: PersonaCopyLanguage = language ?? 'en'

    // The attempt's call dimensions + tokens: success overwrites them, and the
    // TEST_MODE stub records the resolved assignment with zero tokens (the
    // chat/plan precedent).
    let generated: PersonaCopyInput
    let usedCall: AiCall = access.call
    let tokenUsage: TokenUsage = EMPTY_USAGE

    if (c.env.TEST_MODE === 'true') {
      // No provider in TEST_MODE: hand back the caller's own strings unchanged,
      // so the persona flow is exercisable end to end without a key.
      generated = requested
    } else {
      try {
        const result = await generatePersonaCopy(
          { ...aiCtx, access },
          {
            userRole: user_role,
            aiRole: ai_role,
            language: promptLanguage,
            copy: requested,
          }
        )
        generated = result.copy
        usedCall = result.call
        tokenUsage = result.usage
      } catch (err) {
        // An unusable answer is billed too: `AiError('invalid_response', …)`
        // carries the call's usage (plan §2.2).
        await recordAiFailureUsage(c.env, userId, { call: usedCall, usage: tokenUsage }, err)
        return c.json(
          {
            error: `AI persona rewrite failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
          },
          502
        )
      }
    }

    await recordAiCallUsage(c.env, userId, usedCall, tokenUsage)

    const res = c.json({ copy: generated })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)
apiApp.post(
  '/api/ai/chat',
  describeRoute({
    description: 'Send a message to the household-scoped assistant and receive a reply.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['message'],
            properties: {
              message: { type: 'string', minLength: 1, maxLength: 4000 },
              history: {
                type: 'array',
                maxItems: 10,
                items: {
                  type: 'object',
                  required: ['role', 'content'],
                  properties: {
                    role: { type: 'string', enum: ['user', 'assistant'] },
                    content: { type: 'string', minLength: 1, maxLength: 4000 },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'Reply' },
      400: { description: 'Validation error' },
      401: { description: 'Unauthorized' },
      402: { description: 'AI key not configured' },
      502: { description: 'AI provider error' },
    },
  }),
  sValidator('json', chatSchema),
  async (c) => {
    const userId = c.get('userId')
    const householdId = c.get('householdId')
    const { message, history } = c.req.valid('json')

    // Only the persona fields are this route's own read: the AI configuration is
    // the household's rows, resolved by the door (#523 P3 dropped the legacy
    // `user_settings.ai_*` projection this query used to carry).
    const settings = await c.env.DB.prepare(
      `SELECT persona_enabled, persona_user_role, persona_ai_role
         FROM user_settings WHERE user_id = ?`
    )
      .bind(userId)
      .first<{
        persona_enabled: number | null
        persona_user_role: string | null
        persona_ai_role: string | null
      }>()

    // Chat answers are a REASONING call (#523 P4, plan §5.5): the capability is
    // resolved once for this request and the door dispatches on that handle.
    const aiCtx = { env: c.env, userId, householdId }
    const access = await resolveAccess(aiCtx, 'reasoning')
    if (!access) {
      return c.json(
        {
          error: 'AI provider not configured. Go to Settings to set up your AI key.',
        },
        402
      )
    }

    // Usage is recorded per call but never gates it (issue #353 removed the
    // daily cap; BYOK is the norm and no rate limit is ever applied, #523).

    let reply: string
    // The attempt's call dimensions + tokens: success overwrites them below,
    // and the TEST_MODE stub records the resolved assignment with zero tokens.
    let usedCall: AiCall = access.call
    let tokenUsage: TokenUsage = EMPTY_USAGE
    if (c.env.TEST_MODE === 'true') {
      reply = `(test) You asked: "${message}". Based on your household stock, consider checking your low items soon.`
    } else {
      const lowStock = await c.env.DB.prepare(
        `SELECT i.name, s.qty, s.unit, s.run_out_days, s.expiry_date
           FROM stock s JOIN items i ON i.id = s.item_id
          WHERE s.household_id = ? AND s.qty > 0
            AND (COALESCE(s.run_out_days, 999) <= 7 OR s.run_out_days IS NULL)`
      )
        .bind(householdId)
        .all<{
          name: string
          qty: number
          unit: string | null
          run_out_days: number | null
          expiry_date: string | null
        }>()

      const sevenDaysFromNow = new Date()
      sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7)
      const expiryCutoff = sevenDaysFromNow.toISOString().slice(0, 10)

      const expiring = await c.env.DB.prepare(
        `SELECT i.name, s.qty, s.unit, s.expiry_date
           FROM stock s JOIN items i ON i.id = s.item_id
          WHERE s.household_id = ? AND s.qty > 0
            AND s.expiry_date IS NOT NULL AND s.expiry_date <= ?`
      )
        .bind(householdId, expiryCutoff)
        .all<{
          name: string
          qty: number
          unit: string | null
          expiry_date: string | null
        }>()

      const recentPurchases = await c.env.DB.prepare(
        `SELECT DISTINCT i.name, s.label AS store_label
           FROM purchase_items pi
           JOIN purchases p ON p.id = pi.purchase_id
           JOIN items i ON i.id = pi.item_id
           LEFT JOIN stores s ON s.id = p.store_id
          WHERE p.household_id = ? AND p.date >= ?
          ORDER BY i.name`
      )
        .bind(householdId, expiryCutoff)
        .all<{ name: string; store_label: string | null }>()

      const activePlan = await c.env.DB.prepare(
        `SELECT pi.qty, pi.unit, i.name, s.label AS store_label
           FROM plan_items pi
           JOIN plans p ON p.id = pi.plan_id
           JOIN items i ON i.id = pi.item_id
           LEFT JOIN stores s ON s.id = pi.store_id
          WHERE p.household_id = ? AND p.status = 'active' AND pi.status = 'pending'
          ORDER BY pi.created_at`
      )
        .bind(householdId)
        .all<{
          name: string
          qty: number
          unit: string
          store_label: string | null
        }>()

      try {
        const result = await sendChatMessage(
          { ...aiCtx, access },
          {
            persona: settings
              ? {
                  persona_enabled: settings.persona_enabled,
                  persona_user_role: settings.persona_user_role,
                  persona_ai_role: settings.persona_ai_role,
                }
              : null,
            lowStock: lowStock.results || [],
            expiring: expiring.results || [],
            activePlan: activePlan.results || [],
            recentPurchases: recentPurchases.results || [],
          },
          message,
          history || []
        )
        reply = result.text
        usedCall = result.call
        tokenUsage = result.usage
      } catch (err) {
        // The provider billed the failed attempt's input tokens; record them
        // as the call's event even though no reply came back.
        await recordAiFailureUsage(c.env, userId, { call: usedCall, usage: tokenUsage }, err)
        return c.json(
          {
            error: `AI chat failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
          },
          502
        )
      }
    }

    await recordAiCallUsage(c.env, userId, usedCall, tokenUsage)

    const res = c.json({ reply })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.post(
  '/api/purchases/scan',
  describeRoute({
    description: 'Upload a receipt image, scan with AI OCR, return parsed items.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: { description: 'Scan complete' },
      400: { description: 'Invalid input' },
      401: { description: 'Unauthorized' },
      402: { description: 'AI key not configured' },
      502: { description: 'AI provider error' },
    },
  }),
  async (c) => {
    const userId = c.get('userId')
    const householdId = c.get('householdId')

    const contentType = c.req.header('Content-Type') || ''
    if (!contentType.includes('multipart/form-data')) {
      return c.json({ error: 'Expected multipart/form-data' }, 400)
    }

    let file: { name: string; data: ArrayBuffer; type: string } | undefined
    try {
      const formData = await c.req.parseBody()
      const uploaded = formData['image']
      if (uploaded && typeof uploaded !== 'string' && 'arrayBuffer' in uploaded) {
        file = {
          name: uploaded.name,
          data: await uploaded.arrayBuffer(),
          type: uploaded.type,
        }
      }
    } catch {
      return c.json({ error: 'Failed to parse upload' }, 400)
    }

    if (!file) {
      return c.json({ error: 'No image file provided. Use field name "image".' }, 400)
    }

    const fileObj = { type: file.type, size: file.data.byteLength }
    const validationError = validateImage(fileObj)
    if (validationError) {
      return c.json({ error: validationError }, 400)
    }

    // THE SCAN-TO-VISION FIX (#523 P4, plan §5.5): a receipt is read by the
    // VISION capability, not by the text/reasoning model the legacy shim
    // dispatched every path to. A household that set a vision model expects it
    // to read receipts — this is that expectation, made true.
    const aiCtx = { env: c.env, userId, householdId }
    const access = await resolveAccess(aiCtx, 'vision')
    if (!access) {
      return c.json(
        {
          error: 'AI provider not configured. Go to Settings to set up your AI key.',
        },
        402
      )
    }

    const ext = extFromType(file.type)
    const key = buildKey(householdId, userId, ext)

    try {
      await uploadReceipt(c.env.RECEIPTS, file.data, key, file.type)
    } catch {
      return c.json({ error: 'Failed to upload receipt image' }, 500)
    }

    let scanResult
    // The attempt's call dimensions + tokens (success overwrites them).
    let usedCall: AiCall = access.call
    let tokenUsage: TokenUsage = EMPTY_USAGE
    if (c.env.TEST_MODE === 'true') {
      scanResult = {
        store_name: 'Indomaret',
        date: new Date().toISOString().slice(0, 10),
        items: [
          { name: 'Susu cair 1L', qty: 1, unit: 'L', price: 18500 },
          { name: 'Roti tawar', qty: 1, unit: 'pack', price: 15000 },
          { name: 'Telur 10pcs', qty: 1, unit: 'pkg', price: 32000 },
        ],
      }
    } else {
      try {
        const result = await vision({
          ...aiCtx,
          access,
          // The feature's prompt and the image, in one user turn.
          parts: [
            { type: 'text', text: buildScanPrompt() },
            { type: 'image', bytes: file.data, mimeType: file.type },
          ],
        })
        // The call's dimensions + tokens are captured BEFORE the answer is
        // parsed: a reply that fails the parser was still a billed call, and
        // the catch below must record it (plan §2.2).
        usedCall = result.call
        tokenUsage = result.usage
        scanResult = parseScanResult(result.text)
      } catch (err) {
        // The provider billed the failed attempt's input tokens; record them
        // as the call's event even though no scan came back.
        await recordAiFailureUsage(c.env, userId, { call: usedCall, usage: tokenUsage }, err)
        return c.json(
          {
            error: `AI scan failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
            imageKey: key,
          },
          502
        )
      }
    }

    await recordAiCallUsage(c.env, userId, usedCall, tokenUsage)

    const imageUrl: string | null = getSignedUrl()

    let storeGuess: { id: string; label: string } | null = null
    if (scanResult.store_name) {
      const match = await c.env.DB.prepare(
        'SELECT id, label FROM stores WHERE household_id = ? AND LOWER(label) = LOWER(?)'
      )
        .bind(householdId, scanResult.store_name)
        .first<{ id: string; label: string }>()
      if (match) {
        storeGuess = match
      }
    }

    const res = c.json({
      items: scanResult.items,
      imageKey: key,
      imageUrl,
      storeGuess,
      dateGuess: scanResult.date || null,
    })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.post(
  '/api/purchases',
  describeRoute({
    description:
      "Create a purchase with items, updating stock and purchase history. A supplied item_id must belong to the caller's household — foreign and unknown ids answer 404 and write nothing.",
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['date', 'items'],
            properties: {
              store_id: { type: 'string' },
              date: { type: 'string', minLength: 1 },
              receipt_image_key: { type: 'string' },
              items: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  required: ['name', 'qty', 'unit', 'price'],
                  properties: {
                    name: { type: 'string', minLength: 1 },
                    qty: { type: 'number', minimum: 0 },
                    unit: { type: 'string' },
                    price: { type: 'integer', minimum: 0 },
                    item_id: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'Purchase created' },
      400: { description: 'Validation error' },
      401: { description: 'Unauthorized' },
      404: { description: 'Item not found in this household' },
    },
  }),
  sValidator('json', purchaseCreateSchema),
  async (c) => {
    const householdId = c.get('householdId')
    const body = c.req.valid('json')

    if (body.store_id) {
      const store = await c.env.DB.prepare(
        'SELECT id FROM stores WHERE id = ? AND household_id = ?'
      )
        .bind(body.store_id, householdId)
        .first()
      if (!store) {
        return c.json({ error: 'Store not found in this household' }, 400)
      }
    }

    const defaultLocation = await c.env.DB.prepare(
      'SELECT id FROM locations WHERE household_id = ? ORDER BY sort_order LIMIT 1'
    )
      .bind(householdId)
      .first<{ id: string }>()

    const purchaseId = crypto.randomUUID()
    const now = new Date().toISOString()

    const statements: D1PreparedStatement[] = []

    statements.push(
      c.env.DB.prepare(
        'INSERT INTO purchases (id, household_id, store_id, date, receipt_image_key, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(
        purchaseId,
        householdId,
        body.store_id || null,
        body.date,
        body.receipt_image_key || null,
        now
      )
    )

    const itemIds: string[] = []

    for (const item of body.items) {
      let itemId: string

      if (item.item_id) {
        // #517 (security): the receipt client names the item it is buying, so
        // the id is client-supplied and must resolve INSIDE the household — a
        // foreign id would otherwise write another household's item (and its
        // name, via the purchase_items → items join) into this household's
        // stock and history. Unknown and foreign ids are indistinguishable:
        // same 404, and the batch below never runs, so nothing is written.
        const owned = await c.env.DB.prepare(
          'SELECT id FROM items WHERE id = ? AND household_id = ?'
        )
          .bind(item.item_id, householdId)
          .first<{ id: string }>()

        if (!owned) {
          return c.json({ error: 'Item not found' }, 404)
        }
        itemId = owned.id
      } else {
        const trimmed = item.name.trim().toLowerCase()
        const existing = await c.env.DB.prepare(
          'SELECT id FROM items WHERE household_id = ? AND LOWER(name) = LOWER(?)'
        )
          .bind(householdId, trimmed)
          .first<{ id: string }>()

        if (existing) {
          itemId = existing.id
        } else {
          itemId = crypto.randomUUID()
          statements.push(
            c.env.DB.prepare(
              'INSERT INTO items (id, household_id, name, default_unit) VALUES (?, ?, ?, ?)'
            ).bind(itemId, householdId, item.name.trim(), item.unit)
          )
        }
      }

      itemIds.push(itemId)

      const purchaseItemId = crypto.randomUUID()
      statements.push(
        c.env.DB.prepare(
          'INSERT INTO purchase_items (id, purchase_id, item_id, qty, unit, price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(purchaseItemId, purchaseId, itemId, item.qty, item.unit, item.price, now)
      )

      const existingStock = await c.env.DB.prepare(
        'SELECT id, qty FROM stock WHERE household_id = ? AND item_id = ?'
      )
        .bind(householdId, itemId)
        .first<{ id: string; qty: number }>()

      if (existingStock) {
        const newQty = existingStock.qty + item.qty
        const runOut = await computeRunOutDays(householdId, itemId, newQty, c.env.DB)
        statements.push(
          c.env.DB.prepare(
            `UPDATE stock SET qty = ?, run_out_days = ?, basis = ?, updated_at = datetime('now') WHERE id = ? AND household_id = ?`
          ).bind(newQty, runOut.run_out_days, runOut.basis, existingStock.id, householdId)
        )
      } else {
        const stockId = crypto.randomUUID()
        const locationId = defaultLocation?.id || null
        statements.push(
          c.env.DB.prepare(
            'INSERT INTO stock (id, household_id, item_id, location_id, qty, unit, run_out_days, basis, updated_at) VALUES (?, ?, ?, ?, ?, ?, 30, ?, ?)'
          ).bind(stockId, householdId, itemId, locationId, item.qty, item.unit, 'default', now)
        )
      }
    }

    try {
      await c.env.DB.batch(statements)
    } catch (err) {
      return c.json(
        {
          error: `Failed to create purchase: ${err instanceof Error ? err.message : 'Unknown'}`,
        },
        500
      )
    }

    const purchase = await c.env.DB.prepare(
      `SELECT p.id, p.store_id, s.label AS store_label, p.date, p.total, p.receipt_image_key, p.created_at
       FROM purchases p
       LEFT JOIN stores s ON s.id = p.store_id
       WHERE p.id = ?`
    )
      .bind(purchaseId)
      .first()

    const purchaseItems = await c.env.DB.prepare(
      `SELECT pi.id, pi.item_id, i.name, pi.qty, pi.unit, pi.price
       FROM purchase_items pi
       JOIN items i ON i.id = pi.item_id
       WHERE pi.purchase_id = ?`
    )
      .bind(purchaseId)
      .all()

    const updatedStock = await c.env.DB.prepare(
      `SELECT s.id, i.name, s.qty, s.unit, s.run_out_days, s.basis, l.label AS location
       FROM stock s
       JOIN items i ON i.id = s.item_id
       LEFT JOIN locations l ON l.id = s.location_id
       WHERE s.item_id IN (${itemIds.map(() => '?').join(',')}) AND s.household_id = ?`
    )
      .bind(...itemIds, householdId)
      .all()

    const res = c.json(
      {
        purchase,
        items: purchaseItems.results,
        stock: updatedStock.results,
      },
      201
    )
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.get(
  '/api/purchases/:id/receipt',
  describeRoute({
    description: 'Stream a receipt image from R2.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: { description: 'Image stream' },
      401: { description: 'Unauthorized' },
      404: { description: 'Not found' },
    },
  }),
  async (c) => {
    const purchaseId = c.req.param('id')
    const householdId = c.get('householdId')

    const purchase = await c.env.DB.prepare(
      'SELECT receipt_image_key FROM purchases WHERE id = ? AND household_id = ?'
    )
      .bind(purchaseId, householdId)
      .first<{ receipt_image_key: string | null }>()

    if (!purchase || !purchase.receipt_image_key) {
      return c.json({ error: 'Receipt not found' }, 404)
    }

    const object = await c.env.RECEIPTS.get(purchase.receipt_image_key)
    if (!object) {
      return c.json({ error: 'Receipt image not found in storage' }, 404)
    }

    const headers = new Headers()
    headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg')
    headers.set('Cache-Control', 'private, no-cache')

    const body = await object.blob()
    return new Response(body, { headers })
  }
)

// Brochure image proxy (issue #293): private R2 objects served only through
// the Worker, same pattern as the receipt route. propsAuthMiddleware rides
// in the handler chain explicitly (not via a use() prefix — immune to
// future use() reordering); the distinct /api/brochures/* prefix has no
// param-route collision. Keys are immutable (content-addressed filename +
// scrape date), so one day of private browser caching is safe and keeps
// segment-toggling from re-fetching the grid.
apiApp.get(
  '/api/brochures/:storeSlug/:date/:file',
  propsAuthMiddleware,
  describeRoute({
    description: 'Stream a brochure image from R2.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: { description: 'Image stream' },
      401: { description: 'Unauthorized' },
      404: { description: 'Not found' },
    },
  }),
  async (c) => {
    if (!c.env.BROCHURES) {
      return c.json({ error: 'Brochure storage not configured' }, 503)
    }
    const key = parseBrochureKey(c.req.param('storeSlug'), c.req.param('date'), c.req.param('file'))
    if (!key) {
      return c.json({ error: 'Brochure not found' }, 404)
    }
    const object = await c.env.BROCHURES.get(key)
    if (!object) {
      return c.json({ error: 'Brochure not found' }, 404)
    }
    const headers = new Headers()
    headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg')
    headers.set('Cache-Control', 'private, max-age=86400')
    return new Response(await object.blob(), { headers })
  }
)

apiApp.get(
  '/api/purchases/patterns',
  describeRoute({
    description: 'Return top purchase patterns for the active household (avg interval, avg qty).',
    security: [{ cookieAuth: [] }],
    responses: {
      200: { description: 'OK' },
      401: { description: 'Unauthorized' },
    },
  }),
  async (c) => {
    const householdId = c.get('householdId')
    const patterns = await computePatterns(householdId, c.env.DB)
    const res = c.json({ patterns })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.get(
  '/api/purchases',
  describeRoute({
    description: 'List purchase history for the active household with filters and pagination.',
    security: [{ cookieAuth: [] }],
    parameters: [
      { in: 'query', name: 'store', required: false, schema: { type: 'string' } },
      { in: 'query', name: 'from', required: false, schema: { type: 'string' } },
      { in: 'query', name: 'to', required: false, schema: { type: 'string' } },
      { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
      {
        in: 'query',
        name: 'group_by',
        required: false,
        schema: { type: 'string', enum: ['month', 'store'] },
      },
      {
        in: 'query',
        name: 'limit',
        required: false,
        schema: { type: 'integer', minimum: 1 },
      },
      { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
    ],
    responses: {
      200: { description: 'OK' },
      401: { description: 'Unauthorized' },
    },
  }),
  sValidator('query', purchasesQuery),
  async (c) => {
    const householdId = c.get('householdId')
    const { store, from, to, q, group_by, limit, cursor } = c.req.valid('query')
    void group_by

    const pageSize = Math.min(Math.max(Number(limit ?? 50), 1), 100)

    let sql =
      'SELECT p.id, p.store_id, s.label AS store_label, p.date, p.total, p.receipt_image_key, p.created_at FROM purchases p LEFT JOIN stores s ON s.id = p.store_id WHERE p.household_id = ?'
    const params: unknown[] = [householdId]
    if (store) {
      sql += ' AND p.store_id = ?'
      params.push(store)
    }
    if (from) {
      sql += ' AND p.date >= ?'
      params.push(from)
    }
    if (to) {
      sql += ' AND p.date <= ?'
      params.push(to)
    }
    if (q) {
      sql +=
        ' AND p.id IN (SELECT pi.purchase_id FROM purchase_items pi JOIN items i ON i.id = pi.item_id WHERE i.name LIKE ?)'
      params.push(`%${q}%`)
    }
    if (cursor) {
      const sep = cursor.indexOf('|')
      const cursorDate = sep >= 0 ? cursor.slice(0, sep) : cursor
      const cursorCreated = sep >= 0 ? cursor.slice(sep + 1) : ''
      sql += ' AND (p.date < ? OR (p.date = ? AND p.created_at < ?))'
      params.push(cursorDate, cursorDate, cursorCreated)
    }
    sql += ' ORDER BY p.date DESC, p.created_at DESC LIMIT ?'
    params.push(pageSize + 1)

    const { results } = await c.env.DB.prepare(sql)
      .bind(...params)
      .all<{
        id: string
        store_id: string | null
        store_label: string | null
        date: string
        total: number | null
        receipt_image_key: string | null
        created_at: string
      }>()

    const hasMore = results.length > pageSize
    const purchases = hasMore ? results.slice(0, pageSize) : results
    const nextCursor =
      hasMore && purchases.length > 0
        ? `${purchases[purchases.length - 1].date}|${purchases[purchases.length - 1].created_at}`
        : null

    const itemsByPurchase = new Map<
      string,
      Array<{
        id: string
        item_id: string | null
        name: string | null
        qty: number
        unit: string | null
        price: number | null
      }>
    >()
    if (purchases.length > 0) {
      const placeholders = purchases.map(() => '?').join(',')
      const purchaseIds = purchases.map((p) => p.id)
      const { results: items } = await c.env.DB.prepare(
        `SELECT pi.id, pi.purchase_id, pi.item_id, i.name, pi.qty, pi.unit, pi.price
           FROM purchase_items pi
           LEFT JOIN items i ON i.id = pi.item_id
          WHERE pi.purchase_id IN (${placeholders})`
      )
        .bind(...purchaseIds)
        .all<{
          purchase_id: string
          id: string
          item_id: string | null
          name: string | null
          qty: number
          unit: string | null
          price: number | null
        }>()
      for (const it of items) {
        const list = itemsByPurchase.get(it.purchase_id) || []
        list.push({
          id: it.id,
          item_id: it.item_id,
          name: it.name,
          qty: it.qty,
          unit: it.unit,
          price: it.price,
        })
        itemsByPurchase.set(it.purchase_id, list)
      }
    }

    const purchasesWithItems = purchases.map((p) => ({
      id: p.id,
      store_id: p.store_id,
      store_label: p.store_label,
      date: p.date,
      total: p.total,
      receipt_image_key: p.receipt_image_key,
      has_receipt: !!p.receipt_image_key,
      created_at: p.created_at,
      items: itemsByPurchase.get(p.id) || [],
    }))

    let monthSql =
      "SELECT strftime('%Y-%m', p.date) AS month, COUNT(p.id) AS count, COALESCE(SUM(p.total), 0) AS total FROM purchases p WHERE p.household_id = ?"
    const monthParams: unknown[] = [householdId]
    if (store) {
      monthSql += ' AND p.store_id = ?'
      monthParams.push(store)
    }
    if (from) {
      monthSql += ' AND p.date >= ?'
      monthParams.push(from)
    }
    if (to) {
      monthSql += ' AND p.date <= ?'
      monthParams.push(to)
    }
    if (q) {
      monthSql +=
        ' AND p.id IN (SELECT pi.purchase_id FROM purchase_items pi JOIN items i ON i.id = pi.item_id WHERE i.name LIKE ?)'
      monthParams.push(`%${q}%`)
    }
    monthSql += ' GROUP BY month ORDER BY month DESC'
    const { results: monthTotals } = await c.env.DB.prepare(monthSql)
      .bind(...monthParams)
      .all<{ month: string; count: number; total: number }>()

    const avgPerMonth =
      monthTotals.length > 0
        ? Math.round(monthTotals.reduce((sum, m) => sum + m.total, 0) / monthTotals.length)
        : 0

    const res = c.json({
      purchases: purchasesWithItems,
      next_cursor: nextCursor,
      month_totals: monthTotals,
      avg_per_month: avgPerMonth,
    })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.get(
  '/api/purchases/:id',
  describeRoute({
    description: 'Return a single purchase with all its items.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: { description: 'OK' },
      401: { description: 'Unauthorized' },
      404: { description: 'Not found' },
    },
  }),
  async (c) => {
    const purchaseId = c.req.param('id')
    const householdId = c.get('householdId')

    const purchase = await c.env.DB.prepare(
      `SELECT p.id, p.store_id, s.label AS store_label, p.date, p.total, p.receipt_image_key, p.created_at
         FROM purchases p
         LEFT JOIN stores s ON s.id = p.store_id
        WHERE p.id = ? AND p.household_id = ?`
    )
      .bind(purchaseId, householdId)
      .first<{
        id: string
        store_id: string | null
        store_label: string | null
        date: string
        total: number | null
        receipt_image_key: string | null
        created_at: string
      }>()

    if (!purchase) {
      return c.json({ error: 'Purchase not found' }, 404)
    }

    const { results: items } = await c.env.DB.prepare(
      `SELECT pi.id, pi.item_id, i.name, pi.qty, pi.unit, pi.price
         FROM purchase_items pi
         LEFT JOIN items i ON i.id = pi.item_id
        WHERE pi.purchase_id = ?
        ORDER BY pi.created_at`
    )
      .bind(purchaseId)
      .all<{
        id: string
        item_id: string | null
        name: string | null
        qty: number
        unit: string | null
        price: number | null
      }>()

    const res = c.json({
      purchase: {
        ...purchase,
        has_receipt: !!purchase.receipt_image_key,
      },
      items,
    })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.get(
  '/api/locations',
  describeRoute({
    description: 'Lists locations for the active household.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: { description: 'OK' },
      401: { description: 'Unauthorized' },
    },
  }),
  async (c) => {
    const { results } = await c.env.DB.prepare(
      'SELECT id, label, sort_order FROM locations WHERE household_id = ? ORDER BY sort_order, label'
    )
      .bind(c.get('householdId'))
      .all()
    const res = c.json({ locations: results })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.post(
  '/api/locations',
  describeRoute({
    description: 'Creates a new location for the active household.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['label'],
            properties: { label: { type: 'string', minLength: 1, maxLength: 100 } },
          },
        },
      },
    },
    responses: {
      201: { description: 'Created' },
      400: { description: 'Validation error' },
      401: { description: 'Unauthorized' },
    },
  }),
  sValidator('json', locationSchema),
  async (c) => {
    const { label } = c.req.valid('json')

    const id = crypto.randomUUID()
    const sortOrder = await c.env.DB.prepare(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM locations WHERE household_id = ?'
    )
      .bind(c.get('householdId'))
      .first<{ next: number }>()

    await c.env.DB.prepare(
      'INSERT INTO locations (id, household_id, label, sort_order) VALUES (?, ?, ?, ?)'
    )
      .bind(id, c.get('householdId'), label, sortOrder?.next ?? 1)
      .run()

    const created = await c.env.DB.prepare(
      'SELECT id, label, sort_order FROM locations WHERE id = ? AND household_id = ?'
    )
      .bind(id, c.get('householdId'))
      .first()

    const res = c.json({ location: created }, 201)
    return res
  }
)

apiApp.delete(
  '/api/locations/:id',
  describeRoute({
    description: 'Deletes a location if not referenced by stock.',
    security: [{ cookieAuth: [] }],
    responses: {
      204: { description: 'Deleted' },
      404: { description: 'Not found' },
      409: { description: 'Conflict - location in use' },
    },
  }),
  async (c) => {
    const locationId = c.req.param('id')

    const location = await c.env.DB.prepare(
      'SELECT id FROM locations WHERE id = ? AND household_id = ?'
    )
      .bind(locationId, c.get('householdId'))
      .first()

    if (!location) {
      return c.json({ error: 'Location not found' }, 404)
    }

    const stockRef = await c.env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM stock WHERE location_id = ?'
    )
      .bind(locationId)
      .first<{ cnt: number }>()

    if (stockRef && stockRef.cnt > 0) {
      return c.json({ error: 'Cannot delete location because it is used by stock items' }, 409)
    }

    await c.env.DB.prepare('DELETE FROM locations WHERE id = ? AND household_id = ?')
      .bind(locationId, c.get('householdId'))
      .run()

    return c.newResponse(null, 204)
  }
)

apiApp.get(
  '/api/items',
  describeRoute({
    description: 'Lists items for the active household.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: { description: 'OK' },
      401: { description: 'Unauthorized' },
    },
  }),
  async (c) => {
    const { results } = await c.env.DB.prepare(
      'SELECT id, name, default_unit AS unit, category FROM items WHERE household_id = ? ORDER BY name'
    )
      .bind(c.get('householdId'))
      .all()
    const res = c.json({ items: results })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.get(
  '/api/stores',
  describeRoute({
    description: 'Lists stores for the active household.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: { description: 'OK' },
      401: { description: 'Unauthorized' },
    },
  }),
  async (c) => {
    const { results } = await c.env.DB.prepare(
      'SELECT id, label FROM stores WHERE household_id = ? ORDER BY label'
    )
      .bind(c.get('householdId'))
      .all()
    const res = c.json({ stores: results })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.post(
  '/api/stores',
  describeRoute({
    description: 'Creates a new store for the active household.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['label'],
            properties: { label: { type: 'string', minLength: 1, maxLength: 100 } },
          },
        },
      },
    },
    responses: {
      201: { description: 'Created' },
      400: { description: 'Validation error' },
      401: { description: 'Unauthorized' },
    },
  }),
  sValidator('json', storeSchema),
  async (c) => {
    const { label } = c.req.valid('json')

    const id = crypto.randomUUID()
    await c.env.DB.prepare('INSERT INTO stores (id, household_id, label) VALUES (?, ?, ?)')
      .bind(id, c.get('householdId'), label)
      .run()

    const created = await c.env.DB.prepare(
      'SELECT id, label FROM stores WHERE id = ? AND household_id = ?'
    )
      .bind(id, c.get('householdId'))
      .first()

    const res = c.json({ store: created }, 201)
    return res
  }
)

apiApp.delete(
  '/api/stores/:id',
  describeRoute({
    description: 'Deletes a store if not referenced by purchases or plans.',
    security: [{ cookieAuth: [] }],
    responses: {
      204: { description: 'Deleted' },
      404: { description: 'Not found' },
      409: { description: 'Conflict - store in use' },
    },
  }),
  async (c) => {
    const storeId = c.req.param('id')

    const store = await c.env.DB.prepare('SELECT id FROM stores WHERE id = ? AND household_id = ?')
      .bind(storeId, c.get('householdId'))
      .first()

    if (!store) {
      return c.json({ error: 'Store not found' }, 404)
    }

    const purchaseRef = await c.env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM purchases WHERE store_id = ?'
    )
      .bind(storeId)
      .first<{ cnt: number }>()

    if (purchaseRef && purchaseRef.cnt > 0) {
      return c.json({ error: 'Cannot delete store because it is used by purchases' }, 409)
    }

    const planRef = await c.env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM plan_items WHERE store_id = ?'
    )
      .bind(storeId)
      .first<{ cnt: number }>()

    if (planRef && planRef.cnt > 0) {
      return c.json({ error: 'Cannot delete store because it is used by plan items' }, 409)
    }

    await c.env.DB.prepare('DELETE FROM stores WHERE id = ? AND household_id = ?')
      .bind(storeId, c.get('householdId'))
      .run()

    return c.newResponse(null, 204)
  }
)

// Price explorer over the scraper-fed global price tables
// (docs/plan/haqita-integration.md §5.3). Observations below the ingest
// confidence floor are hidden; 0.55–0.85 rows are returned flagged. The
// confidence floor and the latest-observation predicate are shared with the
// promo catalog via lib/prices.ts (issue #292).
const PRICE_LOW_CONFIDENCE_FLAG = 0.85

// Product page size for sorted list queries. LIMIT 200 + 1 so the `truncated`
// flag is precise (201st product existed) instead of a row-count heuristic.
const PRICE_LIST_LIMIT = 200
const PRICE_PAGE_LIMIT = PRICE_LIST_LIMIT + 1

// Fixed ORDER BY fragments per sort value (issue #291 design §1.2). User
// input only ever selects a key of this map — it is never interpolated into
// SQL. `page` and the outer query share the primary expression so row order
// equals product order; ties resolve by name, then stable ids.
const PRICE_SORTS = {
  name: { page: 'pp.name COLLATE NOCASE', outer: 'l.name COLLATE NOCASE' },
  cheapest: { page: 'a.price_min', outer: 'a.price_min' },
  savings: {
    page: 'CASE WHEN a.price_max > a.price_min THEN 0 ELSE 1 END, a.savings_pct DESC',
    outer: 'CASE WHEN a.price_max > a.price_min THEN 0 ELSE 1 END, a.savings_pct DESC',
  },
  expiry: {
    page: 'CASE WHEN ch.cheapest_valid_until IS NULL THEN 1 ELSE 0 END, ch.cheapest_valid_until',
    outer: 'CASE WHEN ch.cheapest_valid_until IS NULL THEN 1 ELSE 0 END, ch.cheapest_valid_until',
  },
} as const

// Optional q / source / category filters shared by the legacy flat query and
// the sorted CTE pipeline. Inside the CTE the aggregates (price_min,
// savings_pct, …) reflect exactly the filtered set the user is looking at.
function buildPriceFilters(
  q: string | undefined,
  source: string | undefined,
  category: string | undefined
) {
  let sql = ''
  const params: unknown[] = []
  if (q) {
    sql += ` AND (p.name LIKE ? ESCAPE '\\' OR p.brand LIKE ? ESCAPE '\\' OR p.product_key LIKE ? ESCAPE '\\')`
    const pattern = `%${escapeLike(q)}%`
    params.push(pattern, pattern, pattern)
  }
  if (source) {
    sql += ' AND s.slug = ?'
    params.push(source)
  }
  // Issue #373: exact slug equality — the value domain is the meta
  // endpoint's categories list, so a LIKE here would blur slug boundaries.
  if (category) {
    sql += ' AND p.category = ?'
    params.push(category)
  }
  return { sql, params }
}

type PriceListRow = {
  product_key: string
  name: string
  brand: string | null
  unit: string | null
  category: string | null
  source_slug: string
  source_name: string
  observed_date: string
  price: number
  effective_unit_price: number | null
  // Canonical unit normalization (issue #368 phase A): null when the
  // observation was not normalizable.
  unit_qty: number | null
  unit_qty_unit: 'g' | 'ml' | 'pcs' | null
  unit_price: number | null
  promo_type: string | null
  promo_label: string | null
  valid_from: string | null
  valid_until: string | null
  match_method: string | null
  match_confidence: number
  brochure_url: string | null
}

type PriceAggregateFields = {
  price_min: number
  price_max: number
  savings_pct: number
  cheapest_source_slug: string
  cheapest_valid_until: string | null
}

// Admin scraping monitor (§7.1): run history with per-run detail and
// last-success age. 403 for non-admin users (requireAdmin); logs
// themselves stay in journald on the VPS.
apiApp.get(
  '/api/admin/price-runs',
  describeRoute({
    description: 'Recent scraper run reports (admin-only).',
    security: [{ cookieAuth: [] }],
    responses: {
      200: { description: 'OK' },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
    },
  }),
  requireAdmin,
  async (c) => {
    const feed = await listPriceRuns(c.env.DB)
    const res = c.json(feed)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

// Scrape Now (docs/plan/scrape-now.md §3): admin-triggered, store-selectable
// scraping. The POST queues a command the VPS agent claims over the internal
// bearer channel; events/commands endpoints feed the live log and history.
apiApp.get(
  '/api/admin/scrape/stores',
  describeRoute({
    description: 'Stores available for an on-demand scrape (admin-only).',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                stores: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
    },
  }),
  requireAdmin,
  (c) => {
    const res = c.json({ stores: [...SCRAPE_STORE_SLUGS] })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.post(
  '/api/admin/scrape',
  describeRoute({
    description:
      'Queue an on-demand scrape of the given stores (admin-only). 409 when a scrape is already pending or running — one run at a time.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['stores'],
            properties: {
              stores: {
                type: 'array',
                items: { type: 'string', enum: [...SCRAPE_STORE_SLUGS] },
                minItems: 1,
              },
            },
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Created',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { id: { type: 'string' } },
            },
          },
        },
      },
      400: { description: 'Validation error (unknown store slug)' },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
      409: { description: 'A scrape is already pending or running' },
    },
  }),
  requireAdmin,
  sValidator('json', scrapeCommandCreateSchema),
  async (c) => {
    try {
      const { id } = await createScrapeCommand(c.env.DB, {
        stores: c.req.valid('json').stores,
        createdBy: c.get('userId'),
      })
      const res = c.json({ id }, 201)
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    } catch (error) {
      if (error instanceof ScrapeConflictError) return c.json({ error: error.message }, 409)
      throw error
    }
  }
)

apiApp.get(
  '/api/admin/scrape/commands',
  describeRoute({
    description: 'Recent scrape commands, newest first (admin-only).',
    security: [{ cookieAuth: [] }],
    parameters: [
      {
        in: 'query',
        name: 'limit',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 50 },
      },
    ],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                commands: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      stores: { type: 'array', items: { type: 'string' } },
                      status: { type: 'string' },
                      createdBy: { type: 'string' },
                      createdAt: { type: 'string' },
                      pickedUpAt: { type: 'string', nullable: true } as any,
                      finishedAt: { type: 'string', nullable: true } as any,
                      exitCode: { type: 'integer', nullable: true } as any,
                      error: { type: 'string', nullable: true } as any,
                      logTruncated: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
    },
  }),
  requireAdmin,
  sValidator('query', scrapeCommandsQuery),
  async (c) => {
    const commands = await listScrapeCommands(c.env.DB, c.req.valid('query').limit ?? 20)
    const res = c.json({ commands })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.get(
  '/api/admin/scrape/commands/:id/events',
  describeRoute({
    description:
      'Incremental log events for a scrape command (admin-only). Omit afterSeq for the full log; poll with afterSeq=<last seen seq> while the run is pending/running.',
    security: [{ cookieAuth: [] }],
    parameters: [
      {
        in: 'query',
        name: 'afterSeq',
        required: false,
        schema: { type: 'string', pattern: '^[0-9]+$' },
      },
    ],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                events: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      seq: { type: 'integer' },
                      ts: { type: 'string' },
                      level: { type: 'string' },
                      message: { type: 'string' },
                    },
                  },
                },
                truncated: { type: 'boolean' },
              },
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
      404: { description: 'Unknown command' },
    },
  }),
  requireAdmin,
  sValidator('query', scrapeEventsQuery),
  async (c) => {
    const commandId = c.req.param('id')
    // Absent afterSeq = the full log (seq > -1); an explicit afterSeq=0
    // means "after seq 0" — seq-strict, so a poll can never re-receive.
    const afterSeq = c.req.valid('query').afterSeq ? Number(c.req.valid('query').afterSeq) : -1
    try {
      const feed = await listScrapeEvents(c.env.DB, commandId, afterSeq)
      const res = c.json(feed)
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    } catch (error) {
      if (error instanceof ScrapeNotFoundError) return c.json({ error: error.message }, 404)
      throw error
    }
  }
)

// Match review queue (issue #294, docs/294-design.md §4): the admin triage
// surface for pairs the matcher flagged. Decisions are recorded and
// displayed only — they never rewrite catalog or price data (v1 cut). Every
// route: requireAdmin after the shared propsAuthMiddleware use() lines above;
// statics (/export, /mode, /evaluate) registered before the :id/decision
// params. Issue #484 adds the AI mode/evaluate pair and the per-item cached
// verdict + decided_source fields.
const REVIEW_ITEM_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    itemProductKey: { type: 'string' },
    itemName: { type: 'string' },
    itemBrand: { type: ['string', 'null'] },
    itemUnit: { type: ['string', 'null'] },
    itemPrice: { type: 'integer' },
    itemEffectiveUnitPrice: { type: ['number', 'null'] },
    itemStore: { type: 'string' },
    // Issue #380: the LEFT side's evidence, frozen in the pair blob (null
    // for pairs flagged before the fields existed — no backfill).
    itemBrochureUrl: { type: ['string', 'null'] },
    itemSourceUrl: { type: ['string', 'null'] },
    entryProductKey: { type: 'string' },
    entryName: { type: 'string' },
    entryBrand: { type: ['string', 'null'] },
    entryUnit: { type: ['string', 'null'] },
    entryPrice: { type: 'integer' },
    entryEffectiveUnitPrice: { type: ['number', 'null'] },
    entryStore: { type: 'string' },
    // Issue #380: the RIGHT side's evidence, enriched from the entry's
    // latest observation at read time (pending AND decided rows).
    entryBrochureUrl: { type: ['string', 'null'] },
    entrySourceUrl: { type: ['string', 'null'] },
    entryObservedAt: { type: ['string', 'null'] },
    matchMethod: { type: 'string', enum: ['exact', 'embedding', 'ai'] },
    confidence: { type: 'number' },
    reason: { type: 'string', enum: [...REVIEW_REASONS] },
    status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
    decidedAt: { type: ['string', 'null'] },
    decidedBy: { type: ['string', 'null'] },
    // Issue #484: who produced the current decision ('human' | 'ai_assist' |
    // 'ai_auto'), null while pending, and the cached AI verdict the assist UI
    // renders (null = the item has not been evaluated yet).
    decidedSource: {
      type: ['string', 'null'],
      enum: ['human', 'ai_assist', 'ai_auto', null],
    },
    aiVerdict: {
      type: ['object', 'null'],
      properties: {
        verdict: { type: 'string', enum: ['same', 'different'] },
        confidence: { type: 'number' },
        reason: { type: ['string', 'null'] },
        model: { type: ['string', 'null'] },
        humanAgreement: {
          type: ['string', 'null'],
          enum: ['agreed', 'disagreed', null],
        },
      },
    },
    flagCount: { type: 'integer' },
    firstFlaggedAt: { type: 'string' },
    lastFlaggedAt: { type: 'string' },
    runStartedAt: { type: 'string' },
    runId: { type: ['string', 'null'] },
  },
}

apiApp.get(
  '/api/admin/review',
  describeRoute({
    description:
      'Match review queue: flagged candidate pairs with exact per-status counts (admin-only). Offset-paginated, newest flags first.',
    security: [{ cookieAuth: [] }],
    parameters: [
      {
        in: 'query',
        name: 'status',
        required: false,
        schema: {
          type: 'string',
          enum: ['pending', 'approved', 'rejected', 'all'],
          default: 'pending',
        },
      },
      {
        in: 'query',
        name: 'limit',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 200 },
      },
      { in: 'query', name: 'offset', required: false, schema: { type: 'integer', minimum: 0 } },
    ],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                items: { type: 'array', items: REVIEW_ITEM_SCHEMA },
                counts: {
                  type: 'object',
                  properties: {
                    pending: { type: 'integer' },
                    approved: { type: 'integer' },
                    rejected: { type: 'integer' },
                  },
                },
                filteredTotal: { type: 'integer' },
              },
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
    },
  }),
  requireAdmin,
  sValidator('query', reviewQuery),
  async (c) => {
    const { status, limit, offset } = c.req.valid('query')
    const page = await listReviewItems(c.env.DB, {
      status,
      limit,
      offset,
    })
    const res = c.json(page)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

// AI review (issue #484, backend PR 1): the global mode switch and the
// on-demand evaluator. Both are admin-only, and neither ever runs AI on the
// list path — the list JOINs cached verdicts only. Manual mode is a hard
// ZERO-call gate; an unconfigured provider degrades to 200 with
// aiConfigured:false (not an error), because "assist/auto without a key" is
// the documented degrade-to-manual posture.
//
// Issue #493: the mode payload also carries the auto-apply floor. The UI's
// "at least N% confident" copy is then rendered from the number the sweep
// actually compares against, so the two cannot drift. One schema describes
// the payload for BOTH routes — the body and its documented shape travel
// together instead of being pasted twice.
const REVIEW_MODE_RESPONSE_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: [...REVIEW_MODES] },
    aiConfigured: { type: 'boolean' },
    autoMinConfidence: { type: 'number' },
  },
}

function reviewModePayload(mode: ReviewMode, aiConfigured: boolean) {
  return { mode, aiConfigured, autoMinConfidence: REVIEW_AUTO_MIN_CONFIDENCE }
}

apiApp.get(
  '/api/admin/review/mode',
  describeRoute({
    description:
      'AI review mode, whether the acting admin has a usable AI provider, and the auto-apply confidence floor (admin-only). Modes: manual (no AI calls), assist (AI proposes, human decides — default), auto (AI decides at/above autoMinConfidence).',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: REVIEW_MODE_RESPONSE_SCHEMA,
          },
        },
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
    },
  }),
  requireAdmin,
  async (c) => {
    const mode = await getReviewMode(c.env.DB)
    const aiConfigured = (await resolveReviewAiAccess(c.env, c.get('userId'))) !== null
    const res = c.json(reviewModePayload(mode, aiConfigured))
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.put(
  '/api/admin/review/mode',
  describeRoute({
    description:
      'Set the AI review mode (admin-only). Enabling auto records the acting admin as the AI-access owner for the cron and kicks a bounded background sweep (≤10 items). Returns the stored mode, the AI access state, and the auto-apply confidence floor.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['mode'],
            properties: { mode: { type: 'string', enum: [...REVIEW_MODES] } },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: REVIEW_MODE_RESPONSE_SCHEMA,
          },
        },
      },
      400: { description: 'Validation error' },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
    },
  }),
  requireAdmin,
  sValidator('json', reviewModeSchema),
  async (c) => {
    const { mode } = c.req.valid('json')
    const userId = c.get('userId')
    await setReviewMode(c.env.DB, mode, userId)
    const aiConfigured = (await resolveReviewAiAccess(c.env, userId)) !== null
    if (mode === 'auto') {
      // The switch's sweep rides waitUntil so the response stays immediate;
      // runReviewAiSweep re-checks the mode and is bounded to ≤10 items.
      // A runtime without an ExecutionContext (unit tests, local tooling)
      // still runs it — the sweep's own catch keeps it from floating as an
      // unhandled rejection.
      const sweep = runReviewAiSweep(c.env, {
        actingUserId: userId,
        limit: REVIEW_SWITCH_SWEEP_LIMIT,
      }).catch((err: unknown) => {
        console.error('[review-ai] auto-enable sweep failed', err)
      })
      try {
        c.executionCtx.waitUntil(sweep)
      } catch {
        // No ExecutionContext outside the Worker runtime — already running.
      }
    }
    const res = c.json(reviewModePayload(mode, aiConfigured))
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.post(
  '/api/admin/review/evaluate',
  describeRoute({
    description:
      'Evaluate up to 10 pending review items without a verdict using the acting admin’s AI access (admin-only, synchronous). Never runs in manual mode; returns 200 with evaluated:0 and aiConfigured:false when no provider is configured. Verdicts are cached forever; auto mode also applies verdicts at/above the confidence floor.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { limit: { type: 'integer', minimum: 1, maximum: REVIEW_EVALUATE_MAX } },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                evaluated: { type: 'integer' },
                applied: { type: 'integer' },
                mode: { type: 'string', enum: [...REVIEW_MODES] },
                aiConfigured: { type: 'boolean' },
              },
            },
          },
        },
      },
      400: { description: 'Validation error' },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
    },
  }),
  requireAdmin,
  sValidator('json', reviewEvaluateSchema),
  async (c) => {
    const userId = c.get('userId')
    const limit = c.req.valid('json').limit ?? REVIEW_EVALUATE_MAX
    const mode = await getReviewMode(c.env.DB)
    // ONE decision-capability read for this request (#523 P4): the handle is
    // reused for every item the probe evaluates.
    const resolved = await resolveReviewAiAccess(c.env, userId)
    const aiConfigured = resolved !== null
    if (mode === 'manual' || !resolved) {
      const res = c.json({ evaluated: 0, applied: 0, mode, aiConfigured })
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    }
    // Auto also applies verdicts the probe already cached (no re-billing):
    // switching assist → auto must act on them, not leave them stranded.
    const alreadyApplied = mode === 'auto' ? await applyCachedAutoVerdicts(c.env.DB, limit) : 0
    const outcome = await evaluatePendingReviews(c.env, {
      mode,
      access: resolved.access,
      userId,
      householdId: resolved.householdId,
      limit,
    })
    const res = c.json({
      evaluated: outcome.evaluated,
      applied: outcome.applied + alreadyApplied,
      mode,
      aiConfigured,
    })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.get(
  '/api/admin/review/export',
  describeRoute({
    description:
      'Stream every decided review item as versioned JSON (admin-only) — ALL decided rows, independent of list pagination.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description:
          'JSON stream: {"schema":1,"exportedAt":"…","decisions":[…]} (Content-Disposition: attachment)',
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
    },
  }),
  requireAdmin,
  (c) => {
    const res = new Response(exportReviewDecisions(c.env.DB), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="review_decisions.json"',
        'Cache-Control': 'private, no-cache',
      },
    })
    return res
  }
)

apiApp.post(
  '/api/admin/review/:id/decision',
  describeRoute({
    description:
      'Record a review verdict (approve/reject) for a flagged pair (admin-only). Last verdict wins. Send agreement when the caller is accepting or rejecting the cached AI verdict (records ai_assist provenance).',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['decision'],
            properties: {
              decision: { type: 'string', enum: ['approved', 'rejected'] },
              agreement: { type: 'string', enum: ['agreed', 'disagreed'] },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { item: REVIEW_ITEM_SCHEMA } },
          },
        },
      },
      400: { description: 'Validation error' },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
      404: { description: 'Unknown review item' },
    },
  }),
  requireAdmin,
  sValidator('json', reviewDecisionSchema),
  async (c) => {
    const { decision, agreement } = c.req.valid('json')
    const item = await decideReviewItem(
      c.env.DB,
      c.req.param('id'),
      decision,
      c.get('userId'),
      agreement
    )
    if (!item) {
      return c.json({ error: 'Review item not found' }, 404)
    }
    const res = c.json({ item })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.delete(
  '/api/admin/review/:id/decision',
  describeRoute({
    description:
      'Undo a review verdict — the row returns to pending (admin-only). Idempotent on a pending row.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { item: REVIEW_ITEM_SCHEMA } },
          },
        },
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
      404: { description: 'Unknown review item' },
    },
  }),
  requireAdmin,
  async (c) => {
    const item = await undoReviewDecision(c.env.DB, c.req.param('id'))
    if (!item) {
      return c.json({ error: 'Review item not found' }, 404)
    }
    const res = c.json({ item })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

// ---------------------------------------------------------------------------
// Admin canonical product rename/revert (#423, pipeline contract v2). The
// backend owns price_products.name, so a rename is a label fix: product_key
// and UUID never move, the old wording is approved where a candidate already
// exists, and the canonical index version advances exactly once. The settled
// decisions (status stays provisional, latest rename only, hard duplicate 409,
// acknowledgeable similar warnings) live in lib/canonical-products.ts — these
// handlers stay HTTP-only.
// ---------------------------------------------------------------------------
const PRODUCT_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    productKey: { type: 'string' },
    name: { type: 'string' },
    brand: { type: ['string', 'null'] },
    unit: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['canonical', 'provisional', 'needs_review'] },
    metadataVersion: { type: 'integer', minimum: 1 },
    firstSeenAt: { type: ['string', 'null'] },
    lastSeenAt: { type: ['string', 'null'] },
    updatedAt: { type: ['string', 'null'] },
  },
}

const PRODUCT_ALIAS_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  properties: {
    // The alias id is the handle the approve/reject routes take (#489); the
    // identity payload must carry it or the UI cannot act on a row.
    id: { type: 'string' },
    name: { type: 'string' },
    storeSlug: { type: 'string' },
    status: { type: 'string', enum: ['candidate', 'approved', 'rejected'] },
    source: { type: 'string', enum: ['ocr', 'catalog', 'admin'] },
    firstSeenAt: { type: 'string' },
    lastSeenAt: { type: 'string' },
  },
}

// 200 body for an alias decision (#489): the decided alias and the canonical
// index version the decision left behind. Reject returns the unchanged
// version — the pipeline cache is not invalidated by a refusal.
const ALIAS_DECISION_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  properties: {
    alias: PRODUCT_ALIAS_SCHEMA,
    indexVersion: { type: 'integer', minimum: 0 },
  },
}

// 409 body when the alias was already decided (the CAS lost).
const ALIAS_STATE_RESPONSE_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    currentStatus: { type: 'string', enum: ['candidate', 'approved', 'rejected'] },
  },
}

const PRODUCT_AUDIT_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    action: { type: 'string', enum: ['rename', 'revert'] },
    oldName: { type: 'string' },
    newName: { type: 'string' },
    reason: { type: ['string', 'null'] },
    actorUserId: { type: 'string' },
    metadataVersionBefore: { type: 'integer' },
    metadataVersionAfter: { type: 'integer' },
    revertsAuditId: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
  },
}

const PRODUCT_IDENTITY_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  properties: {
    product: PRODUCT_SCHEMA,
    aliases: { type: 'array', items: PRODUCT_ALIAS_SCHEMA },
    stats: {
      type: 'object',
      properties: {
        observations: { type: 'integer' },
        stores: { type: 'integer' },
      },
    },
    audit: { type: 'array', items: PRODUCT_AUDIT_SCHEMA },
  },
}

const SIMILAR_NAME_WARNING_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  properties: {
    productKey: { type: 'string' },
    name: { type: 'string' },
    similarity: { type: 'number', minimum: 0, maximum: 1 },
  },
}

const RENAME_CONFLICT_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  properties: {
    productKey: { type: 'string' },
    name: { type: 'string' },
    source: { type: 'string', enum: ['product', 'alias'] },
  },
}

const PRODUCT_MUTATION_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  properties: {
    product: PRODUCT_SCHEMA,
    warnings: { type: 'array', items: SIMILAR_NAME_WARNING_SCHEMA },
    audit: { type: 'array', items: PRODUCT_AUDIT_SCHEMA },
    indexVersion: { type: 'integer', minimum: 0 },
  },
}

// 409 body for rename: exactly one of conflicts/warnings/current is present,
// keyed by `error` ('duplicate_name' | 'similar_name' | 'stale_product').
const RENAME_CONFLICT_RESPONSE_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    conflicts: { type: 'array', items: RENAME_CONFLICT_SCHEMA },
    warnings: { type: 'array', items: SIMILAR_NAME_WARNING_SCHEMA },
    current: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        metadataVersion: { type: 'integer' },
      },
    },
  },
}

const PRODUCT_KEY_PARAMETER = {
  in: 'path',
  name: 'productKey',
  required: true,
  schema: { type: 'string', maxLength: 300 },
} as const

const ALIAS_ID_PARAMETER = {
  in: 'path',
  name: 'aliasId',
  required: true,
  schema: { type: 'string', maxLength: 100 },
} as const

// Read-only duplicate-name report (#485).
const DUPLICATE_PRODUCT_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  properties: {
    productKey: { type: 'string' },
    name: { type: 'string' },
    status: { type: 'string', enum: ['canonical', 'provisional', 'needs_review'] },
    updatedAt: { type: ['string', 'null'] },
    stores: { type: 'array', items: { type: 'string' } },
    primaryStore: { type: ['string', 'null'] },
  },
}

const DUPLICATE_NAME_GROUP_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  properties: {
    normalizedName: { type: 'string' },
    displayName: { type: 'string' },
    productCount: { type: 'integer', minimum: 2 },
    products: { type: 'array', items: DUPLICATE_PRODUCT_SCHEMA },
  },
}

const DUPLICATE_NAME_REPORT_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    truncated: { type: 'boolean' },
    groups: { type: 'array', items: DUPLICATE_NAME_GROUP_SCHEMA },
  },
}

const duplicateProductsQuery = object({
  // Hono delivers query params as strings — accept a digit string and coerce
  // (the OpenAPI annotation below still documents an integer).
  limit: optional(
    pipe(string(), transform(Number), number(), integer(), minValue(1), maxValue(500))
  ),
})

// Read-only duplicate-name report (#485). Registered BEFORE the identity route
// on purpose: Hono matches in registration order, so the static path must win
// over `/api/admin/products/:productKey` (which would otherwise answer with a
// product named 'duplicates'). Auth rides the existing `use` line for that
// param pattern — it matches this static path too — and the handler adds
// requireAdmin. Reads only: no write, and no canonical-index bump, so opening
// the report never invalidates the pipeline's cached index.
apiApp.get(
  '/api/admin/products/duplicates',
  describeRoute({
    description:
      'Read-only duplicate-name report: canonical products sharing a name case-insensitively, grouped by that name (admin-only). Bounded by `limit` groups (1-500, default 200); each group lists at most 25 products and the whole report at most 900, with `truncated` set when a bound bit. Never writes and never bumps the canonical index version.',
    security: [{ cookieAuth: [] }],
    parameters: [
      {
        in: 'query',
        name: 'limit',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
      },
    ],
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: DUPLICATE_NAME_REPORT_SCHEMA } },
      },
      400: { description: 'Invalid limit' },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
    },
  }),
  requireAdmin,
  sValidator('query', duplicateProductsQuery),
  async (c) => {
    const { limit } = c.req.valid('query')
    const report = await getDuplicateNameReport(c.env.DB, { limit })
    const res = c.json(report)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

// ---------------------------------------------------------------------------
// Bulk exact-name alias approval (#515, follow-up to #489). One safe action:
// approve ONLY the candidate aliases whose name equals their own product's
// canonical name case-insensitively; every other candidate stays for manual
// review. Both paths are static and registered before the `:productKey`
// identity route. The writes, chunking, single index bump, and idempotency
// rules live in lib/canonical-products.ts — these handlers stay HTTP-only.
// ---------------------------------------------------------------------------
const ALIAS_CANDIDATE_COUNTS_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  properties: {
    candidates: { type: 'integer', minimum: 0 },
    exactCandidates: { type: 'integer', minimum: 0 },
  },
}

const ALIAS_BULK_APPROVE_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  properties: {
    exactCandidates: { type: 'integer', minimum: 0 },
    approved: { type: 'integer', minimum: 0 },
    remainingCandidates: { type: 'integer', minimum: 0 },
    indexVersion: { type: 'integer', minimum: 0 },
  },
}

// 500 body when a chunk failed mid-run: the aliases already committed stay
// approved, so the count reached is part of the answer, not a hidden detail.
const ALIAS_BULK_APPROVE_FAILURE_SCHEMA: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    approved: { type: 'integer', minimum: 0 },
    indexVersion: { type: ['integer', 'null'], minimum: 0 },
    remainingCandidates: { type: ['integer', 'null'], minimum: 0 },
  },
}

// Read-only counts for the alias-candidates panel (#515). Registered before the
// identity route: Hono matches in registration order, and `/api/admin/products/
// aliases/candidates` must never be read as a product named 'aliases'.
apiApp.get(
  '/api/admin/products/aliases/candidates',
  describeRoute({
    description:
      'Read-only candidate-alias counts: every candidate alias in the catalog and how many exactly match their own product’s canonical name case-insensitively (admin-only). Drives the bulk exact-name approval panel. Never writes and never bumps the canonical index version.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: ALIAS_CANDIDATE_COUNTS_SCHEMA } },
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
    },
  }),
  requireAdmin,
  async (c) => {
    const counts = await countAliasCandidates(c.env.DB)
    const res = c.json(counts)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.post(
  '/api/admin/products/aliases/bulk-approve',
  describeRoute({
    description:
      'Approve every candidate alias whose name equals its own product’s canonical name case-insensitively (admin-only). No request body (an empty JSON object is accepted and ignored). Each approval takes the candidate -> approved CAS plus one audit receipt for the acting admin; the canonical index version advances exactly once per run with at least one approval. One run is bounded by the Worker invocation’s D1 query budget (1,125 exact matches today) and the response’s counts say what is left, so a larger catalogue is drained by running again. Idempotent: a second run approves nothing and does not bump. Variant spellings are never approved — they stay for manual review. A failed chunk answers 500 bulk_approve_failed with the count already committed.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: ALIAS_BULK_APPROVE_SCHEMA } },
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
      500: {
        description:
          'bulk_approve_failed: a chunk failed after `approved` aliases were committed; the index was bumped for those and a rerun continues',
        content: { 'application/json': { schema: ALIAS_BULK_APPROVE_FAILURE_SCHEMA } },
      },
    },
  }),
  requireAdmin,
  async (c) => {
    try {
      const result = await bulkApproveExactNameAliases(c.env.DB, c.get('userId'))
      const res = c.json(result)
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    } catch (error) {
      if (error instanceof BulkAliasApproveError) {
        // The catch converts the failure into an honest 500, which means the
        // shared onError handler never sees it: log the cause here or a failed
        // catalog-wide run leaves no server-side trace of why the chunk died.
        console.error('[products] bulk alias approval failed', error.failure)
        return c.json(
          {
            error: 'bulk_approve_failed',
            approved: error.approved,
            indexVersion: error.indexVersion,
            remainingCandidates: error.remainingCandidates,
          },
          500
        )
      }
      throw error
    }
  }
)

apiApp.get(
  '/api/admin/products/:productKey',
  describeRoute({
    description:
      'Canonical product identity: the product row, every alias with its id (candidate, approved, and rejected), observation stats, and the last 10 audit rows newest first (admin-only).',
    security: [{ cookieAuth: [] }],
    parameters: [PRODUCT_KEY_PARAMETER],
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: PRODUCT_IDENTITY_SCHEMA } },
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
      404: { description: 'Unknown product' },
    },
  }),
  requireAdmin,
  async (c) => {
    const identity = await getProductIdentity(c.env.DB, c.req.param('productKey'))
    if (!identity) return c.json({ error: 'Product not found' }, 404)
    const res = c.json(identity)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.post(
  '/api/admin/products/:productKey/rename',
  describeRoute({
    description:
      'Rename the canonical product (admin-only). 409 duplicate_name when another product or approved alias already carries the name; 409 similar_name (overridable with acknowledgeWarnings) for near-duplicates; 409 stale_product when expectedMetadataVersion no longer matches. status stays provisional and the canonical index version advances once.',
    security: [{ cookieAuth: [] }],
    parameters: [PRODUCT_KEY_PARAMETER],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['canonicalName', 'expectedMetadataVersion'],
            properties: {
              canonicalName: { type: 'string', minLength: 1, maxLength: 500 },
              expectedMetadataVersion: { type: 'integer', minimum: 0 },
              reason: { type: 'string', maxLength: 200 },
              acknowledgeWarnings: { type: 'boolean' },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: PRODUCT_MUTATION_SCHEMA } },
      },
      400: {
        description:
          'Validation error: invalid body, or a blank/oversize/control-character name or reason',
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
      404: { description: 'Unknown product' },
      409: {
        description:
          'duplicate_name (conflicts[]), similar_name (warnings[]), or stale_product (current{name, metadataVersion})',
        content: { 'application/json': { schema: RENAME_CONFLICT_RESPONSE_SCHEMA } },
      },
    },
  }),
  requireAdmin,
  sValidator('json', productRenameSchema),
  async (c) => {
    const body = c.req.valid('json')
    try {
      const result = await renameProduct(c.env.DB, {
        productKey: c.req.param('productKey'),
        canonicalName: body.canonicalName,
        expectedMetadataVersion: body.expectedMetadataVersion,
        actorUserId: c.get('userId'),
        reason: body.reason ?? null,
        acknowledgeWarnings: body.acknowledgeWarnings ?? false,
      })
      const res = c.json(result)
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    } catch (error) {
      if (error instanceof ProductNotFoundError) {
        return c.json({ error: 'Product not found' }, 404)
      }
      if (error instanceof DuplicateNameError) {
        return c.json({ error: 'duplicate_name', conflicts: error.conflicts }, 409)
      }
      if (error instanceof SimilarNameError) {
        return c.json({ error: 'similar_name', warnings: error.warnings }, 409)
      }
      if (error instanceof StaleProductError) {
        return c.json({ error: 'stale_product', current: error.current }, 409)
      }
      if (error instanceof InvalidNameError || error instanceof InvalidReasonError) {
        return c.json({ error: error.message }, 400)
      }
      throw error
    }
  }
)

apiApp.post(
  '/api/admin/products/:productKey/audit/:auditId/revert',
  describeRoute({
    description:
      'Append a compensating revert for the LATEST rename of this product (admin-only): restores the previous canonical name, writes a revert audit row (old/new swapped, revertsAuditId set), and bumps the canonical index version once. An older rename or a second compensation is 409 stale_revert.',
    security: [{ cookieAuth: [] }],
    parameters: [
      PRODUCT_KEY_PARAMETER,
      {
        in: 'path',
        name: 'auditId',
        required: true,
        schema: { type: 'string', maxLength: 100 },
      },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { reason: { type: 'string', maxLength: 200 } },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: PRODUCT_MUTATION_SCHEMA } },
      },
      400: { description: 'Validation error (invalid body or reason)' },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
      404: { description: 'Unknown product or audit entry' },
      409: {
        description:
          'stale_revert: the audit row is not the latest rename, or it was already compensated',
        content: { 'application/json': { schema: { type: 'object' } } },
      },
    },
  }),
  requireAdmin,
  sValidator('json', productRevertSchema),
  async (c) => {
    try {
      const result = await revertProductRename(c.env.DB, {
        productKey: c.req.param('productKey'),
        auditId: c.req.param('auditId'),
        actorUserId: c.get('userId'),
        reason: c.req.valid('json').reason ?? null,
      })
      const res = c.json(result)
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    } catch (error) {
      if (error instanceof ProductNotFoundError) {
        return c.json({ error: 'Product not found' }, 404)
      }
      if (error instanceof AuditNotFoundError) {
        return c.json({ error: 'Audit entry not found' }, 404)
      }
      if (error instanceof StaleRevertError) {
        return c.json({ error: 'stale_revert' }, 409)
      }
      if (error instanceof InvalidReasonError) {
        return c.json({ error: error.message }, 400)
      }
      throw error
    }
  }
)

// ---------------------------------------------------------------------------
// Candidate alias decisions (ahaqqu/RumaQ#489). No request body on either
// route: the alias id is the path, the decision is the verb, and the receipt
// has no reason field — a body would only carry unvalidated data with nowhere
// to go. The lib owns the CAS/receipt/bump rules (lib/canonical-products.ts);
// these handlers only map typed errors to status + stable codes. Approve bumps
// the canonical index version once; reject bumps nothing (a candidate was
// never in the published index). Neither touches product metadata_version.
// ---------------------------------------------------------------------------
const ALIAS_DECISION_PARAMETERS = [PRODUCT_KEY_PARAMETER, ALIAS_ID_PARAMETER]

/**
 * The typed-error → status/code mapping both alias decisions answer with. The
 * lib deliberately shares one `decideAlias`, so the HTTP contract of the two
 * routes is one thing and lives in one place: a change to the 409
 * `{ error: 'alias_state', currentStatus }` body (the shape PR 2 switches on)
 * must not be made twice.
 */
function aliasDecisionError(c: Context<Env>, error: unknown): Response {
  if (error instanceof ProductNotFoundError) {
    return c.json({ error: 'Product not found' }, 404)
  }
  if (error instanceof AliasNotFoundError) {
    return c.json({ error: 'Alias not found' }, 404)
  }
  if (error instanceof AliasStateError) {
    return c.json({ error: 'alias_state', currentStatus: error.currentStatus }, 409)
  }
  throw error
}

apiApp.post(
  '/api/admin/products/:productKey/aliases/:aliasId/approve',
  describeRoute({
    description:
      'Approve a candidate alias (admin-only): the store spelling enters the canonical index and the index version advances exactly once, so the pipeline sees it on its next fetch. No request body. 409 alias_state when the alias was already approved or rejected.',
    security: [{ cookieAuth: [] }],
    parameters: ALIAS_DECISION_PARAMETERS,
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: ALIAS_DECISION_SCHEMA } },
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
      404: { description: 'Unknown product, or the alias does not belong to this product' },
      409: {
        description: 'alias_state: the alias was already approved or rejected',
        content: { 'application/json': { schema: ALIAS_STATE_RESPONSE_SCHEMA } },
      },
    },
  }),
  requireAdmin,
  async (c) => {
    try {
      const result = await approveAlias(c.env.DB, {
        productKey: c.req.param('productKey'),
        aliasId: c.req.param('aliasId'),
        actorUserId: c.get('userId'),
      })
      const res = c.json(result)
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    } catch (error) {
      return aliasDecisionError(c, error)
    }
  }
)

apiApp.post(
  '/api/admin/products/:productKey/aliases/:aliasId/reject',
  describeRoute({
    description:
      'Reject a candidate alias (admin-only): the decision is recorded and the spelling stays out of the canonical index. No request body. No index bump — the rejected spelling was never published, so the pipeline cache is not invalidated. 409 alias_state when the alias was already approved or rejected.',
    security: [{ cookieAuth: [] }],
    parameters: ALIAS_DECISION_PARAMETERS,
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: ALIAS_DECISION_SCHEMA } },
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Not an admin' },
      404: { description: 'Unknown product, or the alias does not belong to this product' },
      409: {
        description: 'alias_state: the alias was already approved or rejected',
        content: { 'application/json': { schema: ALIAS_STATE_RESPONSE_SCHEMA } },
      },
    },
  }),
  requireAdmin,
  async (c) => {
    try {
      const result = await rejectAlias(c.env.DB, {
        productKey: c.req.param('productKey'),
        aliasId: c.req.param('aliasId'),
        actorUserId: c.get('userId'),
      })
      const res = c.json(result)
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    } catch (error) {
      return aliasDecisionError(c, error)
    }
  }
)

apiApp.get(
  '/api/prices',
  describeRoute({
    description: 'Search observed store prices (latest observation per product per store).',
    security: [{ cookieAuth: [] }],
    parameters: [
      { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
      { in: 'query', name: 'source', required: false, schema: { type: 'string' } },
      {
        in: 'query',
        name: 'category',
        required: false,
        description: 'Exact category-slug filter (issue #373); values from /api/prices/meta.',
        schema: { type: 'string', maxLength: 100 },
      },
      {
        in: 'query',
        name: 'sort',
        required: false,
        schema: {
          type: 'string',
          enum: ['name', 'cheapest', 'savings', 'expiry'],
          default: 'name',
        },
      },
    ],
    responses: {
      200: { description: 'OK' },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden' },
    },
  }),
  sValidator('query', pricesQuery),
  async (c) => {
    const { q, source, category, sort } = c.req.valid('query')

    const filters = buildPriceFilters(q, source, category)

    // No sort param → the legacy flat name-ordered query and its exact
    // response: usePriceSources builds the source-chip bar from this path and
    // must never see a different shape or order.
    if (!sort) {
      let sql = `SELECT p.product_key, p.name, p.brand, p.unit, p.category,
                      s.slug AS source_slug, s.name AS source_name,
                      o.observed_date, o.price, o.effective_unit_price,
                      o.unit_qty, o.unit_qty_unit, o.unit_price,
                      o.promo_type, o.promo_label, o.valid_from, o.valid_until,
                      o.match_method, o.match_confidence, o.brochure_url
               FROM price_observations o
               JOIN price_products p ON p.id = o.product_id
               JOIN price_sources s ON s.id = o.source_id
               WHERE ${LATEST_OBSERVATION_PREDICATE}${filters.sql}
               ORDER BY p.name COLLATE NOCASE, s.name COLLATE NOCASE
               LIMIT ${PRICE_LIST_LIMIT}`

      const { results } = await c.env.DB.prepare(sql)
        .bind(...filters.params)
        .all<PriceListRow>()

      const items = (results ?? []).map((row) => ({
        ...row,
        low_confidence: row.match_confidence < PRICE_LOW_CONFIDENCE_FLAG,
      }))

      const res = c.json({ items, total: items.length })
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    }

    // Sorted path: aggregate first, page on products second. The sort keys for
    // cheapest/savings/expiry are product-level aggregates, so LIMIT must
    // apply after aggregation or whole products get dropped or split across
    // the page boundary (issue #291 design §1.1). Every returned product is
    // complete; `truncated` reports whether a 201st product existed.
    const order = PRICE_SORTS[sort]
    const sql = `WITH latest AS (
  SELECT p.product_key, p.name, p.brand, p.unit, p.category,
         s.slug AS source_slug, s.name AS source_name,
         o.observed_date, o.price, o.effective_unit_price,
         o.unit_qty, o.unit_qty_unit, o.unit_price,
         o.promo_type, o.promo_label, o.valid_from, o.valid_until,
         o.match_method, o.match_confidence, o.brochure_url,
         COALESCE(o.effective_unit_price, o.price) AS effective_price
  FROM price_observations o
  JOIN price_products p ON p.id = o.product_id
  JOIN price_sources s ON s.id = o.source_id
  WHERE ${LATEST_OBSERVATION_PREDICATE}${filters.sql}
),
cheapest AS (
  SELECT product_key,
         source_slug AS cheapest_source_slug,
         valid_until AS cheapest_valid_until,
         ROW_NUMBER() OVER (
           PARTITION BY product_key
           ORDER BY effective_price ASC, source_slug ASC
         ) AS rn
  FROM latest
),
agg AS (
  SELECT product_key,
         MIN(effective_price) AS price_min,
         MAX(effective_price) AS price_max,
         CASE WHEN MAX(effective_price) > 0
              THEN ROUND((MAX(effective_price) - MIN(effective_price)) * 100.0 / MAX(effective_price), 1)
              ELSE 0 END AS savings_pct
  FROM latest
  GROUP BY product_key
),
page AS (
  SELECT a.product_key
  FROM agg a
  JOIN cheapest ch ON ch.product_key = a.product_key AND ch.rn = 1
  JOIN price_products pp ON pp.product_key = a.product_key
  ORDER BY ${order.page}, pp.name COLLATE NOCASE, a.product_key
  LIMIT ${PRICE_PAGE_LIMIT}
)
SELECT l.product_key, l.name, l.brand, l.unit, l.category,
       l.source_slug, l.source_name,
       l.observed_date, l.price, l.effective_unit_price,
       l.unit_qty, l.unit_qty_unit, l.unit_price,
       l.promo_type, l.promo_label, l.valid_from, l.valid_until,
       l.match_method, l.match_confidence, l.brochure_url,
       a.price_min, a.price_max, a.savings_pct,
       ch.cheapest_source_slug, ch.cheapest_valid_until
FROM latest l
JOIN agg a ON a.product_key = l.product_key
JOIN cheapest ch ON ch.product_key = l.product_key AND ch.rn = 1
JOIN page pg ON pg.product_key = l.product_key
ORDER BY ${order.outer}, l.name COLLATE NOCASE, l.source_name COLLATE NOCASE, l.product_key`

    const { results } = await c.env.DB.prepare(sql)
      .bind(...filters.params)
      .all<PriceListRow & PriceAggregateFields>()

    const items = (results ?? []).map((row) => ({
      ...row,
      low_confidence: row.match_confidence < PRICE_LOW_CONFIDENCE_FLAG,
    }))

    const productCount = new Set(items.map((item) => item.product_key)).size
    const res = c.json({ items, total: items.length, truncated: productCount > PRICE_LIST_LIMIT })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

// Freshness for the price explorer page (issue #291): session-authed sibling
// of the internal status probe, reusing getPricesStatus verbatim. Registered
// before /api/prices/:productKey so "meta" is never captured as a product
// key; auth comes from the existing /api/prices/:productKey middleware line.
apiApp.get(
  '/api/prices/meta',
  describeRoute({
    description:
      'Price data freshness: latest scrape time, latest observed date, observation count, and the category slugs available for the explorer filter (issue #373).',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                latestScrapedAt: { type: 'string', nullable: true } as any,
                latestObservedDate: { type: 'string', nullable: true } as any,
                observationCount: { type: 'integer' },
                categories: { type: 'array', items: { type: 'string' } },
              },
              required: ['latestScrapedAt', 'latestObservedDate', 'observationCount', 'categories'],
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden' },
    },
  }),
  async (c) => {
    // Issue #373: the category filter's value domain rides meta so the
    // explorer needs no second round trip; empty until the classifier (or
    // the backfill) fills price_products.category.
    const [status, categories] = await Promise.all([
      getPricesStatus(c.env.DB),
      listPriceCategories(c.env.DB),
    ])
    const res = c.json({ ...status, categories })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

// Promo catalog for the /prices Promos view (issue #292): current
// observations grouped by promo type with per-source product counts and ≤5
// example products per group. Grouping lives in getPromoCatalog (lib/prices),
// which interpolates the same LATEST_OBSERVATION_PREDICATE as the explorer —
// the two views' counts cannot drift apart.
apiApp.get(
  '/api/prices/promos',
  describeRoute({
    description:
      'Promo catalog: current observations grouped by promo type, with per-store product counts and up to five example products per type.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                types: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      promo_type: {
                        type: 'string',
                        enum: [
                          'discount_pct',
                          'discount_fixed',
                          'get_free',
                          'bundle_buy',
                          'multi_price',
                          'other',
                        ],
                      },
                      product_count: { type: 'integer' },
                      stores: { type: 'object', additionalProperties: { type: 'integer' } },
                      example_products: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            product_key: { type: 'string' },
                            name: { type: 'string' },
                            brand: { type: 'string', nullable: true } as any,
                            unit: { type: 'string', nullable: true } as any,
                            source_slug: { type: 'string' },
                            source_name: { type: 'string' },
                            price: { type: 'number' },
                            effective_unit_price: { type: ['number', 'null'] } as any,
                          },
                          required: [
                            'product_key',
                            'name',
                            'brand',
                            'unit',
                            'source_slug',
                            'source_name',
                            'price',
                            'effective_unit_price',
                          ],
                        },
                      },
                    },
                    required: ['promo_type', 'product_count', 'stores', 'example_products'],
                  },
                },
                total: { type: 'integer' },
              },
              required: ['types', 'total'],
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden' },
    },
  }),
  async (c) => {
    const catalog = await getPromoCatalog(c.env.DB)
    const res = c.json(catalog)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

// Brochure catalog for the /prices Brochures view (issue #293): current
// observations with a servable brochure URL grouped by (source, brochure
// image), newest first, ≤5 example products per group. Grouping lives in
// getBrochureCatalog (lib/brochures), which interpolates the same
// LATEST_OBSERVATION_PREDICATE as the explorer and the promo catalog — the
// views' counts cannot drift. Registered BEFORE /api/prices/:productKey so
// "brochures" is never captured as a product key (the #292-pinned landmine).
apiApp.get(
  '/api/prices/brochures',
  describeRoute({
    description:
      'Brochure catalog: current observations grouped by brochure image per store, with up to five example products per group.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                groups: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      source_slug: { type: 'string' },
                      source_name: { type: 'string' },
                      brochure_url: { type: 'string' },
                      observed_date: { type: 'string' },
                      product_count: { type: 'integer' },
                      example_products: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            product_key: { type: 'string' },
                            name: { type: 'string' },
                            brand: { type: 'string', nullable: true } as any,
                            unit: { type: 'string', nullable: true } as any,
                            price: { type: 'number' },
                            effective_unit_price: { type: ['number', 'null'] } as any,
                          },
                          required: [
                            'product_key',
                            'name',
                            'brand',
                            'unit',
                            'price',
                            'effective_unit_price',
                          ],
                        },
                      },
                    },
                    required: [
                      'source_slug',
                      'source_name',
                      'brochure_url',
                      'observed_date',
                      'product_count',
                      'example_products',
                    ],
                  },
                },
              },
              required: ['groups'],
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden' },
    },
  }),
  async (c) => {
    const catalog = await getBrochureCatalog(c.env.DB)
    const res = c.json(catalog)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.get(
  '/api/prices/:productKey',
  // Route-level (not a use-line) so the static leaves above are never
  // captured as product keys and double-gated with prices.history.
  requirePricesEntitlement('prices.history'),
  describeRoute({
    description: 'Price detail for one product: per-store current prices and full history.',
    security: [{ cookieAuth: [] }],
    parameters: [{ in: 'path', name: 'productKey', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'OK' },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden' },
      404: { description: 'Product not found' },
    },
  }),
  async (c) => {
    const productKey = c.req.param('productKey')

    const product = await c.env.DB.prepare(
      `SELECT product_key, name, brand, unit, category, first_seen_at, last_seen_at
       FROM price_products WHERE product_key = ?`
    )
      .bind(productKey)
      .first<{
        product_key: string
        name: string
        brand: string | null
        unit: string | null
        category: string | null
        first_seen_at: string | null
        last_seen_at: string | null
      }>()

    if (!product) {
      return c.json({ error: 'Product not found' }, 404)
    }

    const { results: current } = await c.env.DB.prepare(
      `SELECT s.slug AS source_slug, s.name AS source_name,
              o.observed_date, o.price, o.effective_unit_price,
              o.promo_type, o.promo_label, o.valid_from, o.valid_until,
              o.match_method, o.match_confidence, o.brochure_url
       FROM price_observations o
       JOIN price_sources s ON s.id = o.source_id
       WHERE o.product_id = (SELECT id FROM price_products WHERE product_key = ?)
         AND ${LATEST_OBSERVATION_SUBQUERY}
       ORDER BY COALESCE(o.effective_unit_price, o.price) ASC, s.slug ASC`
    )
      .bind(productKey)
      .all<{
        source_slug: string
        source_name: string
        observed_date: string
        price: number
        effective_unit_price: number | null
        promo_type: string | null
        promo_label: string | null
        valid_from: string | null
        valid_until: string | null
        match_method: string | null
        match_confidence: number
        brochure_url: string | null
      }>()

    const { results: history } = await c.env.DB.prepare(
      `SELECT s.slug AS source_slug, o.observed_date, o.price, o.promo_type,
              o.promo_label, o.valid_from, o.valid_until, o.match_method, o.match_confidence
       FROM price_observations o
       JOIN price_sources s ON s.id = o.source_id
       WHERE o.product_id = (SELECT id FROM price_products WHERE product_key = ?)
       ORDER BY o.observed_date ASC, o.scraped_at ASC`
    )
      .bind(productKey)
      .all<{
        source_slug: string
        observed_date: string
        price: number
        promo_type: string | null
        promo_label: string | null
        valid_from: string | null
        valid_until: string | null
        match_method: string | null
        match_confidence: number
      }>()

    const res = c.json({
      product,
      current: (current ?? []).map((row) => ({
        ...row,
        low_confidence: row.match_confidence < PRICE_LOW_CONFIDENCE_FLAG,
      })),
      history: history ?? [],
    })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.get(
  '/api/plans',
  describeRoute({
    description: 'List plans for the active household.',
    security: [{ cookieAuth: [] }],
    parameters: [
      {
        in: 'query',
        name: 'status',
        required: false,
        schema: {
          type: 'string',
          enum: ['active', 'archived', 'completed', 'all'],
          default: 'active',
        },
      },
    ],
    responses: {
      200: { description: 'OK' },
      401: { description: 'Unauthorized' },
    },
  }),
  sValidator('query', plansQuery),
  async (c) => {
    const householdId = c.get('householdId')
    if (!householdId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    const status = c.req.valid('query').status || 'active'

    let planSql = `SELECT id, household_id, status, total_estimate, created_at, updated_at
       FROM plans WHERE household_id = ?`
    const planParams: unknown[] = [householdId]

    if (status !== 'all') {
      planSql += ' AND status = ?'
      planParams.push(status)
    }
    planSql += ' ORDER BY created_at DESC'

    const { results: plans } = await c.env.DB.prepare(planSql)
      .bind(...planParams)
      .all<{
        id: string
        household_id: string
        status: string
        total_estimate: number | null
        created_at: string
        updated_at: string
      }>()

    if (plans.length === 0) {
      const res = c.json({ plans: [] })
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    }

    const planIds = plans.map((p) => p.id)
    const placeholders = planIds.map(() => '?').join(',')

    const { results: items } = await c.env.DB.prepare(
      `SELECT pi.id, pi.plan_id, pi.item_id, pi.store_id, i.name AS item_name,
              s.label AS store_label, pi.qty, pi.unit, pi.price_estimate, pi.why, pi.status, pi.created_at,
              ps.name AS price_source_name, po.valid_until AS price_valid_until
       FROM plan_items pi
       LEFT JOIN items i ON i.id = pi.item_id
       LEFT JOIN stores s ON s.id = pi.store_id
       LEFT JOIN price_observations po ON po.id = pi.price_observation_id
       LEFT JOIN price_sources ps ON ps.id = po.source_id
       WHERE pi.plan_id IN (${placeholders})
       ORDER BY pi.created_at`
    )
      .bind(...planIds)
      .all<{
        id: string
        plan_id: string
        item_id: string | null
        store_id: string | null
        item_name: string | null
        store_label: string | null
        qty: number
        unit: string | null
        price_estimate: number | null
        why: string | null
        status: string
        created_at: string
        price_source_name: string | null
        price_valid_until: string | null
      }>()

    const itemsByPlan: Record<string, typeof items> = {}
    for (const item of items) {
      if (!itemsByPlan[item.plan_id]) itemsByPlan[item.plan_id] = []
      itemsByPlan[item.plan_id].push(item)
    }

    const result = plans.map((plan) => ({
      ...plan,
      items: itemsByPlan[plan.id] || [],
    }))

    const res = c.json({ plans: result })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.post(
  '/api/plans/generate',
  describeRoute({
    description: 'Generate an AI shopping plan from household context.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: { description: 'Plan generated' },
      402: { description: 'AI key not configured' },
      502: { description: 'AI provider error' },
    },
  }),
  async (c) => {
    const userId = c.get('userId')
    const householdId = c.get('householdId')

    // Currency is the only user preference this route needs; the AI access is
    // the household's assignment through the door (#523 P3). A shopping plan is
    // a REASONING call (#523 P4, plan §5.5), resolved once for this request.
    const settings = await c.env.DB.prepare('SELECT currency FROM user_settings WHERE user_id = ?')
      .bind(userId)
      .first<{ currency: string | null }>()

    const aiCtx = { env: c.env, userId, householdId }
    const access = await resolveAccess(aiCtx, 'reasoning')
    if (!access) {
      return c.json(
        {
          error: 'AI provider not configured. Go to Settings to set up your AI key.',
        },
        402
      )
    }

    const lowStock = await c.env.DB.prepare(
      `SELECT i.name, s.qty, s.unit, s.run_out_days, s.expiry_date
       FROM stock s
       JOIN items i ON i.id = s.item_id
       WHERE s.household_id = ? AND s.qty > 0
       AND (COALESCE(s.run_out_days, 999) <= 7 OR s.run_out_days IS NULL)`
    )
      .bind(householdId)
      .all<{
        name: string
        qty: number
        unit: string | null
        run_out_days: number | null
        expiry_date: string | null
      }>()

    const sevenDaysFromNow = new Date()
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7)
    const expiryCutoff = sevenDaysFromNow.toISOString().slice(0, 10)

    const expiring = await c.env.DB.prepare(
      `SELECT i.name, s.qty, s.unit, s.expiry_date
       FROM stock s
       JOIN items i ON i.id = s.item_id
       WHERE s.household_id = ? AND s.qty > 0
       AND s.expiry_date IS NOT NULL AND s.expiry_date <= ?`
    )
      .bind(householdId, expiryCutoff)
      .all<{
        name: string
        qty: number
        unit: string | null
        expiry_date: string | null
      }>()

    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    const sinceDate = thirtyDaysAgo.toISOString().slice(0, 10)

    const recentPurchases = await c.env.DB.prepare(
      `SELECT DISTINCT i.name, s.label AS store_label
       FROM purchase_items pi
       JOIN purchases p ON p.id = pi.purchase_id
       JOIN items i ON i.id = pi.item_id
       LEFT JOIN stores s ON s.id = p.store_id
       WHERE p.household_id = ? AND p.date >= ?
       ORDER BY i.name`
    )
      .bind(householdId, sinceDate)
      .all<{ name: string; store_label: string | null }>()

    const { results: stores } = await c.env.DB.prepare(
      'SELECT id, label FROM stores WHERE household_id = ? ORDER BY label'
    )
      .bind(householdId)
      .all<{ id: string; label: string }>()

    let generatedItems: Array<{
      name: string
      qty: number
      unit: string
      store_id: string | null
      price_estimate: number | null
      why: string
    }>
    // The attempt's call dimensions + tokens (success overwrites them).
    let usedCall: AiCall = access.call
    let tokenUsage: TokenUsage = EMPTY_USAGE

    if (c.env.TEST_MODE === 'true') {
      generatedItems = [
        {
          name: 'Susu cair 1L',
          qty: 1,
          unit: 'L',
          store_id: stores[0]?.id || null,
          price_estimate: 18500,
          why: 'running out in 2 days',
        },
        {
          name: 'Roti tawar',
          qty: 1,
          unit: 'pack',
          store_id: stores[0]?.id || null,
          price_estimate: 15000,
          why: 'expires in 2 days',
        },
        {
          name: 'Telur',
          qty: 10,
          unit: 'pcs',
          store_id: stores[1]?.id || null,
          price_estimate: 28000,
          why: 'running out in 3 days',
        },
      ]
    } else {
      try {
        const plan = await generateAiPlan(
          { ...aiCtx, access },
          lowStock.results || [],
          expiring.results || [],
          recentPurchases.results || [],
          stores || [],
          settings?.currency || 'IDR'
        )
        generatedItems = plan.items
        usedCall = plan.call
        tokenUsage = plan.usage
      } catch (err) {
        // The provider billed the failed attempt's input tokens; record them
        // as the call's event even though no plan came back.
        await recordAiFailureUsage(c.env, userId, { call: usedCall, usage: tokenUsage }, err)
        return c.json(
          {
            error: `AI plan generation failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
          },
          502
        )
      }
    }

    await recordAiCallUsage(c.env, userId, usedCall, tokenUsage)

    const storeLabels = new Map(stores.map((s) => [s.id, s.label]))

    const items = await Promise.all(
      generatedItems.map(async (item) => {
        const existingItem = await c.env.DB.prepare(
          'SELECT id, name FROM items WHERE household_id = ? AND LOWER(name) = LOWER(?)'
        )
          .bind(householdId, normalizeItemName(item.name))
          .first<{ id: string; name: string }>()

        // Price grounding (§5.4): a confident deterministic match against the
        // observed catalog overrides the LLM's price guess and links the
        // observation so the frontend can badge the estimate.
        const grounding = await groundPlanItem(c.env.DB, item.name)

        return {
          name: item.name,
          qty: item.qty,
          unit: item.unit,
          store_id: item.store_id,
          store_label: item.store_id ? storeLabels.get(item.store_id) || null : null,
          price_estimate: grounding ? grounding.observation.price : item.price_estimate,
          why: item.why,
          item_id: existingItem?.id || null,
          matched_item_name: existingItem?.name || null,
          price_observation_id: grounding?.observation.observationId ?? null,
          price_source_name: grounding?.observation.sourceName ?? null,
          price_valid_until: grounding?.observation.validUntil ?? null,
        }
      })
    )

    const total_estimate = items.reduce((sum, it) => sum + (it.price_estimate || 0), 0)

    const res = c.json({
      items,
      total_estimate,
      generated_at: new Date().toISOString(),
    })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.post(
  '/api/plans',
  describeRoute({
    description: 'Save a generated plan as active.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['name', 'qty', 'unit'],
                  properties: {
                    name: { type: 'string', minLength: 1 },
                    qty: { type: 'number', minimum: 0 },
                    unit: { type: 'string' },
                    store_id: { type: 'string' },
                    price_estimate: { type: 'number' },
                    why: { type: 'string' },
                    price_observation_id: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'Plan created' },
      400: { description: 'Validation error' },
      401: { description: 'Unauthorized' },
    },
  }),
  sValidator('json', planCreateSchema),
  async (c) => {
    const householdId = c.get('householdId')
    const body = c.req.valid('json')

    const statements: D1PreparedStatement[] = []

    const existingActive = await c.env.DB.prepare(
      'SELECT id, status FROM plans WHERE household_id = ? AND status = ?'
    )
      .bind(householdId, 'active')
      .first<{ id: string; status: string }>()

    if (existingActive) {
      statements.push(
        c.env.DB.prepare(
          "UPDATE plans SET status = 'archived', updated_at = datetime('now') WHERE id = ? AND household_id = ?"
        ).bind(existingActive.id, householdId)
      )
    }

    const planId = crypto.randomUUID()
    const now = new Date().toISOString()

    const totalEstimate = body.items.reduce((sum, it) => sum + (it.price_estimate || 0), 0)

    statements.push(
      c.env.DB.prepare(
        `INSERT INTO plans (id, household_id, status, total_estimate, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, ?)`
      ).bind(planId, householdId, totalEstimate, now, now)
    )

    // Client-supplied price_observation_id is untrusted (§5.4): a bogus id
    // would fail the whole batch on the plan_items FK and 500. Verify each id
    // against price_observations and persist null for the ones that don't
    // exist — the plan stays savable either way.
    const validObservationIds = new Set<string>()
    for (const item of body.items) {
      const observationId = item.price_observation_id
      if (!observationId || validObservationIds.has(observationId)) continue
      const observation = await c.env.DB.prepare('SELECT id FROM price_observations WHERE id = ?')
        .bind(observationId)
        .first<{ id: string }>()
      if (observation) validObservationIds.add(observationId)
    }

    const itemIdsByName = new Map<string, string>()

    for (const item of body.items) {
      let itemId: string | null = null
      if (item.store_id) {
        const store = await c.env.DB.prepare(
          'SELECT id FROM stores WHERE id = ? AND household_id = ?'
        )
          .bind(item.store_id, householdId)
          .first<{ id: string }>()
        if (!store) {
          return c.json({ error: `Store ${item.store_id} not found in this household` }, 400)
        }
      }

      const normalizedName = normalizeItemName(item.name)
      const seenItemId = itemIdsByName.get(normalizedName)

      if (seenItemId) {
        itemId = seenItemId
      } else {
        const existingItem = await c.env.DB.prepare(
          'SELECT id FROM items WHERE household_id = ? AND LOWER(name) = LOWER(?)'
        )
          .bind(householdId, normalizedName)
          .first<{ id: string }>()

        if (existingItem) {
          itemId = existingItem.id
        } else {
          itemId = crypto.randomUUID()
          statements.push(
            c.env.DB.prepare(
              'INSERT INTO items (id, household_id, name, default_unit) VALUES (?, ?, ?, ?)'
            ).bind(itemId, householdId, item.name.trim(), item.unit)
          )
        }
        itemIdsByName.set(normalizedName, itemId)
      }

      const planItemId = crypto.randomUUID()
      const groundedObservationId =
        item.price_observation_id && validObservationIds.has(item.price_observation_id)
          ? item.price_observation_id
          : null
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO plan_items (id, plan_id, item_id, store_id, qty, unit, price_estimate, why, status, price_observation_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        ).bind(
          planItemId,
          planId,
          itemId,
          item.store_id || null,
          item.qty,
          item.unit,
          item.price_estimate ?? null,
          item.why ?? null,
          groundedObservationId,
          now
        )
      )
    }

    try {
      await c.env.DB.batch(statements)
    } catch (err) {
      return c.json(
        {
          error: `Failed to save plan: ${err instanceof Error ? err.message : 'Unknown'}`,
        },
        500
      )
    }

    const plan = await c.env.DB.prepare(
      'SELECT id, household_id, status, total_estimate, created_at, updated_at FROM plans WHERE id = ? AND household_id = ?'
    )
      .bind(planId, householdId)
      .first()

    const { results: planItems } = await c.env.DB.prepare(
      `SELECT pi.id, pi.item_id, pi.store_id, i.name AS item_name,
              s.label AS store_label, pi.qty, pi.unit, pi.price_estimate, pi.why, pi.status,
              ps.name AS price_source_name, po.valid_until AS price_valid_until
       FROM plan_items pi
       JOIN plans p ON p.id = pi.plan_id
       LEFT JOIN items i ON i.id = pi.item_id
       LEFT JOIN stores s ON s.id = pi.store_id
       LEFT JOIN price_observations po ON po.id = pi.price_observation_id
       LEFT JOIN price_sources ps ON ps.id = po.source_id
       WHERE pi.plan_id = ? AND p.household_id = ?
       ORDER BY pi.created_at`
    )
      .bind(planId, householdId)
      .all<{
        id: string
        item_id: string | null
        store_id: string | null
        item_name: string | null
        store_label: string | null
        qty: number
        unit: string | null
        price_estimate: number | null
        why: string | null
        status: string
        price_source_name: string | null
        price_valid_until: string | null
      }>()

    const res = c.json({ plan: { ...plan, items: planItems } }, 201)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.patch(
  '/api/plans/:id/items/:itemId',
  describeRoute({
    description: 'Mark a plan item as bought or skipped.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['status'],
            properties: { status: { type: 'string', enum: ['bought', 'skipped'] } },
          },
        },
      },
    },
    responses: {
      200: { description: 'Updated' },
      400: { description: 'Validation error' },
      401: { description: 'Unauthorized' },
      404: { description: 'Not found' },
    },
  }),
  sValidator('json', planItemPatchSchema),
  async (c) => {
    const householdId = c.get('householdId')
    const planId = c.req.param('id')
    const itemId = c.req.param('itemId')
    const body = c.req.valid('json')

    const plan = await c.env.DB.prepare(
      'SELECT id, status FROM plans WHERE id = ? AND household_id = ?'
    )
      .bind(planId, householdId)
      .first<{ id: string; status: string }>()

    if (!plan) {
      return c.json({ error: 'Plan not found' }, 404)
    }

    const planItem = await c.env.DB.prepare(
      // #517 (security): checking a plan item off copies its item_id into
      // purchase_items and stock, so the row only resolves when that item
      // belongs to the caller's household. A plan item pointing outside the
      // household (a foreign id from any past or future write path) is
      // indistinguishable from a missing one: 404, and the batch never runs.
      `SELECT pi.id, pi.item_id, pi.store_id, pi.qty, pi.unit, pi.price_estimate, pi.status, pi.plan_id
       FROM plan_items pi
       WHERE pi.id = ? AND pi.plan_id = ?
         AND (pi.item_id IS NULL
              OR EXISTS (SELECT 1 FROM items i WHERE i.id = pi.item_id AND i.household_id = ?))`
    )
      .bind(itemId, planId, householdId)
      .first<{
        id: string
        item_id: string | null
        store_id: string | null
        qty: number
        unit: string | null
        price_estimate: number | null
        status: string
        plan_id: string
      }>()

    if (!planItem) {
      return c.json({ error: 'Plan item not found' }, 404)
    }

    if (plan.status !== 'active') {
      return c.json({ error: 'Plan is not active' }, 400)
    }

    const now = new Date().toISOString()
    const statements: D1PreparedStatement[] = []

    statements.push(
      c.env.DB.prepare(
        `UPDATE plan_items SET status = ? WHERE id = ? AND plan_id IN (SELECT id FROM plans WHERE id = ? AND household_id = ?)`
      ).bind(body.status, itemId, planId, householdId)
    )

    if (body.status === 'bought' && planItem.item_id && planItem.status !== 'bought') {
      const defaultLocation = await c.env.DB.prepare(
        'SELECT id FROM locations WHERE household_id = ? ORDER BY sort_order LIMIT 1'
      )
        .bind(householdId)
        .first<{ id: string }>()

      const purchaseId = crypto.randomUUID()
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO purchases (id, household_id, store_id, date, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(purchaseId, householdId, planItem.store_id || null, now.slice(0, 10), now)
      )

      const purchaseItemId = crypto.randomUUID()
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO purchase_items (id, purchase_id, item_id, qty, unit, price, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          purchaseItemId,
          purchaseId,
          planItem.item_id,
          planItem.qty,
          planItem.unit,
          planItem.price_estimate ?? 0,
          now
        )
      )

      const existingStock = await c.env.DB.prepare(
        'SELECT id, qty FROM stock WHERE household_id = ? AND item_id = ?'
      )
        .bind(householdId, planItem.item_id)
        .first<{ id: string; qty: number }>()

      if (existingStock) {
        const newQty = existingStock.qty + planItem.qty
        const runOut = await computeRunOutDays(householdId, planItem.item_id, newQty, c.env.DB)
        statements.push(
          c.env.DB.prepare(
            `UPDATE stock SET qty = ?, run_out_days = ?, basis = ?, updated_at = datetime('now') WHERE id = ? AND household_id = ?`
          ).bind(newQty, runOut.run_out_days, runOut.basis, existingStock.id, householdId)
        )
      } else {
        const stockId = crypto.randomUUID()
        const locationId = defaultLocation?.id || null
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO stock (id, household_id, item_id, location_id, qty, unit, run_out_days, basis, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 30, 'default', ?)`
          ).bind(
            stockId,
            householdId,
            planItem.item_id,
            locationId,
            planItem.qty,
            planItem.unit,
            now
          )
        )
      }
    }

    try {
      await c.env.DB.batch(statements)
    } catch (err) {
      return c.json(
        {
          error: `Failed to update plan item: ${err instanceof Error ? err.message : 'Unknown'}`,
        },
        500
      )
    }

    const { results: allItems } = await c.env.DB.prepare(
      `SELECT pi.status FROM plan_items pi
       JOIN plans p ON p.id = pi.plan_id
       WHERE pi.plan_id = ? AND p.household_id = ?`
    )
      .bind(planId, householdId)
      .all<{ status: string }>()

    const allResolved = allItems.every((i) => i.status !== 'pending')
    if (allResolved) {
      const newStatus = body.status === 'bought' ? 'completed' : 'completed'
      await c.env.DB.prepare(
        `UPDATE plans SET status = ?, updated_at = datetime('now') WHERE id = ? AND household_id = ?`
      )
        .bind(newStatus, planId, householdId)
        .run()
    }

    const updatedItem = await c.env.DB.prepare(
      `SELECT pi.id, pi.item_id, pi.store_id, i.name AS item_name,
              s.label AS store_label, pi.qty, pi.unit, pi.price_estimate, pi.why, pi.status
       FROM plan_items pi
       JOIN plans p ON p.id = pi.plan_id
       LEFT JOIN items i ON i.id = pi.item_id
       LEFT JOIN stores s ON s.id = pi.store_id
       WHERE pi.id = ? AND p.household_id = ?`
    )
      .bind(itemId, householdId)
      .first()

    const updatedPlan = await c.env.DB.prepare(
      'SELECT id, status, total_estimate, created_at, updated_at FROM plans WHERE id = ? AND household_id = ?'
    )
      .bind(planId, householdId)
      .first()

    const res = c.json({ item: updatedItem, plan: updatedPlan })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.notFound(async (c) => {
  // QA-F1 (run 2026-11-07-01, ticket #483): an unmatched /api path must
  // answer the API's typed JSON 404, never the SPA shell — the ASSETS
  // fallback exists for the frontend's client-side routes, and an API client
  // (pipeline contract consumers included) must never receive HTML (or the
  // asset server's 405 on non-GET) from an /api/* path. The namespace
  // predicate is SHARED with the gateway's dispatch (QF-B1) so the two can
  // never drift again.
  if (isApiPath(c.req.path)) {
    return c.json({ error: 'Not found' }, 404, { 'Cache-Control': 'private, no-cache' })
  }
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw)
  }
  return c.json({ error: 'Not found' }, 404)
})

export { apiApp }
