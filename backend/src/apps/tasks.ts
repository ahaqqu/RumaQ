// Household task routes (ahaqqu/RumaQ#429). Same stack as the households and
// documents apps: logger + CORS + per-IP limiter, propsAuthMiddleware on every
// path, and an onError mapping the lib's typed errors. Tasks scope to the
// caller's ACTIVE household (auth middleware) — there is no household id in
// the URL to forge, and every lookup carries the household predicate in its
// WHERE clause. Actors are the caller's LINKED member row; profile-only
// members (0021) never authenticate — kids get tasks assigned and completed
// on their behalf, never act themselves. All rules live in lib/tasks.ts.

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
  picklist,
  pipe,
  isoDate,
  trim,
  minLength,
  maxLength,
  safeParse,
} from 'valibot'

import type { Env } from '../types.js'
import { createCors } from '../cors.js'
import { propsAuthMiddleware } from '../auth.js'
import { ipRateLimitMiddleware } from '../lib/rate-limit.js'
import {
  TaskConflictError,
  TaskForbiddenError,
  TaskNotFoundError,
  TaskValidationError,
  approveTask,
  completeTask,
  createTask,
  deleteTask,
  getHouseholdMember,
  getTaskRow,
  listTasks,
  requireCallerMember,
  updateTask,
  type TaskEditPatch,
  type TaskRecurrence,
  type TaskSummary,
} from '../lib/tasks.js'

// Same free-text bound as the #422 document names (the schema CHECK in 0027
// is the backstop; the route owns trim + non-empty).
const TASK_TITLE_MAX = 120

// Valibot trims BEFORE the length bounds and the validated value IS the
// transformed one, so a whitespace-only title is a 400, not a blank row (the
// households memberCreateSchema discipline).
const taskCreateSchema = strictObject({
  title: pipe(string(), trim(), minLength(1), maxLength(TASK_TITLE_MAX)),
  assignee_member_id: optional(union([pipe(string(), minLength(1), maxLength(64)), vnull()])),
  due_date: optional(union([pipe(string(), isoDate()), vnull()])),
  recurrence: optional(union([picklist(['daily', 'weekly', 'monthly']), vnull()])),
})

// One PATCH endpoint, three actions (ahaqqu/RumaQ#429): edit fields, complete
// (status: 'done'), approve (approve: true). strictObject keeps unknown keys
// out; the handler additionally refuses MIXED actions — completing with edits
// in one call would make the completion's permission matrix ambiguous.
const taskPatchSchema = strictObject({
  title: optional(pipe(string(), trim(), minLength(1), maxLength(TASK_TITLE_MAX))),
  due_date: optional(union([pipe(string(), isoDate()), vnull()])),
  recurrence: optional(union([picklist(['daily', 'weekly', 'monthly']), vnull()])),
  assignee_member_id: optional(union([pipe(string(), minLength(1), maxLength(64)), vnull()])),
  status: optional(picklist(['done'])),
  approve: optional(literal(true)),
})

// assignee=me resolves to the caller's member row; assignee=all (or absent)
// is the whole board; any other value filters by that surrogate member id
// (both modes, 0021). mine=1 is the "My tasks" sugar and wins over assignee.
const taskListQuerySchema = object({
  assignee: optional(pipe(string(), maxLength(64))),
  status: optional(picklist(['open', 'done', 'all'])),
  mine: optional(picklist(['1'])),
})

const taskSummarySchema: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  required: [
    'id',
    'household_id',
    'title',
    'assignee_member_id',
    'created_by_member_id',
    'due_date',
    'recurrence',
    'status',
    'needs_approval',
    'approved_by_member_id',
    'created_at',
    'updated_at',
  ],
  properties: {
    id: { type: 'string' },
    household_id: { type: 'string' },
    // Free text — the preset category list is deliberately absent (#429, the
    // #422 document-name philosophy).
    title: { type: 'string' },
    // Nullable: unassigned tasks are allowed. Both member modes (linked /
    // profile-only, 0021) address here through the surrogate id.
    assignee_member_id: { type: ['string', 'null'] },
    // Nullable: a removed creator's tasks stay (ON DELETE SET NULL, 0027).
    created_by_member_id: { type: ['string', 'null'] },
    due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null' },
    recurrence: { type: ['string', 'null'], enum: ['daily', 'weekly', 'monthly', null] },
    status: { type: 'string', enum: ['open', 'done'] },
    // Derived: true while the assignee is a profile-only member (0027).
    needs_approval: { type: 'boolean' },
    approved_by_member_id: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
}

const JSON_ERROR_RESPONSES = {
  400: { description: 'Validation error' },
  401: { description: 'Unauthorized' },
  404: { description: 'Task not found' },
} as const

const NO_CACHE = { 'Cache-Control': 'private, no-cache' }

export const tasksApp = new Hono<Env>()

tasksApp.use(logger())
tasksApp.use('*', createCors())
tasksApp.use('*', ipRateLimitMiddleware)

tasksApp.onError((err, c) => {
  if (err instanceof TaskValidationError) return c.json({ error: err.message }, 400, NO_CACHE)
  if (err instanceof TaskNotFoundError) return c.json({ error: err.message }, 404, NO_CACHE)
  if (err instanceof TaskForbiddenError) return c.json({ error: err.message }, 403, NO_CACHE)
  if (err instanceof TaskConflictError) return c.json({ error: err.message }, 409, NO_CACHE)
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500, NO_CACHE)
})

// apiApp.use(path) does not cover subpaths (#292 landmine) — every path gets
// its own line here too, params after statics.
tasksApp.use('/api/tasks', propsAuthMiddleware)
tasksApp.use('/api/tasks/:id', propsAuthMiddleware)

tasksApp.get(
  '/api/tasks',
  describeRoute({
    description:
      'Lists the active household’s tasks — the shared board (open + done). Filters compose: assignee=me (the caller’s member row), assignee=all (or absent — everyone), or a surrogate member id (both modes; an unknown id filters to an empty list, it is a read filter not a probe); status=open|done|all (default all); mine=1 is the "My tasks" sugar for assignee=me and wins over assignee. No per-member read hiding: every household member sees the board (#429 design note).',
    security: [{ cookieAuth: [] }],
    parameters: [
      {
        in: 'query',
        name: 'assignee',
        required: false,
        schema: {
          type: 'string',
          description: "'me', 'all', or a surrogate member id (both modes)",
        },
      },
      {
        in: 'query',
        name: 'status',
        required: false,
        schema: { type: 'string', enum: ['open', 'done', 'all'], default: 'all' },
      },
      {
        in: 'query',
        name: 'mine',
        required: false,
        schema: { type: 'string', enum: ['1'], description: 'Sugar for assignee=me' },
      },
    ],
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['tasks'],
              properties: { tasks: { type: 'array', items: taskSummarySchema } },
            },
          },
        },
      },
      401: { description: 'Unauthorized' },
    },
  }),
  async (c) => {
    const raw = c.req.query()
    const parsed = safeParse(taskListQuerySchema, raw)
    if (!parsed.success) {
      throw new TaskValidationError('Invalid list filters')
    }

    let assigneeMemberId: string | undefined
    if (parsed.output.mine === '1' || parsed.output.assignee === 'me') {
      // 'me' needs the caller's member row — the same lookup mutations use.
      const caller = await requireCallerMember(c.env.DB, c.get('householdId'), c.get('userId'))
      assigneeMemberId = caller.memberId
    } else if (parsed.output.assignee !== undefined && parsed.output.assignee !== 'all') {
      assigneeMemberId = parsed.output.assignee
    }
    const status =
      parsed.output.status !== undefined && parsed.output.status !== 'all'
        ? parsed.output.status
        : undefined

    const tasks = await listTasks(c.env.DB, c.get('householdId'), { assigneeMemberId, status })
    const res = c.json({ tasks: tasks satisfies TaskSummary[] })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

tasksApp.post(
  '/api/tasks',
  describeRoute({
    description:
      'Creates a task: free-text title (trimmed, 1-120 chars — no preset categories, the #422 philosophy), optional assignee (ANY household member — linked or profile-only, 0021), optional due date and recurrence. Any linked member can create; profile-only members never act (no account, 0021). needs_approval derives server-side: true when the assignee is a profile-only member. The create audit record commits in the same batch.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['title'],
            additionalProperties: false,
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 120 },
              assignee_member_id: {
                type: ['string', 'null'],
                maxLength: 64,
                description: 'A member of this household (both modes); omit or null for unassigned',
              },
              due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
              recurrence: { type: ['string', 'null'], enum: ['daily', 'weekly', 'monthly', null] },
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
              required: ['task'],
              properties: { task: taskSummarySchema },
            },
          },
        },
      },
      ...JSON_ERROR_RESPONSES,
    },
  }),
  sValidator('json', taskCreateSchema),
  async (c) => {
    const householdId = c.get('householdId')
    const body = c.req.valid('json')

    // The assignee reference is validated BEFORE any write (the documents
    // resolveMemberId pattern): an unknown id is a body-validation 400, and a
    // valid id from ANOTHER household cannot be referenced.
    let assignee = null
    if (body.assignee_member_id) {
      assignee = await getHouseholdMember(c.env.DB, householdId, body.assignee_member_id)
      if (!assignee) {
        throw new TaskValidationError('Member not found in this household')
      }
    }

    const task = await createTask(c.env.DB, {
      householdId,
      userId: c.get('userId'),
      title: body.title,
      assignee,
      dueDate: body.due_date ?? null,
      recurrence: (body.recurrence ?? null) as TaskRecurrence | null,
    })
    const res = c.json({ task }, 201)
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

tasksApp.patch(
  '/api/tasks/:id',
  describeRoute({
    description:
      'One endpoint, three actions. (1) Edit fields — title, due_date, recurrence, assignee_member_id (assign/reassign, null unassigns): creator or household owner; reassignment re-derives needs_approval from the new assignee’s mode and clears any prior approval; an empty patch is a no-op read. (2) Complete — status:"done" alone: the assignee (when linked), the creator, or an owner; profile-only assignees are completed on their behalf; a one-shot task flips to done, a RECURRING task rolls its due date to the next occurrence and stays open. (3) Approve — approve:true alone: creator or owner, only while needs_approval and the task is done; sets approved_by_member_id. Every action writes its audit row in the same batch.',
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
              due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null to clear' },
              recurrence: { type: ['string', 'null'], enum: ['daily', 'weekly', 'monthly', null] },
              assignee_member_id: {
                type: ['string', 'null'],
                maxLength: 64,
                description: 'A member of this household (both modes); null unassigns',
              },
              status: { type: 'string', enum: ['done'], description: 'Complete — standalone' },
              approve: { type: 'boolean', description: 'Approve — standalone, must be true' },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'OK — the updated task comes back',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['task'],
              properties: { task: taskSummarySchema },
            },
          },
        },
      },
      ...JSON_ERROR_RESPONSES,
      403: {
        description: 'Only the creator/assignee/owner relationship allows that',
      },
      409: {
        description: 'The task’s state refuses the action (already done, not awaiting approval)',
      },
    },
  }),
  sValidator('json', taskPatchSchema),
  async (c) => {
    const householdId = c.get('householdId')
    const userId = c.get('userId')

    // Scoped lookup first (no existence leak); membership + permissions
    // re-derive INSIDE the lib from (householdId, userId) — the vault's
    // discipline, so no caller row can cross households.
    const task = await getTaskRow(c.env.DB, householdId, c.req.param('id'))
    if (!task) {
      throw new TaskNotFoundError()
    }
    const body = c.req.valid('json')

    // Approve is standalone (ahaqqu/RumaQ#429): mixing it with edits would
    // make which permission matrix governs the call ambiguous.
    if (body.approve === true) {
      if (
        body.status !== undefined ||
        body.title !== undefined ||
        body.due_date !== undefined ||
        body.recurrence !== undefined ||
        body.assignee_member_id !== undefined
      ) {
        throw new TaskValidationError('Approve is a standalone action')
      }
      const updated = await approveTask(c.env.DB, {
        householdId,
        userId,
        task,
      })
      const res = c.json({ task: updated })
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    }

    // Completion is standalone too — same ambiguity argument.
    if (body.status !== undefined) {
      if (
        body.title !== undefined ||
        body.due_date !== undefined ||
        body.recurrence !== undefined ||
        body.assignee_member_id !== undefined
      ) {
        throw new TaskValidationError('Completion is a standalone action')
      }
      // Server-authoritative completion day (UTC, the /api/home precedent) —
      // the recurrence roll-forward anchors on it.
      const completedOn = new Date().toISOString().slice(0, 10)
      const updated = await completeTask(c.env.DB, {
        householdId,
        userId,
        task,
        completedOn,
      })
      const res = c.json({ task: updated })
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    }

    // Edit flow. A re-submitted IDENTICAL assignee is a no-op — not a new
    // approval cycle; null unassigns.
    const patch: TaskEditPatch = {}
    if (body.title !== undefined) {
      patch.title = body.title
    }
    if (body.due_date !== undefined) {
      patch.due_date = body.due_date
    }
    if (body.recurrence !== undefined) {
      patch.recurrence = body.recurrence
    }
    if (body.assignee_member_id !== undefined) {
      const next = body.assignee_member_id
      if (next === null) {
        if (task.assignee_member_id !== null) {
          patch.assignee = null
        }
      } else {
        const member = await getHouseholdMember(c.env.DB, householdId, next)
        if (!member) {
          throw new TaskValidationError('Member not found in this household')
        }
        if (member.id !== task.assignee_member_id) {
          patch.assignee = member
        }
      }
    }

    const updated = await updateTask(c.env.DB, {
      householdId,
      userId,
      task,
      patch,
    })
    const res = c.json({ task: updated })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

tasksApp.delete(
  '/api/tasks/:id',
  describeRoute({
    description:
      'Hard-deletes a task: creator or household owner. The deletion audit record commits in the SAME batch as the delete and survives it (household_task_audit.task_id is a plain TEXT handle — no FK), so the household’s completion history outlives the row.',
    security: [{ cookieAuth: [] }],
    responses: {
      204: { description: 'Deleted' },
      401: { description: 'Unauthorized' },
      403: { description: 'Only the creator or a household owner can do that' },
      404: { description: 'Task not found' },
    },
  }),
  async (c) => {
    const householdId = c.get('householdId')
    const task = await getTaskRow(c.env.DB, householdId, c.req.param('id'))
    if (!task) {
      throw new TaskNotFoundError()
    }
    await deleteTask(c.env.DB, {
      householdId,
      userId: c.get('userId'),
      task,
    })
    return c.newResponse(null, 204)
  }
)
