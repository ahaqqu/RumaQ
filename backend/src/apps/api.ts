import { Hono } from 'hono'
import { logger } from 'hono/logger'
import type { MiddlewareHandler } from 'hono'

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
  pipe,
  regex,
  transform,
} from 'valibot'
import {
  SCRAPE_STORE_SLUGS,
  scrapeCommandCreateSchema,
  scrapeEventsPostSchema,
  scrapeFinishSchema,
} from '@rumaq/contract'
import type { Env } from '../types.js'
import { createCors } from '../cors.js'
import { propsAuthMiddleware } from '../auth.js'
import { encryptAiKey, decryptAiKey, timingSafeEqualStrings } from '../lib/crypto.js'
import {
  ingestPayloadSchema,
  runReportSchema,
  ingestPrices,
  getPricesStatus,
} from '../lib/ingest.js'
import {
  LATEST_OBSERVATION_SUBQUERY,
  LATEST_OBSERVATION_PREDICATE,
  getPromoCatalog,
} from '../lib/prices.js'
import {
  BROCHURE_CONTENT_TYPES,
  BROCHURE_MAX_BYTES,
  getBrochureCatalog,
  parseBrochureKey,
  sweepUnreferencedBrochures,
} from '../lib/brochures.js'
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
  recordReviewItems,
  listReviewItems,
  decideReviewItem,
  undoReviewDecision,
  exportReviewDecisions,
} from '../lib/match-review.js'
import { requireAdmin } from '../lib/admin.js'
import { groundPlanItem } from '../lib/grounding.js'
import { escapeLike } from '../lib/sql.js'
import { getRateLimitConfig, isRateLimited } from '../lib/rate-limit.js'
import { computeRunOutDays } from '../lib/stock.js'
import { computePatterns } from '../lib/patterns.js'
import {
  validateImage,
  buildKey,
  uploadReceipt,
  getSignedUrl,
  extFromType,
} from '../lib/receipts.js'
import { extractReceiptItems, usageCollector, type TokenUsage } from '../lib/ai.js'
import {
  resolveAiAccess,
  getOrCreateAiUsage,
  isAiUsageLimited,
  recordAiUsage,
  type UserAiSettings,
} from '../lib/ai-access.js'
import { sendChatMessage } from '../lib/chat.js'
import {
  settingsPatchSchema,
  locationSchema,
  storeSchema,
  aiKeyTestSchema,
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

// Admin review verdicts (issue #294): approve = "yes, same product, trust
// this match"; reject = "no, split them". Recorded only — v1 decisions
// change nothing downstream (docs/294-design-pm.md §4).
const reviewDecisionSchema = object({
  decision: picklist(['approved', 'rejected']),
})

const apiApp = new Hono<Env>()

apiApp.use(logger())
apiApp.use('*', createCors())

// General per-user/per-IP API rate limiting. Applied after CORS but before auth
// so that unauthenticated bursts are also throttled. Keys are in-memory only;
// move to KV for multi-instance deployments.
apiApp.use('*', async (c, next) => {
  // Service-to-service ingest authenticates with a bearer secret and runs
  // once daily — exempt it from the per-IP limiter.
  if (c.req.path.startsWith('/api/internal/')) {
    await next()
    return
  }
  // Rate-limit by client IP. In production, Cloudflare sets CF-Connecting-IP,
  // which is authoritative. The X-Forwarded-For fallback is only for the
  // local Docker test stack, where the reverse proxy supplies a synthetic IP
  // per test scenario. A browser client cannot spoof CF-Connecting-IP.
  const clientIp =
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  const key = `api:${clientIp}`
  const { windowMs, maxRequests } = getRateLimitConfig(c.env)
  const { limited, retryAfter } = isRateLimited(key, windowMs, maxRequests)
  if (limited) {
    return c.json({ error: 'Too many requests. Please slow down.' }, 429, {
      'Retry-After': String(retryAfter),
    })
  }
  await next()
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
  if (!c.env.HAQITA_INGEST_SECRET) {
    return c.json({ error: 'Ingest endpoint not configured' }, 503)
  }
  const header = c.req.header('Authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token || !(await timingSafeEqualStrings(token, c.env.HAQITA_INGEST_SECRET))) {
    return c.json({ error: 'Unauthorized' }, 401, {
      'WWW-Authenticate': 'Bearer realm="rumaq-ingest"',
    })
  }
  await next()
}

apiApp.post(
  '/api/internal/ingest/prices',
  requireIngestSecret,
  sValidator('json', ingestPayloadSchema),
  async (c) => {
    const result = await ingestPrices(c.env.DB, c.req.valid('json'))
    // Brochure retention sweep (issue #293): piggybacks on the ingest — the
    // daily tick that is exactly when the referenced set changes — never a
    // cron (a preview worker inheriting the trigger would sweep production
    // from preview code). Best-effort: a sweep failure is a logged no-op and
    // never fails the ingest response or alters its shape.
    try {
      if (c.env.BROCHURES) {
        await sweepUnreferencedBrochures(c.env.DB, c.env.BROCHURES, {
          log: (message) => console.log(message),
        })
      }
    } catch (error) {
      console.warn('[brochures] retention sweep failed:', error)
    }
    return c.json(result)
  }
)

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

apiApp.use('/api/me', propsAuthMiddleware)
apiApp.use('/api/stock', propsAuthMiddleware)
apiApp.use('/api/stock/:id', propsAuthMiddleware)
apiApp.use('/api/home', propsAuthMiddleware)
apiApp.use('/api/settings', propsAuthMiddleware)
apiApp.use('/api/ai/usage', propsAuthMiddleware)
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
apiApp.use('/api/admin/price-runs', propsAuthMiddleware)
apiApp.use('/api/admin/scrape', propsAuthMiddleware)
apiApp.use('/api/admin/scrape/stores', propsAuthMiddleware)
apiApp.use('/api/admin/scrape/commands', propsAuthMiddleware)
apiApp.use('/api/admin/scrape/commands/:id/events', propsAuthMiddleware)
// The review queue (issue #294): apiApp.use(path) does NOT cover subpaths
// (#292 landmine) — every path gets its own line, statics before params.
apiApp.use('/api/admin/review', propsAuthMiddleware)
apiApp.use('/api/admin/review/export', propsAuthMiddleware)
apiApp.use('/api/admin/review/:id/decision', propsAuthMiddleware)
apiApp.use('/api/ai-key/*', propsAuthMiddleware)

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
    // Response shape is the openapi contract — project the row explicitly so
    // the raw is_admin column never leaks into the JSON.
    const res = c.json({
      user: user
        ? {
            id: user.id,
            email: user.email,
            name: user.name,
            picture: user.picture,
            isAdmin: user.is_admin === 1,
          }
        : null,
    })
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

    const res = c.json({
      total_items: totalItems,
      expiring_7d: expiring7d,
      running_out_7d: runningOut7d,
      low_stock: lowStock.results ?? [],
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
      200: { description: 'OK' },
      401: { description: 'Unauthorized' },
    },
  }),
  async (c) => {
    const settings = await c.env.DB.prepare(
      `SELECT motion_preference, language, ai_provider, ai_base_url, ai_model,
               ai_thinking_level, persona_user_role, persona_ai_role, persona_enabled,
               theme_hue, active_household_id, encrypted_ai_key
        FROM user_settings WHERE user_id = ?`
    )
      .bind(c.get('userId'))
      .first<{
        motion_preference: string
        language: string | null
        ai_provider: string | null
        ai_base_url: string | null
        ai_model: string | null
        ai_thinking_level: string | null
        persona_user_role: string | null
        persona_ai_role: string | null
        persona_enabled: number
        theme_hue: number | null
        active_household_id: string | null
        encrypted_ai_key: string | null
      }>()

    const household = settings?.active_household_id
      ? await c.env.DB.prepare('SELECT name FROM households WHERE id = ?')
          .bind(settings.active_household_id)
          .first<{ name: string }>()
      : null

    const res = c.json({
      motion_preference: settings?.motion_preference ?? 'standard',
      language: settings?.language ?? null,
      ai_provider: settings?.ai_provider ?? null,
      ai_base_url: settings?.ai_base_url ?? null,
      ai_model: settings?.ai_model ?? null,
      ai_thinking_level: settings?.ai_thinking_level ?? null,
      persona_user_role: settings?.persona_user_role ?? null,
      persona_ai_role: settings?.persona_ai_role ?? null,
      persona_enabled: settings?.persona_enabled === 1,
      theme_hue: settings?.theme_hue ?? null,
      active_household_id: settings?.active_household_id ?? null,
      active_household_name: household?.name ?? null,
      has_ai_key: settings?.encrypted_ai_key != null && settings.encrypted_ai_key !== '',
      server_ai_available: Boolean(c.env.RUMAQ_SERVER_AI_PROVIDER && c.env.RUMAQ_SERVER_AI_KEY),
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
            properties: {
              ai_provider: {
                type: 'string',
                enum: ['opencode', 'openai', 'anthropic', 'gemini', 'ollama', 'custom'],
              },
              ai_key: { type: 'string', minLength: 1 },
              ai_base_url: { type: 'string', maxLength: 500 },
              ai_model: { type: 'string', maxLength: 200 },
              ai_thinking_level: { type: 'string', enum: ['low', 'medium', 'high', ''] },
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

    if (body.ai_key !== undefined) {
      const normalized = typeof body.ai_key === 'string' ? body.ai_key.trim() : ''
      if (normalized.length === 0) {
        updates.push('encrypted_ai_key = NULL')
      } else {
        const encrypted = await encryptAiKey(normalized, c.env.WORKER_ENCRYPTION_KEY)
        updates.push('encrypted_ai_key = ?')
        params.push(encrypted)
      }
    }
    const fields = body
    if (fields.ai_provider !== undefined) {
      updates.push('ai_provider = ?')
      params.push(fields.ai_provider)
    }
    if (fields.ai_base_url !== undefined) {
      const trimmed = fields.ai_base_url.trim()
      if (trimmed === '') {
        updates.push('ai_base_url = ?')
        params.push(null)
      } else {
        let parsed: URL
        try {
          parsed = new URL(trimmed)
        } catch {
          return c.json({ error: 'Invalid AI base URL' }, 400)
        }
        if (parsed.protocol !== 'https:') {
          return c.json({ error: 'AI base URL must use HTTPS' }, 400)
        }
        updates.push('ai_base_url = ?')
        params.push(trimmed.replace(/\/+$/, ''))
      }
    }
    if (fields.ai_model !== undefined) {
      const trimmed = fields.ai_model.trim()
      updates.push('ai_model = ?')
      params.push(trimmed === '' ? null : trimmed)
    }
    if (fields.ai_thinking_level !== undefined) {
      updates.push('ai_thinking_level = ?')
      params.push(fields.ai_thinking_level === '' ? null : fields.ai_thinking_level)
    }
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
      `SELECT motion_preference, language, ai_provider, ai_base_url, ai_model,
              ai_thinking_level, persona_user_role, persona_ai_role, persona_enabled,
              theme_hue, encrypted_ai_key
        FROM user_settings WHERE user_id = ?`
    )
      .bind(c.get('userId'))
      .first<{
        motion_preference: string
        language: string | null
        ai_provider: string | null
        ai_base_url: string | null
        ai_model: string | null
        ai_thinking_level: string | null
        persona_user_role: string | null
        persona_ai_role: string | null
        persona_enabled: number
        theme_hue: number | null
        encrypted_ai_key: string | null
      }>()

    const res = c.json({
      motion_preference: settings?.motion_preference ?? 'standard',
      language: settings?.language ?? null,
      ai_provider: settings?.ai_provider ?? null,
      ai_base_url: settings?.ai_base_url ?? null,
      ai_model: settings?.ai_model ?? null,
      ai_thinking_level: settings?.ai_thinking_level ?? null,
      persona_user_role: settings?.persona_user_role ?? null,
      persona_ai_role: settings?.persona_ai_role ?? null,
      persona_enabled: settings?.persona_enabled === 1,
      theme_hue: settings?.theme_hue ?? null,
      has_ai_key: settings?.encrypted_ai_key != null && settings.encrypted_ai_key !== '',
    })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

apiApp.post(
  '/api/ai-key/test',
  describeRoute({
    description: 'Validates an AI provider API key.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['provider'],
            properties: {
              provider: {
                type: 'string',
                enum: ['opencode', 'openai', 'anthropic', 'gemini', 'ollama', 'custom'],
              },
              key: { type: 'string', minLength: 1 },
              base_url: { type: 'string', maxLength: 500 },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'OK - key is valid' },
      400: { description: 'Validation error' },
      401: { description: 'Unauthorized' },
    },
  }),
  sValidator('json', aiKeyTestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const provider = body.provider
    const providedKey = body.key
    let apiKey: string | undefined

    if (providedKey !== undefined && providedKey.trim().length > 0) {
      apiKey = providedKey.trim()
    }

    if (apiKey === undefined) {
      const settings = await c.env.DB.prepare(
        'SELECT encrypted_ai_key FROM user_settings WHERE user_id = ?'
      )
        .bind(c.get('userId'))
        .first<{ encrypted_ai_key: string | null }>()

      if (!settings?.encrypted_ai_key) {
        return c.json({ error: 'No API key saved' }, 400)
      }

      apiKey = await decryptAiKey(settings.encrypted_ai_key, c.env.WORKER_ENCRYPTION_KEY)
    }

    try {
      switch (provider) {
        case 'gemini': {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`
          )
          if (!res.ok) throw new Error()
          break
        }
        case 'anthropic': {
          const res = await fetch('https://api.anthropic.com/v1/models', {
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
          })
          if (!res.ok) throw new Error()
          break
        }
        case 'openai': {
          const res = await fetch('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${apiKey}` },
          })
          if (!res.ok) throw new Error()
          break
        }
        case 'opencode': {
          const res = await fetch('https://api.opencode.ai/v1/models', {
            headers: { Authorization: `Bearer ${apiKey}` },
          })
          if (!res.ok) throw new Error()
          break
        }
        case 'ollama': {
          const res = await fetch('https://ollama.com/v1/models', {
            headers: { Authorization: `Bearer ${apiKey}` },
          })
          if (!res.ok) throw new Error()
          break
        }
        case 'custom': {
          const baseUrl = body.base_url?.trim()
          if (!baseUrl) return c.json({ error: 'Base URL required for custom provider' }, 400)
          let modelsUrl: URL
          try {
            modelsUrl = new URL(`${baseUrl.replace(/\/+$/, '')}/models`)
          } catch {
            return c.json({ error: 'Invalid base URL' }, 400)
          }
          if (modelsUrl.protocol !== 'https:') {
            return c.json({ error: 'Base URL must use HTTPS' }, 400)
          }
          const res = await fetch(modelsUrl.toString(), {
            headers: { Authorization: `Bearer ${apiKey}` },
          })
          if (!res.ok) throw new Error()
          break
        }
      }

      return c.json({ ok: true })
    } catch {
      return c.json({ error: 'Invalid API key' }, 400)
    }
  }
)

apiApp.get(
  '/api/ai/usage',
  describeRoute({
    description: 'Returns today AI usage for the current user.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: { description: 'OK' },
      401: { description: 'Unauthorized' },
    },
  }),
  async (c) => {
    const userId = c.get('userId')
    const today = new Date().toISOString().slice(0, 10)

    const settings = await c.env.DB.prepare(
      `SELECT ai_provider, ai_base_url, ai_model, ai_thinking_level, encrypted_ai_key
        FROM user_settings WHERE user_id = ?`
    )
      .bind(userId)
      .first<UserAiSettings>()

    // Resolved fresh so it always reflects the user's current configuration,
    // not the state when today's counter row was created.
    const access = await resolveAiAccess(c.env, settings)
    const keySource = access?.keySource ?? 'user'
    const provider = access?.provider ?? settings?.ai_provider ?? null

    const existing = await c.env.DB.prepare(
      'SELECT id, used, daily_limit, provider, input_tokens, output_tokens FROM ai_usage WHERE user_id = ? AND date = ?'
    )
      .bind(userId, today)
      .first<{
        id: string
        used: number
        daily_limit: number
        provider: string | null
        input_tokens: number
        output_tokens: number
      }>()

    if (!existing) {
      const id = crypto.randomUUID()
      await c.env.DB.prepare(
        'INSERT INTO ai_usage (id, user_id, date, provider, used, daily_limit) VALUES (?, ?, ?, ?, 0, 20)'
      )
        .bind(id, userId, today, provider)
        .run()

      const res = c.json({
        used: 0,
        daily_limit: 20,
        provider,
        key_source: keySource,
        input_tokens: 0,
        output_tokens: 0,
      })
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    }

    const res = c.json({
      used: existing.used,
      daily_limit: existing.daily_limit,
      provider: existing.provider ?? provider,
      key_source: keySource,
      input_tokens: existing.input_tokens,
      output_tokens: existing.output_tokens,
    })
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
      429: { description: 'AI usage limit exceeded' },
      502: { description: 'AI provider error' },
    },
  }),
  sValidator('json', chatSchema),
  async (c) => {
    const userId = c.get('userId')
    const householdId = c.get('householdId')
    const { message, history } = c.req.valid('json')

    const settings = await c.env.DB.prepare(
      `SELECT ai_provider, ai_base_url, ai_model, ai_thinking_level, encrypted_ai_key,
              persona_enabled, persona_user_role, persona_ai_role
         FROM user_settings WHERE user_id = ?`
    )
      .bind(userId)
      .first<{
        ai_provider: string | null
        ai_base_url: string | null
        ai_model: string | null
        ai_thinking_level: string | null
        encrypted_ai_key: string | null
        persona_enabled: number | null
        persona_user_role: string | null
        persona_ai_role: string | null
      }>()

    const access = await resolveAiAccess(c.env, settings)
    if (!access) {
      return c.json(
        {
          error: 'AI provider not configured. Go to Settings to set up your AI key.',
        },
        402
      )
    }

    const usageRow = await getOrCreateAiUsage(c.env, userId, access.provider)

    if (isAiUsageLimited(access, usageRow)) {
      return c.json(
        {
          error: 'AI usage limit reached for today. Upgrade or wait until tomorrow.',
        },
        429,
        { 'Retry-After': '86400' }
      )
    }

    let reply: string
    const tokenUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
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
        reply = await sendChatMessage(
          access.provider,
          access.apiKey,
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
          history || [],
          {
            baseUrl: access.baseUrl,
            model: access.model,
            thinkingLevel: access.thinkingLevel,
            onUsage: usageCollector(tokenUsage),
          }
        )
      } catch (err) {
        // The provider billed the failed attempt's input tokens; meter them
        // even though the request itself is not counted.
        await recordAiUsage(c.env, usageRow, {
          inputTokens: tokenUsage.input_tokens,
          outputTokens: tokenUsage.output_tokens,
        })
        return c.json(
          {
            error: `AI chat failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
          },
          502
        )
      }
    }

    await recordAiUsage(c.env, usageRow, {
      requests: 1,
      inputTokens: tokenUsage.input_tokens,
      outputTokens: tokenUsage.output_tokens,
    })

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
      429: { description: 'AI usage limit exceeded' },
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

    const settings = await c.env.DB.prepare(
      `SELECT ai_provider, ai_base_url, ai_model, ai_thinking_level, encrypted_ai_key
        FROM user_settings WHERE user_id = ?`
    )
      .bind(userId)
      .first<{
        ai_provider: string | null
        ai_base_url: string | null
        ai_model: string | null
        ai_thinking_level: string | null
        encrypted_ai_key: string | null
      }>()

    const access = await resolveAiAccess(c.env, settings)
    if (!access) {
      return c.json(
        {
          error: 'AI provider not configured. Go to Settings to set up your AI key.',
        },
        402
      )
    }

    const usageRow = await getOrCreateAiUsage(c.env, userId, access.provider)

    if (isAiUsageLimited(access, usageRow)) {
      return c.json(
        {
          error: 'AI usage limit reached for today. Upgrade or wait until tomorrow.',
        },
        429,
        { 'Retry-After': '86400' }
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
    const tokenUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
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
        scanResult = await extractReceiptItems(
          file.data,
          file.type,
          access.provider,
          access.apiKey,
          {
            baseUrl: access.baseUrl,
            model: access.model,
            thinkingLevel: access.thinkingLevel,
            onUsage: usageCollector(tokenUsage),
          }
        )
      } catch (err) {
        // The provider billed the failed attempt's input tokens; meter them
        // even though the request itself is not counted.
        await recordAiUsage(c.env, usageRow, {
          inputTokens: tokenUsage.input_tokens,
          outputTokens: tokenUsage.output_tokens,
        })
        return c.json(
          {
            error: `AI scan failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
            imageKey: key,
          },
          502
        )
      }
    }

    await recordAiUsage(c.env, usageRow, {
      requests: 1,
      inputTokens: tokenUsage.input_tokens,
      outputTokens: tokenUsage.output_tokens,
    })

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
    description: 'Create a purchase with items, updating stock and purchase history.',
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
      let itemId = item.item_id || null

      if (!itemId) {
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

// Optional q / source filters shared by the legacy flat query and the sorted
// CTE pipeline. Inside the CTE the aggregates (price_min, savings_pct, …)
// reflect exactly the filtered set the user is looking at.
function buildPriceFilters(q: string | undefined, source: string | undefined) {
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
// displayed only — they never rewrite catalog or price data (v1 cut). All
// four routes: requireAdmin after the shared propsAuthMiddleware use() lines
// above; statics (/export) registered before the :id/decision params.
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
    entryProductKey: { type: 'string' },
    entryName: { type: 'string' },
    entryBrand: { type: ['string', 'null'] },
    entryUnit: { type: ['string', 'null'] },
    entryPrice: { type: 'integer' },
    entryEffectiveUnitPrice: { type: ['number', 'null'] },
    entryStore: { type: 'string' },
    matchMethod: { type: 'string', enum: ['exact', 'embedding', 'ai'] },
    confidence: { type: 'number' },
    reason: { type: 'string', enum: ['price_ratio', 'verifier_unresolved'] },
    status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
    decidedAt: { type: ['string', 'null'] },
    decidedBy: { type: ['string', 'null'] },
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
      'Record a review verdict (approve/reject) for a flagged pair (admin-only). Last verdict wins.',
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
    const item = await decideReviewItem(
      c.env.DB,
      c.req.param('id'),
      c.req.valid('json').decision,
      c.get('userId')
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
    },
  }),
  sValidator('query', pricesQuery),
  async (c) => {
    const { q, source, sort } = c.req.valid('query')

    const filters = buildPriceFilters(q, source)

    // No sort param → the legacy flat name-ordered query and its exact
    // response: usePriceSources builds the source-chip bar from this path and
    // must never see a different shape or order.
    if (!sort) {
      let sql = `SELECT p.product_key, p.name, p.brand, p.unit, p.category,
                      s.slug AS source_slug, s.name AS source_name,
                      o.observed_date, o.price, o.effective_unit_price,
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
      'Price data freshness: latest scrape time, latest observed date, and observation count.',
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
              },
              required: ['latestScrapedAt', 'latestObservedDate', 'observationCount'],
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
    },
  }),
  async (c) => {
    const status = await getPricesStatus(c.env.DB)
    const res = c.json(status)
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
  describeRoute({
    description: 'Price detail for one product: per-store current prices and full history.',
    security: [{ cookieAuth: [] }],
    parameters: [{ in: 'path', name: 'productKey', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'OK' },
      401: { description: 'Unauthorized' },
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
      429: { description: 'AI usage limit exceeded' },
    },
  }),
  async (c) => {
    const userId = c.get('userId')
    const householdId = c.get('householdId')

    const settings = await c.env.DB.prepare(
      `SELECT ai_provider, ai_base_url, ai_model, ai_thinking_level, encrypted_ai_key, currency
        FROM user_settings WHERE user_id = ?`
    )
      .bind(userId)
      .first<{
        ai_provider: string | null
        ai_base_url: string | null
        ai_model: string | null
        ai_thinking_level: string | null
        encrypted_ai_key: string | null
        currency: string | null
      }>()

    const access = await resolveAiAccess(c.env, settings)
    if (!access) {
      return c.json(
        {
          error: 'AI provider not configured. Go to Settings to set up your AI key.',
        },
        402
      )
    }

    const usageRow = await getOrCreateAiUsage(c.env, userId, access.provider)

    if (isAiUsageLimited(access, usageRow)) {
      return c.json(
        {
          error: 'AI usage limit reached for today. Upgrade or wait until tomorrow.',
        },
        429,
        { 'Retry-After': '86400' }
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
    const tokenUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }

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
        generatedItems = await generateAiPlan(
          access.provider,
          access.apiKey,
          lowStock.results || [],
          expiring.results || [],
          recentPurchases.results || [],
          stores || [],
          settings?.currency || 'IDR',
          {
            baseUrl: access.baseUrl,
            model: access.model,
            thinkingLevel: access.thinkingLevel,
            onUsage: usageCollector(tokenUsage),
          }
        )
      } catch (err) {
        // The provider billed the failed attempt's input tokens; meter them
        // even though the request itself is not counted.
        await recordAiUsage(c.env, usageRow, {
          inputTokens: tokenUsage.input_tokens,
          outputTokens: tokenUsage.output_tokens,
        })
        return c.json(
          {
            error: `AI plan generation failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
          },
          502
        )
      }
    }

    await recordAiUsage(c.env, usageRow, {
      requests: 1,
      inputTokens: tokenUsage.input_tokens,
      outputTokens: tokenUsage.output_tokens,
    })

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
      `SELECT pi.id, pi.item_id, pi.store_id, pi.qty, pi.unit, pi.price_estimate, pi.status, pi.plan_id
       FROM plan_items pi WHERE pi.id = ? AND pi.plan_id = ?`
    )
      .bind(itemId, planId)
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
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw)
  }
  return c.json({ error: 'Not found' }, 404)
})

export { apiApp }
