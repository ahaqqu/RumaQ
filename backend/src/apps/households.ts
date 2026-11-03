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
  literal,
  pipe,
  isoDate,
  trim,
  minLength,
  maxLength,
} from 'valibot'

import type { Env } from '../types.js'
import { createCors } from '../cors.js'
import { propsAuthMiddleware } from '../auth.js'
import { ipRateLimitMiddleware, isRateLimited } from '../lib/rate-limit.js'
import {
  HouseholdNotFoundError,
  HouseholdForbiddenError,
  LastOwnerError,
  InvalidInviteError,
  InvalidInviteTargetError,
  InviteTargetConflictError,
  requireMembership,
  requireOwner,
  listHouseholds,
  createHousehold,
  renameHousehold,
  listMembers,
  createProfileMember,
  updateMemberProfile,
  removeMember,
  leaveHousehold,
  setActiveHousehold,
  getActiveInvite,
  createInvite,
  joinByCode,
  type HouseholdSummary,
  type HouseholdMemberRow,
  type ActiveInvite,
} from '../lib/households.js'

const householdNameSchema = object({
  name: pipe(string(), minLength(1), maxLength(80)),
})

// Member profile patch (ahaqqu/RumaQ#331): the v1 member shape is minimal on
// purpose — display_name and birth_date exist so per-member features (an
// age-based chart in ahaqqu/BayiQ, a SEPARATE repo — never integrated here)
// can attach later without schema surgery. Empty string means "clear" (the
// client sends '' when the user empties the field) and is normalized to NULL.
// birth_date uses valibot's isoDate (review A6): a real calendar date, not
// just the YYYY-MM-DD shape — "2024-13-45" must not reach the column.
const MEMBER_PROFILE_CAPS = {
  displayName: 80,
} as const

const memberPatchSchema = strictObject({
  display_name: optional(
    union([pipe(string(), maxLength(MEMBER_PROFILE_CAPS.displayName)), vnull()])
  ),
  birth_date: optional(union([pipe(string(), isoDate()), literal(''), vnull()])),
})

// Profile-only member creation (ahaqqu/RumaQ#388): display_name IS the
// identity (required — no account exists to fall back on); birth_date stays
// optional. trim() runs BEFORE the length bounds so a whitespace-only name is
// a 400, not an unnamed roster row. No `role` field exists in the schema on
// purpose — the lib forces role='member' and the contract must not even
// suggest otherwise.
const memberCreateSchema = strictObject({
  display_name: pipe(string(), trim(), minLength(1), maxLength(MEMBER_PROFILE_CAPS.displayName)),
  birth_date: optional(union([pipe(string(), isoDate()), vnull()])),
})

const joinSchema = object({
  code: pipe(string(), minLength(1), maxLength(60)),
})

// Invite targeting (ahaqqu/RumaQ#397): the optional body marks the invite for
// one profile-only member; no field (or explicit null) = today's plain
// invite. strictObject like the member schemas; every field optional so a
// bodyless POST (today's clients, no Content-Type) still validates — Hono
// skips JSON parsing without a JSON Content-Type and validates {}. The id cap
// (64) matches documents.ts's memberId bound — it covers both id formats the
// member table stores (dashed UUID, 0021's 32-hex backfill).
const inviteCreateSchema = strictObject({
  target_member_id: optional(union([pipe(string(), minLength(1), maxLength(64)), vnull()])),
})

// Household summaries ride the shared member/Household shape; nullable fields
// use the additive-nullish pattern (`type: ['string','null']`) so older clients
// tolerate the fields and newer ones read them.
const householdSummarySchema: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  required: ['id', 'name', 'role', 'member_count', 'is_active'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', enum: ['owner', 'member'] },
    member_count: { type: 'integer' },
    is_active: { type: 'boolean' },
    created_at: { type: 'string' },
  },
}

const householdMemberSchema: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  required: ['id', 'user_id', 'role', 'joined_at', 'has_account'],
  properties: {
    // Surrogate member id (0021) — the addressable handle for both modes.
    id: { type: 'string' },
    // Additive-nullish for Mode B (#388): NULL = profile-only member with no
    // user account (never authenticates, owner-managed).
    user_id: { type: ['string', 'null'] },
    role: { type: 'string', enum: ['owner', 'member'] },
    // Additive-nullish profile fields (BayiQ-ready; see 0020 migration).
    display_name: { type: ['string', 'null'] },
    birth_date: { type: ['string', 'null'] },
    joined_at: { type: 'string' },
    name: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    picture: { type: ['string', 'null'] },
    // The two-mode discriminator: true when the member is linked to a user
    // account, false for profile-only members.
    has_account: { type: 'boolean' },
  },
}

const inviteSchema: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  required: ['id', 'code', 'created_at', 'expires_at', 'target_member_id', 'has_target'],
  properties: {
    id: { type: 'string' },
    code: { type: 'string' },
    created_at: { type: 'string' },
    expires_at: { type: 'string' },
    // Additive-nullish (ahaqqu/RumaQ#397): the profile-only member this
    // invite is marked for; null = plain invite (today's flow).
    target_member_id: { type: ['string', 'null'] },
    // The discriminator, computed from target_member_id so the two shapes
    // never drift (the roster's has_account pattern).
    has_target: { type: 'boolean' },
  },
}

// Invite-code redemption gets its own, much tighter limiter than the global
// per-IP window: the code space is only guessable at a rate this gate allows.
const JOIN_RATE_WINDOW_MS = 60_000
const JOIN_RATE_MAX = 10

const NO_CACHE = { 'Cache-Control': 'private, no-cache' }

export const householdsApp = new Hono<Env>()

householdsApp.use(logger())
householdsApp.use('*', createCors())
householdsApp.use('*', ipRateLimitMiddleware)

householdsApp.onError((err, c) => {
  if (err instanceof HouseholdNotFoundError) return c.json({ error: err.message }, 404)
  if (err instanceof HouseholdForbiddenError) return c.json({ error: err.message }, 403)
  if (err instanceof LastOwnerError) return c.json({ error: err.message }, 409)
  if (err instanceof InvalidInviteError) return c.json({ error: err.message }, 400)
  // Link-later (#397): the owner marked an invite for something that cannot
  // be attached later (400), or two redeemers raced for one target (409).
  if (err instanceof InvalidInviteTargetError) return c.json({ error: err.message }, 400)
  if (err instanceof InviteTargetConflictError) return c.json({ error: err.message }, 409)
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500, NO_CACHE)
})

// apiApp.use(path) does not cover subpaths (#292 landmine) — every path gets
// its own line here too, params after statics.
householdsApp.use('/api/households', propsAuthMiddleware)
householdsApp.use('/api/households/join', propsAuthMiddleware)
householdsApp.use('/api/households/:id', propsAuthMiddleware)
householdsApp.use('/api/households/:id/activate', propsAuthMiddleware)
householdsApp.use('/api/households/:id/leave', propsAuthMiddleware)
householdsApp.use('/api/households/:id/invite', propsAuthMiddleware)
householdsApp.use('/api/households/:id/members', propsAuthMiddleware)
householdsApp.use('/api/households/:id/members/:memberId', propsAuthMiddleware)

householdsApp.get(
  '/api/households',
  describeRoute({
    description: 'Lists the households the current user belongs to.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['households'],
              properties: { households: { type: 'array', items: householdSummarySchema } },
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
    },
  }),
  async (c) => {
    const households = await listHouseholds(c.env.DB, c.get('userId'))
    const res = c.json({ households })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

householdsApp.post(
  '/api/households',
  describeRoute({
    description:
      'Creates a household. The creator becomes its owner; the active household is unchanged.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
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
              required: ['household'],
              properties: { household: householdSummarySchema },
            },
          },
        },
      },
      400: { description: 'Validation error' },
      401: { description: 'Unauthorized' },
    },
  }),
  sValidator('json', householdNameSchema),
  async (c) => {
    const { name } = c.req.valid('json')
    const userId = c.get('userId')
    const householdId = await createHousehold(c.env.DB, userId, name)

    // Re-list so the response shape matches GET exactly (member_count
    // included) without duplicating the projection.
    const households = await listHouseholds(c.env.DB, userId)
    const household = households.find((h) => h.id === householdId) as HouseholdSummary
    const res = c.json({ household }, 201)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

householdsApp.post(
  '/api/households/join',
  describeRoute({
    description:
      'Joins a household by invite code. Unknown, revoked, and expired codes return the same error (no existence leak); joining a household you already belong to is idempotent. An invite marked for a profile-only member (target_member_id, ahaqqu/RumaQ#397) attaches the redeemer’s account to that existing member row — id, display name, birth date, and documents stay attached — instead of creating a new member.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['code'],
            properties: { code: { type: 'string', minLength: 1, maxLength: 60 } },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Joined (already_member=true when the membership already existed)',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['household', 'already_member'],
              properties: {
                household: {
                  type: 'object',
                  required: ['id', 'name'],
                  properties: { id: { type: 'string' }, name: { type: 'string' } },
                },
                already_member: { type: 'boolean' },
              },
            },
          },
        },
      },
      400: { description: 'Invalid or expired invite code' },
      401: { description: 'Unauthorized' },
      // A targeted invite whose member was linked by someone else meanwhile
      // (#397): a typed conflict, never the partial unique index as a 500.
      409: { description: 'The invite’s targeted member was already linked to another account' },
      429: { description: 'Too many join attempts' },
    },
  }),
  sValidator('json', joinSchema),
  async (c) => {
    const userId = c.get('userId')
    const { limited, retryAfter } = isRateLimited(
      `invite-join:${userId}`,
      JOIN_RATE_WINDOW_MS,
      JOIN_RATE_MAX
    )
    if (limited) {
      return c.json({ error: 'Too many attempts. Please slow down.' }, 429, {
        'Retry-After': String(retryAfter),
      })
    }
    const result = await joinByCode(c.env.DB, userId, c.req.valid('json').code)
    const res = c.json(result)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

householdsApp.patch(
  '/api/households/:id',
  describeRoute({
    description: 'Renames a household. Owner-only.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
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
              required: ['household'],
              properties: { household: householdSummarySchema },
            },
          },
        },
      },
      400: { description: 'Validation error' },
      401: { description: 'Unauthorized' },
      // 404 covers "no such household" and "not a member" identically.
      404: { description: 'Household not found' },
      403: { description: 'Only household owners can do that' },
    },
  }),
  sValidator('json', householdNameSchema),
  async (c) => {
    const userId = c.get('userId')
    const householdId = c.req.param('id')
    await renameHousehold(c.env.DB, householdId, userId, c.req.valid('json').name)
    const households = await listHouseholds(c.env.DB, userId)
    const household = households.find((h) => h.id === householdId)
    if (!household) {
      // listHouseholds only returns the caller's memberships, so a
      // non-member renamer lands here with the same 404 as a bad id.
      return c.json({ error: 'Household not found' }, 404)
    }
    const res = c.json({ household })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

householdsApp.post(
  '/api/households/:id/activate',
  describeRoute({
    description:
      'Sets the household as the current user’s active one. Only households the user belongs to qualify; inventory, plans, purchases, and history scope to it via the auth middleware.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['active_household_id'],
              properties: { active_household_id: { type: 'string' } },
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
      404: { description: 'Household not found' },
    },
  }),
  async (c) => {
    const userId = c.get('userId')
    const householdId = c.req.param('id')
    await setActiveHousehold(c.env.DB, userId, householdId)
    const res = c.json({ active_household_id: householdId })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

householdsApp.get(
  '/api/households/:id/members',
  describeRoute({
    description:
      'Lists the members of a household — both linked accounts (has_account=true) and profile-only members without an account (has_account=false, ahaqqu/RumaQ#388). Members and owners of that household only.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['members'],
              properties: { members: { type: 'array', items: householdMemberSchema } },
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
      404: { description: 'Household not found' },
    },
  }),
  async (c) => {
    const householdId = c.req.param('id')
    // Membership gate FIRST (review B2): every household route authorizes
    // before touching target data — the roster (names, emails, pictures) is
    // fetched only for members of the household.
    await requireMembership(c.env.DB, householdId, c.get('userId'))
    const members = await listMembers(c.env.DB, householdId)
    const res = c.json({ members: members satisfies HouseholdMemberRow[] })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

householdsApp.post(
  '/api/households/:id/members',
  describeRoute({
    description:
      'Creates a profile-only member — a person with no user account (e.g. a toddler), identified by display_name plus an optional birth_date. Owner-only; the role is always member and such members never authenticate. They count toward member_count.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['display_name'],
            additionalProperties: false,
            properties: {
              display_name: { type: 'string', minLength: 1, maxLength: 80 },
              birth_date: {
                type: ['string', 'null'],
                description: 'YYYY-MM-DD, or null when unknown',
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
              required: ['member'],
              properties: { member: householdMemberSchema },
            },
          },
        },
      },
      400: { description: 'Validation error' },
      401: { description: 'Unauthorized' },
      404: { description: 'Household not found' },
      403: { description: 'Only household owners can do that' },
    },
  }),
  sValidator('json', memberCreateSchema),
  async (c) => {
    // display_name arrives already trimmed by the schema (trim() runs before
    // the bounds, and the validated value is the transformed one).
    const body = c.req.valid('json')
    const member = await createProfileMember(c.env.DB, c.req.param('id'), c.get('userId'), {
      display_name: body.display_name,
      birth_date: body.birth_date ?? null,
    })
    const res = c.json({ member }, 201)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

householdsApp.patch(
  '/api/households/:id/members/:memberId',
  describeRoute({
    description:
      'Updates a member’s profile fields (display_name, birth_date), addressed by member id. Owners may edit anyone; a linked member may edit themselves. Profile-only members (has_account=false) are owner-only. Roles are not writable.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              display_name: { type: ['string', 'null'], maxLength: 80 },
              birth_date: {
                type: ['string', 'null'],
                description: 'YYYY-MM-DD, or null/empty to clear',
              },
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
              required: ['member'],
              properties: { member: householdMemberSchema },
            },
          },
        },
      },
      400: { description: 'Validation error' },
      401: { description: 'Unauthorized' },
      404: { description: 'Household not found' },
      403: { description: 'Only household owners can edit other members' },
    },
  }),
  sValidator('json', memberPatchSchema),
  async (c) => {
    const householdId = c.req.param('id')
    const memberId = c.req.param('memberId')
    const body = c.req.valid('json')

    const patch: { display_name?: string | null; birth_date?: string | null } = {}
    if (body.display_name !== undefined) {
      const trimmed = body.display_name?.trim() ?? null
      patch.display_name = trimmed === '' ? null : trimmed
    }
    if (body.birth_date !== undefined) {
      patch.birth_date = body.birth_date === '' || body.birth_date == null ? null : body.birth_date
    }

    // Existence + permission inside the lib; an unknown target member inside a
    // real household also surfaces as the caller's 404 (update returns null).
    const member = await updateMemberProfile(
      c.env.DB,
      householdId,
      c.get('userId'),
      memberId,
      patch
    )
    if (!member) {
      return c.json({ error: 'Member not found' }, 404)
    }
    const res = c.json({ member })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

householdsApp.delete(
  '/api/households/:id/members/:memberId',
  describeRoute({
    description:
      'Removes a member from a household, addressed by member id. Owner-only; the household must keep at least one owner (409 otherwise). Profile-only members are a simple delete; removing a linked member also repoints (or respawns) their session.',
    security: [{ cookieAuth: [] }],
    responses: {
      204: { description: 'Removed' },
      401: { description: 'Unauthorized' },
      404: { description: 'Household not found' },
      403: { description: 'Only household owners can do that' },
      409: { description: 'A household must keep at least one owner' },
    },
  }),
  async (c) => {
    await removeMember(c.env.DB, c.req.param('id'), c.get('userId'), c.req.param('memberId'))
    return c.newResponse(null, 204)
  }
)

householdsApp.post(
  '/api/households/:id/leave',
  describeRoute({
    description:
      'Leaves a household. The last owner cannot leave (409) until ownership is transferred. If the leaver has no households left, a fresh baseline one is created.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
      404: { description: 'Household not found' },
      409: { description: 'A household must keep at least one owner' },
    },
  }),
  async (c) => {
    await leaveHousehold(c.env.DB, c.req.param('id'), c.get('userId'))
    const res = c.json({ ok: true })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

householdsApp.get(
  '/api/households/:id/invite',
  describeRoute({
    description:
      'Returns the household’s current live invite code, or null when none is active. Owner-only.',
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['invite'],
              properties: {
                // Additive-nullish via anyOf (review B3): the object schema or
                // null, typed without casts.
                invite: {
                  anyOf: [inviteSchema, { type: 'null' }],
                } as OpenAPIV3_1.SchemaObject,
              },
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
      404: { description: 'Household not found' },
      403: { description: 'Only household owners can do that' },
    },
  }),
  async (c) => {
    const householdId = c.req.param('id')
    // Owner gate lives in the lib (review B1) — the typed 403 maps in onError.
    await requireOwner(c.env.DB, householdId, c.get('userId'))
    const invite = await getActiveInvite(c.env.DB, householdId, c.env.WORKER_ENCRYPTION_KEY)
    const res = c.json({ invite: (invite ?? null) satisfies ActiveInvite | null })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

householdsApp.post(
  '/api/households/:id/invite',
  describeRoute({
    description:
      'Generates a fresh invite code for the household, revoking any previous live code. Owner-only. Codes expire after 7 days. An optional target_member_id marks the invite for one profile-only member of the household (ahaqqu/RumaQ#397): redeeming it attaches the redeemer’s account to that member row instead of creating a new member.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              target_member_id: {
                type: ['string', 'null'],
                maxLength: 64,
                description:
                  'A profile-only member (has_account=false) of this household to mark the invite for; omit or null for a plain invite',
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
              required: ['invite'],
              properties: { invite: inviteSchema },
            },
          },
        },
      },
      400: { description: 'Invalid invite target' },
      401: { description: 'Unauthorized' },
      404: { description: 'Household not found' },
      403: { description: 'Only household owners can do that' },
    },
  }),
  sValidator('json', inviteCreateSchema),
  async (c) => {
    const householdId = c.req.param('id')
    await requireOwner(c.env.DB, householdId, c.get('userId'))
    const invite = await createInvite(
      c.env.DB,
      householdId,
      c.get('userId'),
      c.env.WORKER_ENCRYPTION_KEY,
      c.req.valid('json').target_member_id ?? null
    )
    const res = c.json({ invite }, 201)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)
