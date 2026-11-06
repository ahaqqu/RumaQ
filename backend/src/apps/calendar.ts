// Household calendar routes (ahaqqu/RumaQ#430). Same stack as the households,
// documents and tasks apps: logger + CORS + per-IP limiter, propsAuthMiddleware
// on every path, and an onError mapping the lib's typed errors. The calendar
// scopes to the caller's ACTIVE household (auth middleware) — there is no
// household id in the URL to forge, and every lookup carries the household
// predicate in its WHERE clause, plus the per-member visibility predicate on
// top (lib/calendar.ts header: 'members' events are visible to their listed
// members and their creator only). Actors are the caller's LINKED member row;
// profile-only members (0021) never authenticate — they appear as event
// AUDIENCES (and via the birthday quick-add), never as callers. All rules live
// in lib/calendar.ts; the deadline entries of the view are derived on read
// from the documents table (#426) — no calendar-side write path exists for
// them.

import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { describeRoute } from 'hono-openapi'
import type { OpenAPIV3_1 } from 'openapi-types'
import { sValidator } from '@hono/standard-validator'
import {
  object,
  strictObject,
  string,
  optional,
  union,
  null as vnull,
  picklist,
  pipe,
  isoDate,
  check,
  trim,
  minLength,
  maxLength,
  array,
  safeParse,
} from 'valibot'

import type { Env } from '../types.js'
import { createCors } from '../cors.js'
import { propsAuthMiddleware } from '../auth.js'
import { ipRateLimitMiddleware } from '../lib/rate-limit.js'
import { isValidExpiryDate } from '../lib/document-expiry.js'
import {
  CalendarForbiddenError,
  CalendarNotFoundError,
  CalendarValidationError,
  createEvent,
  deleteEvent,
  findHouseholdMembers,
  getEventForActor,
  isValidEventTime,
  listCalendarEntries,
  requireCallerMember,
  updateEvent,
  type EventEditPatch,
  type EventSummary,
} from '../lib/calendar.js'

// Same free-text bound as the #422 document names and the 0027 task titles
// (the schema CHECK in 0031 is the backstop; the route owns trim + non-empty).
const EVENT_TITLE_MAX = 120

// Audience lists are household-scale; the cap is a sanity bound on the
// payload, not a product rule (a household roster cannot reasonably exceed it).
const EVENT_MEMBERS_MAX = 100

// Valibot trims BEFORE the length bounds and the validated value IS the
// transformed one, so a whitespace-only title is a 400, not a blank row. date
// goes beyond isoDate's shape check with the documents domain's real-calendar
// validator (thermos A5; the tasks domain imports the same function): isoDate
// alone accepts 2026-02-31. time is a strict 24h 'HH:MM' — the 0031 storage
// shape.
const eventDate = pipe(string(), isoDate(), check(isValidExpiryDate))
const eventTime = pipe(string(), check(isValidEventTime))

const eventCreateSchema = strictObject({
  title: pipe(string(), trim(), minLength(1), maxLength(EVENT_TITLE_MAX)),
  date: eventDate,
  time: optional(union([eventTime, vnull()])),
  visibility: optional(picklist(['all', 'members'])),
  member_ids: optional(
    pipe(array(pipe(string(), trim(), minLength(1), maxLength(64))), maxLength(EVENT_MEMBERS_MAX))
  ),
})

const eventPatchSchema = strictObject({
  title: optional(pipe(string(), trim(), minLength(1), maxLength(EVENT_TITLE_MAX))),
  date: optional(eventDate),
  time: optional(union([eventTime, vnull()])),
  visibility: optional(picklist(['all', 'members'])),
  member_ids: optional(
    pipe(array(pipe(string(), trim(), minLength(1), maxLength(64))), maxLength(EVENT_MEMBERS_MAX))
  ),
})

// The window bounds — real calendar dates so a malformed range is a 400, not
// a silently empty month. A reversed range is rejected too: the frontend
// always sends [first, last], and from > to is a caller bug worth surfacing.
const calendarListQuerySchema = object({
  from: optional(eventDate),
  to: optional(eventDate),
})

const eventSummarySchema: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  required: [
    'kind',
    'id',
    'household_id',
    'title',
    'date',
    'time',
    'visibility',
    'member_ids',
    'created_by_member_id',
    'created_at',
    'updated_at',
  ],
  properties: {
    kind: { type: 'string', enum: ['event'] },
    id: { type: 'string' },
    household_id: { type: 'string' },
    // Free text — no preset category list (the #422/#429 philosophy).
    title: { type: 'string' },
    date: { type: 'string', description: 'YYYY-MM-DD' },
    // Nullable: an all-day event has no time.
    time: { type: ['string', 'null'], description: 'HH:MM (24h), or null' },
    visibility: { type: 'string', enum: ['all', 'members'] },
    // null = whole household; an array = the listed members (both member
    // modes, 0021) plus the creator implicitly.
    member_ids: {
      type: ['array', 'null'],
      items: { type: 'string' },
      description: 'The audience when visibility=members; null when visibility=all',
    },
    // Nullable: a removed creator's events stay (ON DELETE SET NULL, 0031).
    created_by_member_id: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
}

const deadlineEntrySchema: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  required: [
    'kind',
    'id',
    'document_id',
    'title',
    'date',
    'member_id',
    'days_until_expiry',
    'due_soon',
  ],
  properties: {
    kind: { type: 'string', enum: ['deadline'] },
    // `doc:`-namespaced document id — a stored event's UUID can never collide.
    id: { type: 'string' },
    document_id: { type: 'string' },
    title: { type: 'string', description: 'The document’s free-text name (#422)' },
    date: { type: 'string', description: 'The document’s expires_on (YYYY-MM-DD)' },
    member_id: { type: ['string', 'null'] },
    days_until_expiry: { type: 'integer', description: 'Whole days; negative = expired' },
    due_soon: { type: 'boolean', description: 'Within the document’s own remind window (#426)' },
  },
}

const JSON_ERROR_RESPONSES = {
  400: { description: 'Validation error' },
  401: { description: 'Unauthorized' },
  404: { description: 'Event not found (unknown id, another household’s, or not visible to you)' },
} as const

const NO_CACHE = { 'Cache-Control': 'private, no-cache' }

export const calendarApp = new Hono<Env>()

calendarApp.use(logger())
calendarApp.use('*', createCors())
calendarApp.use('*', ipRateLimitMiddleware)

calendarApp.onError((err, c) => {
  if (err instanceof CalendarValidationError) return c.json({ error: err.message }, 400, NO_CACHE)
  if (err instanceof CalendarNotFoundError) return c.json({ error: err.message }, 404, NO_CACHE)
  if (err instanceof CalendarForbiddenError) return c.json({ error: err.message }, 403, NO_CACHE)
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500, NO_CACHE)
})

// apiApp.use(path) does not cover subpaths (#292 landmine) — every path gets
// its own line here too, params after statics.
calendarApp.use('/api/calendar', propsAuthMiddleware)
calendarApp.use('/api/calendar/events', propsAuthMiddleware)
calendarApp.use('/api/calendar/events/:id', propsAuthMiddleware)

calendarApp.get(
  '/api/calendar',
  describeRoute({
    description:
      'The shared household calendar — ONE union of two entry kinds. kind=event: stored events (0031) inside the optional from/to window that the caller may READ — visibility=all is household-wide, visibility=members only to the listed members plus the creator. kind=deadline: DERIVED on read from the household’s documents (expires_on set, #426) — KTP/STNK/SIM/paspor renewals surface automatically; never stored, so an expires_on edit reflects on the next read. The window filters both kinds; remind_days_before (#426) drives each deadline’s due_soon flag, not the window itself (far-future renewals stay plannable on their month). Entries come back day-chronological (date, all-day first, time, title).',
    security: [{ cookieAuth: [] }],
    parameters: [
      {
        in: 'query',
        name: 'from',
        required: false,
        schema: {
          type: 'string',
          description: 'Window start (YYYY-MM-DD, inclusive); absent = unbounded',
        },
      },
      {
        in: 'query',
        name: 'to',
        required: false,
        schema: {
          type: 'string',
          description: 'Window end (YYYY-MM-DD, inclusive); absent = unbounded',
        },
      },
    ],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['entries'],
              properties: {
                entries: {
                  type: 'array',
                  items: {
                    oneOf: [eventSummarySchema, deadlineEntrySchema],
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
    const parsed = safeParse(calendarListQuerySchema, c.req.query())
    if (!parsed.success) {
      throw new CalendarValidationError('Invalid calendar window')
    }
    const { from, to } = parsed.output
    if (from && to && from > to) {
      throw new CalendarValidationError('from must not be after to')
    }
    const caller = await requireCallerMember(c.env.DB, c.get('householdId'), c.get('userId'))
    const entries = await listCalendarEntries(c.env.DB, c.get('householdId'), caller.memberId, {
      from,
      to,
    })
    const res = c.json({ entries })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

calendarApp.post(
  '/api/calendar/events',
  describeRoute({
    description:
      'Creates a calendar event: free-text title (trimmed, 1-120 chars — no preset categories, the #422 philosophy), a real calendar date (2026-02-31 is a 400), optional 24h HH:MM time (null/absent = all-day), and visibility: all (default) or members with a non-empty member_ids audience (any household member — linked or profile-only, 0021; ids are validated against this household, duplicates deduped). The creator is implicitly a reader and manager of the event. The create audit record commits in the same batch.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['title', 'date'],
            additionalProperties: false,
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 120 },
              date: { type: 'string', description: 'YYYY-MM-DD' },
              time: {
                type: ['string', 'null'],
                description: 'HH:MM (24h); omit or null for all-day',
              },
              visibility: { type: 'string', enum: ['all', 'members'] },
              member_ids: {
                type: 'array',
                items: { type: 'string', maxLength: 64 },
                description: 'Required non-empty when visibility=members; forbidden otherwise',
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
              required: ['event'],
              properties: { event: eventSummarySchema },
            },
          },
        },
      },
      ...JSON_ERROR_RESPONSES,
    },
  }),
  sValidator('json', eventCreateSchema),
  async (c) => {
    const householdId = c.get('householdId')
    const body = c.req.valid('json')
    const visibility = body.visibility ?? 'all'
    const memberIds = resolveAudience(visibility, body.member_ids)

    // The audience references are validated BEFORE any write (the documents
    // resolveMemberId pattern): an unknown id is a body-validation 400, and a
    // valid id from ANOTHER household cannot be referenced. Duplicates are
    // deduped (the audience table's PK is (event_id, member_id)).
    const resolved = await resolveMemberIds(c.env.DB, householdId, memberIds)

    const event = await createEvent(c.env.DB, {
      householdId,
      userId: c.get('userId'),
      title: body.title,
      date: body.date,
      time: body.time ?? null,
      visibility,
      memberIds: resolved,
    })
    const res = c.json({ event }, 201)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

calendarApp.patch(
  '/api/calendar/events/:id',
  describeRoute({
    description:
      'Edits an event: title, date, time (null clears it — all-day), visibility, and member_ids (the audience, replaced atomically). Creator or household owner; a caller who cannot SEE the event (restricted visibility, foreign household) answers the same 404 as a missing one — the scoped lookup runs before any body read. Cross-field rules: member_ids requires the resulting visibility to be members (sending it while the event resolves to all is a 400), and a members event must keep a non-empty audience — the creator is implicitly included, but at least one listed member is required. Every edit writes its audit row in the same batch.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 120 },
              date: { type: 'string', description: 'YYYY-MM-DD' },
              time: { type: ['string', 'null'], description: 'HH:MM (24h); null clears (all-day)' },
              visibility: { type: 'string', enum: ['all', 'members'] },
              member_ids: {
                type: 'array',
                items: { type: 'string', maxLength: 64 },
                description: 'The replacement audience; requires resulting visibility=members',
              },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'OK — the updated event comes back',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['event'],
              properties: { event: eventSummarySchema },
            },
          },
        },
      },
      ...JSON_ERROR_RESPONSES,
      403: {
        description: 'Only the creator or a household owner can do that',
      },
    },
  }),
  sValidator('json', eventPatchSchema),
  async (c) => {
    const householdId = c.get('householdId')
    const userId = c.get('userId')

    // The actor row first (the visibility predicate needs the surrogate member
    // id), then the scoped lookup — a foreign/restricted/missing id are all
    // the same 404, answered before the body is read (no existence leak).
    const caller = await requireCallerMember(c.env.DB, householdId, userId)
    const current = await getEventForActor(
      c.env.DB,
      householdId,
      caller.memberId,
      c.req.param('id')
    )
    if (!current) {
      throw new CalendarNotFoundError()
    }
    const body = c.req.valid('json')

    // Cross-field rules against the RESULTING state (current + patch). The
    // route owns them because they compare the body against the current row:
    //  - member_ids demands a resulting 'members' visibility (ambiguous
    //    otherwise — strict 400 beats silent-ignore),
    //  - an explicit audience replacement must be non-empty,
    //  - a flip (or re-affirmation) to 'members' WITHOUT a new list needs the
    //    current audience to be non-empty — a depleted 'members' event (every
    //    listed row cascaded away from member removal) may still be edited in
    //    other fields, but it cannot be re-affirmed as-is.
    const resultingVisibility = body.visibility ?? current.event.visibility
    let memberIds: string[] | undefined
    if (body.member_ids !== undefined) {
      if (resultingVisibility === 'all') {
        throw new CalendarValidationError('member_ids requires visibility "members"')
      }
      if (body.member_ids.length === 0) {
        throw new CalendarValidationError('A members event needs at least one member')
      }
      memberIds = await resolveMemberIds(c.env.DB, householdId, dedupe(body.member_ids))
    } else if (body.visibility === 'members' && (current.memberIds ?? []).length === 0) {
      throw new CalendarValidationError('A members event needs at least one member')
    }

    const patch: EventEditPatch = {}
    if (body.title !== undefined) patch.title = body.title
    if (body.date !== undefined) patch.date = body.date
    if (body.time !== undefined) patch.time = body.time
    if (body.visibility !== undefined) patch.visibility = body.visibility
    if (memberIds !== undefined) patch.memberIds = memberIds

    const event = await updateEvent(c.env.DB, {
      householdId,
      userId,
      event: current.event,
      memberIds: current.memberIds,
      patch,
    })
    const res = c.json({ event })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

calendarApp.delete(
  '/api/calendar/events/:id',
  describeRoute({
    description:
      'Hard-deletes an event: creator or household owner; a caller who cannot see it answers 404 (the scoped lookup runs first). The deletion audit record commits in the SAME batch as the delete and survives it (household_calendar_event_audit.event_id is a plain TEXT handle — no FK), so the household’s event history outlives the row. The audience rows cascade with the event (0031).',
    security: [{ cookieAuth: [] }],
    responses: {
      204: { description: 'Deleted' },
      401: { description: 'Unauthorized' },
      403: { description: 'Only the creator or a household owner can do that' },
      404: {
        description: 'Event not found (unknown id, another household’s, or not visible to you)',
      },
    },
  }),
  async (c) => {
    const householdId = c.get('householdId')
    const userId = c.get('userId')
    const caller = await requireCallerMember(c.env.DB, householdId, userId)
    const current = await getEventForActor(
      c.env.DB,
      householdId,
      caller.memberId,
      c.req.param('id')
    )
    if (!current) {
      throw new CalendarNotFoundError()
    }
    await deleteEvent(c.env.DB, {
      householdId,
      userId,
      event: current.event,
    })
    return c.newResponse(null, 204)
  }
)

// ---------------------------------------------------------------------------
// Body-reading helpers (the route owns cross-field validation against the
// request; the lib owns the rules against stored state)
// ---------------------------------------------------------------------------

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)]
}

// The visibility/audience cross-field rule for CREATE: member_ids only means
// something under visibility=members — sending it with the default 'all' is
// ambiguous, so it is a 400 (strict beats silent-ignore); visibility=members
// without an audience is equally invalid.
function resolveAudience(visibility: 'all' | 'members', memberIds: string[] | undefined): string[] {
  if (visibility === 'members') {
    if (!memberIds || memberIds.length === 0) {
      throw new CalendarValidationError('A members event needs at least one member')
    }
    return dedupe(memberIds)
  }
  if (memberIds !== undefined) {
    throw new CalendarValidationError('member_ids requires visibility "members"')
  }
  return []
}

// Every referenced id must be a member of THIS household — both modes (0021).
// The unknown case is a body-reference problem (400), not an addressable
// resource probe (the documents resolveMemberId pattern); the 400 names the
// first missing id so a bad payload is diagnosable without a roster dump.
// One chunked IN pass resolves the whole list (lib findHouseholdMembers) —
// the per-id round-trip loop is gone.
async function resolveMemberIds(
  db: Env['Bindings']['DB'],
  householdId: string,
  ids: string[]
): Promise<string[]> {
  const known = await findHouseholdMembers(db, householdId, ids)
  const missing = ids.find((id) => !known.has(id))
  if (missing) {
    throw new CalendarValidationError(`Member not found in this household: ${missing}`)
  }
  return ids
}

// The EventSummary type is re-exported for the tests' shape assertions.
export type { EventSummary }
