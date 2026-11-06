// Plugin settings catalog routes (ahaqqu/RumaQ#437 — plugin architecture
// ticket 3, docs/plan/plugin-architecture.md §4.5). Same stack as the
// households/tasks/calendar apps: logger + CORS + per-IP limiter,
// propsAuthMiddleware on every path, and an onError mapping the lib's typed
// errors. This is a CORE surface, deliberately not a plugin: it must answer
// even when every plugin is disabled — it is the thing that re-enables them
// (the gateway dispatches it ahead of the registry's prefix matching).
// Scopes to the caller's ACTIVE household (auth middleware) — the same
// household /api/me advertises enabledPlugins for, so the catalog, the
// toggle and the nav gating can never disagree about which household they
// describe. Reads are for every member (enablement is not hidden, §3.2);
// writes gate on requireOwner — the household-admin idiom (lib/households).
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { describeRoute } from 'hono-openapi'
import type { OpenAPIV3_1 } from 'openapi-types'
import { sValidator } from '@hono/standard-validator'
import { object, picklist, pipe, string, maxLength, minLength } from 'valibot'

import type { Env } from '../types.js'
import { createCors } from '../cors.js'
import { propsAuthMiddleware } from '../auth.js'
import { ipRateLimitMiddleware } from '../lib/rate-limit.js'
import {
  PluginNotFoundError,
  PluginPurgeConfirmationError,
  PluginPurgeNotActiveError,
  PluginPurgeUnsupportedError,
  cancelPluginPurge,
  getPluginCatalog,
  requestPluginPurge,
  setPluginEnablement,
  type PluginCatalogEntry,
} from '../lib/plugins.js'
import { HouseholdNotFoundError, HouseholdForbiddenError } from '../lib/households.js'

// Per-household fact — never cached at the edge (every other authenticated
// response in the app carries the same directive).
const NO_CACHE = { 'Cache-Control': 'private, no-cache' }

const pluginParamsSchema = object({
  pluginId: pipe(string(), minLength(1), maxLength(64)),
})

const enablementPatchSchema = object({
  status: picklist(['enabled', 'disabled']),
})

// The typed-confirmation body (ticket 5, #439): the owner must type the
// plugin's name EXACTLY (the server compares against the manifest name —
// the modal copy shows the same string). A checkbox is a misclick away; a
// typed string is the deliberate act §3.4 requires.
const purgeBodySchema = object({
  confirm: pipe(string(), minLength(1), maxLength(120)),
})

// The contract shape — one entry per registered manifest, every posture
// layer present (the UI renders each honestly, issue #437).
const pluginCatalogEntrySchema: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  required: [
    'id',
    'name',
    'capabilities',
    'default_enabled',
    'enabled',
    'source',
    'deployment_available',
    'plan_entitled',
    'available',
  ],
  properties: {
    id: { type: 'string', description: 'Stable plugin slug — the manifest id' },
    name: { type: 'string', description: 'Human label (EN); customer copy stays in i18n' },
    capabilities: {
      type: 'array',
      items: { type: 'string' },
      description: 'Declared capability ids (snake_case) for the catalog surface',
    },
    default_enabled: {
      type: 'boolean',
      description: 'The manifest default for households that never expressed a choice',
    },
    enabled: {
      type: 'boolean',
      description:
        'The household layer, resolved: the household_plugins row wins over the manifest default (§4.3 truth table)',
    },
    source: {
      type: 'string',
      enum: ['default', 'household'],
      description:
        'Whether the resolved state is the manifest default or an explicit household choice',
    },
    deployment_available: {
      type: 'boolean',
      description:
        'The ops kill-switch layer: false means this deployment paused the plugin (routes answer 404)',
    },
    plan_entitled: {
      type: 'boolean',
      description:
        'The plan layer: false would deny plugin routes with 403 (the only actionable denial). No plugin declares entitlements yet, so this is true tonight',
    },
    available: {
      type: 'boolean',
      description:
        'Effective access (§3.3): deployment_available AND plan_entitled AND enabled — what the plugin gate enforces',
    },
    purge: {
      type: ['object', 'null'],
      description:
        'The purge state machine (ticket 5 #439, §3.4): pending → running → done, null until the household ever requested a purge. The nightly chunk driver moves pending → running → done; initiation is the owner-only typed-confirmation endpoint',
      required: ['state', 'requested_at', 'completed_at'],
      properties: {
        state: {
          type: 'string',
          enum: ['pending', 'running', 'done'],
          description:
            'pending = requested, waiting for the nightly drain; running = a drain chunk is in flight; done = last purge completed',
        },
        requested_at: {
          type: ['string', 'null'],
          description: 'When the owner typed the confirmation (null if never requested)',
        },
        completed_at: {
          type: ['string', 'null'],
          description: 'When the last purge finished (null until done)',
        },
      },
    },
  },
}

const pluginCatalogResponseSchema: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  required: ['plugins'],
  properties: {
    plugins: { type: 'array', items: pluginCatalogEntrySchema },
  },
}

const pluginsApp = new Hono<Env>()

pluginsApp.use(logger())
pluginsApp.use('*', createCors())
pluginsApp.use('*', ipRateLimitMiddleware)

// apiApp.use(path) does not cover subpaths (#292 landmine) — every path gets
// its own line, statics before params.
pluginsApp.use('/api/plugins', propsAuthMiddleware)
pluginsApp.use('/api/plugins/:pluginId/enablement', propsAuthMiddleware)
pluginsApp.use('/api/plugins/:pluginId/purge', propsAuthMiddleware)

pluginsApp.onError((err, c) => {
  if (err instanceof HouseholdNotFoundError) return c.json({ error: err.message }, 404, NO_CACHE)
  if (err instanceof HouseholdForbiddenError) return c.json({ error: err.message }, 403, NO_CACHE)
  if (err instanceof PluginNotFoundError) return c.json({ error: err.message }, 404, NO_CACHE)
  if (err instanceof PluginPurgeUnsupportedError) {
    return c.json({ error: err.message }, 409, NO_CACHE)
  }
  if (err instanceof PluginPurgeNotActiveError) {
    return c.json({ error: err.message }, 409, NO_CACHE)
  }
  if (err instanceof PluginPurgeConfirmationError) {
    return c.json({ error: err.message }, 400, NO_CACHE)
  }
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500, NO_CACHE)
})

pluginsApp.get(
  '/api/plugins',
  describeRoute({
    description:
      'Returns the plugin settings catalog for the ACTIVE household (plugin architecture #437): every registered plugin with its capabilities and its three-layer effective-access posture (§3.3) — deployment availability (ops, 404), plan entitlement (403), household enablement (the owner toggle; routes 404 while off). Readable by every household member; only the enablement write is owner-only.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: pluginCatalogResponseSchema,
          },
        },
      },
      401: { description: 'Unauthorized' },
    },
  }),
  async (c) => {
    const plugins = await getPluginCatalog(c.env, c.get('householdId'))
    const res = c.json({ plugins } satisfies { plugins: PluginCatalogEntry[] })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

pluginsApp.put(
  '/api/plugins/:pluginId/enablement',
  describeRoute({
    description:
      "Sets one plugin's household enablement (owner-only; non-owners get 403). Writes the household_plugins row and a plugin_enabled / plugin_disabled lifecycle audit event in one batch. Setting the state the plugin already resolves to is an idempotent no-op (no row rewrite, no audit event). Returns the plugin's fresh posture.",
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['status'],
            additionalProperties: false,
            properties: {
              status: {
                type: 'string',
                enum: ['enabled', 'disabled'],
                description: 'The household enablement state to set',
              },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'OK — the new (or unchanged) posture',
        content: {
          'application/json': {
            schema: pluginCatalogEntrySchema,
          },
        },
      },
      400: { description: 'Invalid status' },
      401: { description: 'Unauthorized' },
      403: { description: 'Only household owners can do that' },
      404: { description: 'Household or plugin not found' },
    },
  }),
  sValidator('param', pluginParamsSchema),
  sValidator('json', enablementPatchSchema),
  async (c) => {
    const { pluginId } = c.req.valid('param')
    const { status } = c.req.valid('json')
    const plugin = await setPluginEnablement(c.env, {
      householdId: c.get('householdId'),
      userId: c.get('userId'),
      pluginId,
      status,
    })
    const res = c.json(plugin satisfies PluginCatalogEntry)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

pluginsApp.post(
  '/api/plugins/:pluginId/purge',
  describeRoute({
    description:
      "Requests a FULL purge of one plugin's data for the ACTIVE household (owner-only; non-owners get 403). REQUIRES the typed confirmation: body confirm must equal the plugin's name exactly — a checkbox is a misclick away, a typed string is the deliberate act (§3.4). Nothing is deleted by this request: it marks the drain 'pending' and records who confirmed; the nightly cron's chunk driver then deletes bytes-before-rows one chunk per invocation (a 200-document vault takes ~5 nightly ticks on the free plan — 50-subrequest cap, 40-object budget), refusing new uploads while the drain is in flight. Completion writes ONE plugin_purged lifecycle receipt in the core audit table (no household FK — the receipt outlives the household, plan §3.4). Idempotent while a drain is already pending/running.",
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['confirm'],
            additionalProperties: false,
            properties: {
              confirm: {
                type: 'string',
                description: "The typed confirmation — must equal the plugin's name exactly",
              },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "OK — the drain is marked pending (or was already in flight); the plugin's fresh posture comes back",
        content: {
          'application/json': {
            schema: pluginCatalogEntrySchema,
          },
        },
      },
      400: { description: 'Invalid body or confirmation does not match the plugin name' },
      401: { description: 'Unauthorized' },
      403: { description: 'Only household owners can do that' },
      404: { description: 'Household or plugin not found' },
      409: { description: 'The plugin does not declare the purge capability' },
    },
  }),
  sValidator('param', pluginParamsSchema),
  sValidator('json', purgeBodySchema),
  async (c) => {
    const { pluginId } = c.req.valid('param')
    const { confirm } = c.req.valid('json')
    const plugin = await requestPluginPurge(c.env, {
      householdId: c.get('householdId'),
      userId: c.get('userId'),
      pluginId,
      confirm,
    })
    const res = c.json(plugin satisfies PluginCatalogEntry)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

pluginsApp.delete(
  '/api/plugins/:pluginId/purge',
  describeRoute({
    description:
      "Cancels one plugin's in-flight purge for the ACTIVE household (owner-only; non-owners get 403) — the release lever for a drain that can never complete (a corrupted storage key makes every chunk fail forever, and the write gate would otherwise refuse uploads indefinitely). Returns the row to the never-requested resting state and clears every purge column; the write gate releases immediately. Nothing is deleted or restored by this call: documents the drain already finished are gone (their bytes went first), the rest are untouched. A 409 means no purge is in flight.",
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description:
          "OK — the drain was cancelled; the plugin's fresh posture comes back (purge null)",
        content: {
          'application/json': {
            schema: pluginCatalogEntrySchema,
          },
        },
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Only household owners can do that' },
      404: { description: 'Household or plugin not found' },
      409: { description: 'No purge is in flight (nothing to cancel)' },
    },
  }),
  sValidator('param', pluginParamsSchema),
  async (c) => {
    const { pluginId } = c.req.valid('param')
    const plugin = await cancelPluginPurge(c.env, {
      householdId: c.get('householdId'),
      userId: c.get('userId'),
      pluginId,
    })
    const res = c.json(plugin satisfies PluginCatalogEntry)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

export { pluginsApp }
