// Document vault routes (ahaqqu/RumaQ#422 rework of the #388 MVP) — the
// documents PLUGIN's app (re-homed from apps/documents.ts by ticket 4,
// plugin architecture §4.3/§4.7). The re-home rewrote enough of the file
// that git's default 50% rename threshold misses the move — the pre-move
// history needs
// `git log --follow --find-renames=30% -- backend/src/plugins/documents/app.ts`.
// Construction is a FACTORY, not a
// module-level singleton: createDocumentsPlugin(deps) receives the plugin's
// ports (the registry builds the storage adapter from the DOCUMENTS binding
// wiring and injects it — plugin code reads no binding except env.DB), so
// "cannot register a route without auth" stays structural and the adapter
// injection has exactly one place. Same stack as the households app: logger
// + CORS + per-IP limiter, propsAuthMiddleware on every path, and an onError
// mapping the lib's typed errors. Documents scope to the caller's ACTIVE
// household (auth middleware) — there is no household id in the URL to
// forge, and every lookup carries the household predicate in its WHERE
// clause. One document holds N files (#422): create takes the name + first
// file, later files ride POST /:id/files.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { logger } from 'hono/logger'
import { describeRoute } from 'hono-openapi'
import type { OpenAPIV3_1 } from 'openapi-types'
import {
  integer,
  maxLength,
  maxValue,
  minValue,
  nullable,
  number,
  object,
  optional,
  picklist,
  pipe,
  regex,
  safeParse,
  string,
  transform,
} from 'valibot'

import type { Env } from '../../types.js'
import { createCors } from '../../cors.js'
import { propsAuthMiddleware } from '../../auth.js'
import { ipRateLimitMiddleware, isRateLimited } from '../../lib/rate-limit.js'
import { pluginGate } from '../gate.js'
import type { PluginDeps, PluginRegistration } from '../types.js'
import { documentsManifest } from './manifest.js'
import { createDocumentsPurgeJob } from './purge.js'
import { createDocumentsExportJob } from './export.js'
import { registerExpiryOcrRoutes } from './ocr.js'
import {
  REMIND_DAYS_MAX,
  REMIND_DAYS_MIN,
  isValidExpiryDate,
  resolveExpiryUpdate,
} from '../../lib/document-expiry.js'
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MAX_FILES,
  DocumentForbiddenError,
  DocumentNotFoundError,
  DocumentPurgeActiveError,
  DocumentTooLargeError,
  DocumentTooManyFilesError,
  DocumentUnsupportedTypeError,
  DocumentValidationError,
  addDocumentFile,
  contentDisposition,
  createDocument,
  deleteDocument,
  deleteDocumentFile,
  ensureVaultKey,
  getDocumentFileRow,
  getDocumentRow,
  getDocumentWithFiles,
  isHouseholdMember,
  listDocuments,
  recordDocumentAccess,
  sanitizeDocumentLabel,
  sanitizeDocumentName,
  sanitizeFileName,
  sniffDocumentMime,
  updateDocumentExpiry,
  type DocumentSummary,
} from './lib.js'
import { resolvePluginPurgeActive } from '../enablement.js'

const NO_CACHE = { 'Cache-Control': 'private, no-cache' }
// Byte bodies are session-scoped secrets: the browser must not memoize them
// anywhere (docs/ARCHITECTURE.md §10 — no public object URLs, ever).
const NO_STORE = { 'Cache-Control': 'private, no-store' }

const listQuerySchema = object({
  q: optional(pipe(string(), maxLength(120))),
  memberId: optional(pipe(string(), maxLength(64))),
  // #426: expiring_within=N days (1..365, same bounds as the remind window).
  // Query params arrive as strings — the regex rejects non-digits/overlong
  // forms before the transform, the range checks after.
  expiring_within: optional(
    pipe(
      string(),
      regex(/^\d{1,3}$/),
      transform(Number),
      minValue(REMIND_DAYS_MIN),
      maxValue(REMIND_DAYS_MAX)
    )
  ),
})

const dispositionQuerySchema = object({
  disposition: optional(picklist(['inline', 'attachment'])),
})

// The #426 expiry PATCH body: both fields optional (at least one required —
// checked in the handler), JSON. expires_on: null CLEARS the expiry (and its
// window with it); remind_days_before is a plain 1..365 integer — there is
// no "null window" (clearing happens through the expiry itself), so the
// stored invariant expires_on non-null ⇒ window non-null survives every
// accepted request.
const patchBodySchema = object({
  expires_on: optional(nullable(string())),
  remind_days_before: optional(
    pipe(number(), integer(), minValue(REMIND_DAYS_MIN), maxValue(REMIND_DAYS_MAX))
  ),
})

// Upload rate limit: tighter than the global per-IP window — 10 MB bodies
// make uploads the endpoint abuse would ride. A maxed-out document (owner
// cap: 20 files) is 20 requests in one burst, so the window holds a full
// document plus headroom for one more operation.
const UPLOAD_RATE_WINDOW_MS = 60_000
const UPLOAD_RATE_MAX = 40

// Transport slack for the pre-parse cap (review A1): multipart framing adds
// boundary + field headers on top of the file bytes (~hundreds of bytes at
// this scale). The pre-check measures the whole body, so a legitimate
// exactly-10 MB file needs this headroom to reach the exact post-parse cap.
export const UPLOAD_TRANSPORT_SLACK = 64 * 1024

// The OpenAPI shape for one file — metadata only (r2_key is an internal R2
// handle the client must not learn). label is the OPTIONAL free-text name
// ("Front", "Page 3") — null when unnamed (owner decision #422-1).
const documentFileSchema: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  required: [
    'id',
    'file_name',
    'content_type',
    'size_bytes',
    'sort_order',
    'sha256',
    'uploaded_by',
    'uploaded_at',
  ],
  properties: {
    id: { type: 'string' },
    file_name: { type: 'string' },
    content_type: { type: 'string' },
    size_bytes: { type: 'integer' },
    label: { type: ['string', 'null'] },
    sort_order: { type: 'integer' },
    sha256: { type: 'string' },
    uploaded_by: { type: 'string' },
    uploaded_at: { type: 'string' },
  },
}

// The OpenAPI shape for one document — metadata + its files in upload order.
const documentSummarySchema: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  required: [
    'id',
    'household_id',
    'member_id',
    'name',
    'uploaded_by',
    'created_at',
    'expires_on',
    'remind_days_before',
    'days_until_expiry',
    'files',
  ],
  properties: {
    id: { type: 'string' },
    household_id: { type: 'string' },
    // Nullable: household-level documents (kartu keluarga) have no single
    // person; both member modes (linked / profile-only, 0021) address here.
    member_id: { type: ['string', 'null'] },
    // Free text — the preset category list is gone (#422).
    name: { type: 'string' },
    uploaded_by: { type: 'string' },
    created_at: { type: 'string' },
    // Expiry metadata (#426): the stored ISO date + window, and the COMPUTED
    // whole-day distance (negative = already expired) — never stored twice.
    expires_on: { type: ['string', 'null'] },
    remind_days_before: { type: ['integer', 'null'] },
    days_until_expiry: { type: ['integer', 'null'] },
    files: { type: 'array', items: documentFileSchema },
  },
}

const JSON_ERROR_RESPONSES = {
  400: { description: 'Validation error' },
  401: { description: 'Unauthorized' },
  404: { description: 'Document not found' },
} as const

// Auth + the plugin enablement gate (ahaqqu/RumaQ#435, plugin architecture
// §4.3) install in ONE pass over the same pattern list, so the pairing is
// structural: a new vault pattern cannot acquire auth without the gate, and
// registration order puts auth first on every pattern (the household is
// unknown until propsAuthMiddleware has resolved it, so the gate must always
// see it). Disabled / deployment-off answers 404 fail-closed. Phase A: every
// household resolves enabled (manifest default, no rows exist), so behavior
// is bit-for-bit identical except the one planned indexed read per request
// (§3.6).
const VAULT_PROTECTED_PATTERNS = [
  '/api/documents',
  '/api/documents/:id',
  '/api/documents/:id/files',
  '/api/documents/:id/files/:fileId',
  '/api/documents/:id/files/:fileId/content',
  '/api/documents/:id/files/:fileId/extract-expiry',
] as const

// Stateless middleware — one gate instance serves every pattern.
const documentsGate = pluginGate('documents')

// One parsed upload — the file plus the string multipart fields, already
// bounded by the pre-parse cap. Both POST routes funnel through here so the
// cap/parse dance (A1/A2) exists exactly once.
type ParsedUpload = {
  file: { name: string; data: ArrayBuffer; type: string }
  fields: Record<string, string>
}

async function parseUpload(c: Context<Env>): Promise<ParsedUpload> {
  const contentType = c.req.header('Content-Type') || ''
  if (!contentType.includes('multipart/form-data')) {
    throw new DocumentValidationError('Expected multipart/form-data')
  }

  // Pre-parse cap (A1): the Content-Length covers the WHOLE multipart body —
  // boundary + field headers ride on top of the file bytes — so the declared
  // size gets a fixed transport slack. The EXACT cap fires on the parsed
  // file bytes below; this line only rejects obviously-oversized bodies
  // before the first byte is read.
  const contentLengthHeader = c.req.header('Content-Length')
  const contentLength = Number(contentLengthHeader ?? '')
  if (
    contentLengthHeader !== undefined &&
    Number.isFinite(contentLength) &&
    contentLength > DOCUMENT_MAX_BYTES + UPLOAD_TRANSPORT_SLACK
  ) {
    throw new DocumentTooLargeError()
  }

  try {
    let formData: Record<string, FormDataEntryValue | File>
    if (contentLengthHeader === undefined && c.req.raw.body) {
      // Chunked upload (A2): no Content-Length means parseBody() would
      // buffer the entire body before the post-parse cap could fire. Read
      // the stream here instead and ABORT the moment the buffered bytes
      // pass the cap — the transient buffer is bounded by
      // DOCUMENT_MAX_BYTES + UPLOAD_TRANSPORT_SLACK, not by the platform's
      // request limit. The multipart headers carry over when the capped
      // bytes are re-wrapped into a Request for parsing.
      const reader = c.req.raw.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > DOCUMENT_MAX_BYTES + UPLOAD_TRANSPORT_SLACK) {
          await reader.cancel()
          throw new DocumentTooLargeError()
        }
        chunks.push(value)
      }
      const cappedRequest = new Request(c.req.raw.url, {
        method: 'POST',
        headers: c.req.raw.headers,
        // The stream hands back ArrayBufferLike-backed views; BlobPart only
        // admits ArrayBuffer-backed ones — a type-level assertion, no copy.
        body: new Blob(chunks as unknown as BlobPart[]),
      })
      // Request.formData() yields a FormData instance; the branch below
      // reads entries by key, so flatten it into the same plain shape
      // Hono's parseBody() produces.
      formData = Object.fromEntries(await cappedRequest.formData())
    } else {
      // Framed upload: HTTP/1.1 Content-Length IS the transport bound, so
      // the parse buffer is already capped by the pre-check above.
      formData = await c.req.parseBody()
    }
    const uploaded = formData['file']
    if (!uploaded || typeof uploaded === 'string' || !('arrayBuffer' in uploaded)) {
      throw new DocumentValidationError('No file provided. Use field name "file".')
    }
    const fields: Record<string, string> = {}
    for (const [key, value] of Object.entries(formData)) {
      if (key !== 'file' && typeof value === 'string') fields[key] = value
    }
    return {
      file: {
        name: uploaded.name,
        data: await uploaded.arrayBuffer(),
        type: uploaded.type,
      },
      fields,
    }
  } catch (err) {
    if (err instanceof DocumentTooLargeError || err instanceof DocumentValidationError) {
      throw err
    }
    throw new DocumentValidationError('Failed to parse upload')
  }
}

// The EXACT per-file checks both POST routes share: parsed cap, empty file,
// basename sanitization, sniff-pinned bytes. Returns the validated pieces the
// lib mutations take.
function validateFileBytes(file: { name: string; data: ArrayBuffer; type: string }): {
  bytes: Uint8Array<ArrayBuffer>
  mime: string
  fileName: string
} {
  const bytes = new Uint8Array(file.data)
  if (bytes.byteLength > DOCUMENT_MAX_BYTES) {
    throw new DocumentTooLargeError()
  }
  if (bytes.byteLength === 0) {
    throw new DocumentValidationError('Empty file')
  }
  const fileName = sanitizeFileName(file.name)
  if (!fileName) {
    throw new DocumentValidationError('Invalid file name')
  }
  // The declared mime must be on the allowlist AND agree with the magic
  // bytes (sniff policy: reject on mismatch — pinned in the #388 PR).
  const sniffed = sniffDocumentMime(bytes)
  if (!sniffed || sniffed !== file.type) {
    throw new DocumentUnsupportedTypeError()
  }
  return { bytes, mime: sniffed, fileName }
}

// The member relation accepts BOTH modes (linked / profile-only, 0021) —
// both address through the surrogate member id. An id from another household
// is a body-validation failure, not a resource probe (400). Empty string is
// "no member" (the household itself).
async function resolveMemberId(
  db: Context<Env>['env']['DB'],
  householdId: string,
  memberId: string | undefined
): Promise<string | null> {
  if (memberId === undefined || memberId === '') return null
  const known = await isHouseholdMember(db, householdId, memberId)
  if (!known) {
    throw new DocumentValidationError('Member not found in this household')
  }
  return memberId
}

// Rate-limits both upload endpoints (they carry 10 MB bodies).
function enforceUploadRate(userId: string): { limited: boolean; retryAfter: number } {
  return isRateLimited(`doc-upload:${userId}`, UPLOAD_RATE_WINDOW_MS, UPLOAD_RATE_MAX)
}

// The purge write-gate (ticket 5, #439): refuse uploads while a vault purge
// is pending/running (409). One PK-prefix seek per upload — uploads are
// already multipart-heavy, and the gate is what stops a document from
// landing in the drain's final-read race window. The resolver fails CLOSED
// (blocks writes on a read error): a refused upload retries; an upload that
// slips into an unverified drain window is data loss.
async function enforcePurgeWriteGate(db: Context<Env>['env']['DB'], householdId: string) {
  if (await resolvePluginPurgeActive(db, householdId, 'documents')) {
    throw new DocumentPurgeActiveError()
  }
}

/**
 * The documents plugin factory (the #435 contract, ticket 4 #438): the
 * registry builds ports.storage from the DOCUMENTS binding wiring and
 * injects it here — plugin code reads no binding except env.DB (§4.1
 * forbidden-4; the five inline storage call
 * sites this factory removes were the motivating evidence). A missing port
 * is a wiring mistake, not a request state — fail at construction.
 *
 * Middleware semantics are the module-level app's, unchanged: logger → CORS
 * → per-IP limiter, onError mapping the lib's typed errors, and the
 * VAULT_PROTECTED_PATTERNS loop installing propsAuthMiddleware + the plugin
 * gate on every pattern — auth before gate before handler (the 401/404 tests
 * in plugin-gate.test.ts prove the depth).
 */
export function createDocumentsPlugin(deps: PluginDeps): PluginRegistration {
  const storage = deps.ports.storage
  if (!storage) {
    throw new Error('documents plugin requires ports.storage — registry wiring is missing it')
  }

  const documentsApp = new Hono<Env>()

  documentsApp.use(logger())
  documentsApp.use('*', createCors())
  documentsApp.use('*', ipRateLimitMiddleware)

  documentsApp.onError((err, c) => {
    if (err instanceof DocumentValidationError) return c.json({ error: err.message }, 400)
    if (err instanceof DocumentTooLargeError) return c.json({ error: err.message }, 413)
    if (err instanceof DocumentUnsupportedTypeError) return c.json({ error: err.message }, 415)
    if (err instanceof DocumentTooManyFilesError) {
      return c.json({ error: err.message }, 409, NO_CACHE)
    }
    if (err instanceof DocumentPurgeActiveError) {
      return c.json({ error: err.message }, 409, NO_CACHE)
    }
    if (err instanceof DocumentNotFoundError) return c.json({ error: err.message }, 404, NO_CACHE)
    if (err instanceof DocumentForbiddenError) return c.json({ error: err.message }, 403, NO_CACHE)
    console.error(err)
    return c.json({ error: 'Internal server error' }, 500, NO_CACHE)
  })

  // apiApp.use(path) does not cover subpaths (#292 landmine) — every pattern
  // gets its own registration, for auth AND the gate alike.
  for (const pattern of VAULT_PROTECTED_PATTERNS) {
    documentsApp.use(pattern, propsAuthMiddleware)
    documentsApp.use(pattern, documentsGate)
  }

  documentsApp.get(
    '/api/documents',
    describeRoute({
      description:
        'Lists the active household’s documents, newest first, each with its files in upload order. Optional filters: q (case-insensitive contains-search on the free-text document name — the #422 replacement for the category filter), memberId (both member modes — linked accounts and profile-only members), expiring_within (#426: N days, 1-365 — documents whose expiry lands within the next N days, already-expired included; orders those results soonest-expiry-first). Every item carries expires_on, remind_days_before and the COMPUTED days_until_expiry (whole days from the household calendar, pinned at UTC+7/WIB — the Indonesia-first audience; negative = expired) — never stored.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          in: 'query',
          name: 'q',
          required: false,
          schema: { type: 'string', description: 'Name search: case-insensitive substring' },
        },
        {
          in: 'query',
          name: 'memberId',
          required: false,
          schema: { type: 'string', description: 'Surrogate member id (both modes)' },
        },
        {
          in: 'query',
          name: 'expiring_within',
          required: false,
          schema: {
            type: 'integer',
            minimum: 1,
            maximum: 365,
            description: 'Days ahead: documents expiring within N days (expired included)',
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
                required: ['documents'],
                properties: { documents: { type: 'array', items: documentSummarySchema } },
              },
            },
          },
        },
        401: { description: 'Unauthorized' },
      },
    }),
    async (c) => {
      const raw = c.req.query()
      const parsed = safeParse(listQuerySchema, raw)
      if (!parsed.success) {
        throw new DocumentValidationError('Invalid list filters')
      }
      const documents = await listDocuments(c.env.DB, c.get('householdId'), {
        q: parsed.output.q,
        memberId: parsed.output.memberId,
        expiringWithin: parsed.output.expiring_within,
      })
      const res = c.json({ documents: documents satisfies DocumentSummary[] })
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    }
  )

  documentsApp.post(
    '/api/documents',
    describeRoute({
      description:
        'Creates a document (multipart/form-data: name, file, optional label for that file, optional memberId). The name is free text — trimmed, 1-120 chars, no preset list (#422). The file becomes attachment #1 (sort_order 1); more files ride POST /documents/{id}/files, max 20 per document. Cap 10 MB enforced on Content-Length before the body is read and again on the parsed bytes; magic bytes must match the declared type (JPEG, PNG, WebP, PDF). memberId accepts both member modes (linked and profile-only). No public URLs exist — bytes are served only via the per-file content endpoint.',
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['file', 'name'],
              properties: {
                name: { type: 'string' },
                file: { type: 'string', format: 'binary' },
                label: { type: 'string' },
                memberId: { type: 'string' },
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
                required: ['document'],
                properties: { document: documentSummarySchema },
              },
            },
          },
        },
        ...JSON_ERROR_RESPONSES,
        409: { description: 'A purge drain is in flight for this vault — uploads are paused' },
        413: { description: 'File exceeds the 10 MB cap' },
        415: { description: 'Unsupported or mismatched file type' },
        429: { description: 'Too many uploads' },
      },
    }),
    async (c) => {
      const userId = c.get('userId')
      const householdId = c.get('householdId')

      const { limited, retryAfter } = enforceUploadRate(userId)
      if (limited) {
        return c.json({ error: 'Too many uploads. Please slow down.' }, 429, {
          'Retry-After': String(retryAfter),
        })
      }

      // The purge write-gate runs BEFORE the body is read: a drain in
      // flight refuses uploads before the client pays for a 10 MB POST.
      await enforcePurgeWriteGate(c.env.DB, householdId)

      const upload = await parseUpload(c)

      const name = sanitizeDocumentName(upload.fields['name'] ?? '')
      if (!name) {
        throw new DocumentValidationError('Give the document a name (1-120 characters).')
      }
      const label = sanitizeDocumentLabel(upload.fields['label'])
      const memberId = await resolveMemberId(c.env.DB, householdId, upload.fields['memberId'])

      const { bytes, mime, fileName } = validateFileBytes(upload.file)

      const document = await createDocument(c.env.DB, storage, {
        householdId,
        memberId,
        name,
        file: { fileName, bytes, mime, label },
        uploadedBy: userId,
      })

      const res = c.json({ document }, 201)
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    }
  )

  documentsApp.get(
    '/api/documents/:id',
    describeRoute({
      description:
        'Returns one document’s metadata with its files in upload order. A document from another household answers the same 404 as a missing one (no existence leak).',
      security: [{ cookieAuth: [] }],
      responses: {
        200: {
          description: 'OK',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['document'],
                properties: { document: documentSummarySchema },
              },
            },
          },
        },
        ...JSON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const document = await getDocumentWithFiles(c.env.DB, c.get('householdId'), c.req.param('id'))
      if (!document) {
        throw new DocumentNotFoundError()
      }
      const res = c.json({ document })
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    }
  )

  documentsApp.patch(
    '/api/documents/:id',
    describeRoute({
      description:
        'Updates a document’s expiry metadata (#426): expires_on (ISO YYYY-MM-DD, or null to clear — clearing the expiry also clears the reminder window) and/or remind_days_before (integer days, 1-365). At least one field is required. Setting an expiry without a window applies the existing window, or the 30-day default when none was set; a window on a document without an expiry is a 400 (nothing to remind about). Expiry is metadata on the free-text document — the #422 naming and multi-file model are untouched. Every change writes an ‘update’ audit record in the same batch. Household-scoped like every vault route (a foreign household’s id answers 404, no existence leak); any household member may edit, matching the add-files authorization — the metadata is household-level information.',
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                expires_on: {
                  type: ['string', 'null'],
                  description: 'ISO YYYY-MM-DD expiry date; null clears it (and the window)',
                },
                remind_days_before: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 365,
                  description: 'Days before expiry the document enters the due-soon window',
                },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'OK — the updated document comes back',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['document'],
                properties: { document: documentSummarySchema },
              },
            },
          },
        },
        ...JSON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const householdId = c.get('householdId')
      // Scoped lookup first — the household predicate rides in the SQL, so a
      // foreign household's id is 404 before any body is read (no leak).
      const document = await getDocumentRow(c.env.DB, householdId, c.req.param('id'))
      if (!document) {
        throw new DocumentNotFoundError()
      }

      let raw: unknown
      try {
        raw = await c.req.json()
      } catch {
        throw new DocumentValidationError('Expected a JSON body')
      }
      const parsed = safeParse(patchBodySchema, raw)
      if (!parsed.success) {
        throw new DocumentValidationError(
          'Invalid expiry fields: expires_on must be an ISO date or null; remind_days_before an integer 1-365'
        )
      }
      const { expires_on, remind_days_before } = parsed.output
      if (expires_on === undefined && remind_days_before === undefined) {
        throw new DocumentValidationError(
          'Nothing to update: pass expires_on and/or remind_days_before'
        )
      }
      // The regex in the lib pins the SHAPE; this pins the CALENDAR (2026-02-31
      // is a well-formed non-date).
      if (expires_on !== undefined && expires_on !== null && !isValidExpiryDate(expires_on)) {
        throw new DocumentValidationError('expires_on must be a real calendar date (YYYY-MM-DD)')
      }
      if (expires_on === null && remind_days_before !== undefined) {
        throw new DocumentValidationError(
          'Clearing expires_on also clears the reminder window — omit remind_days_before'
        )
      }
      // Window-only PATCH on an expiry-less document: there is nothing to
      // remind about, so it is a 400 rather than a silently-dangling window.
      if (expires_on === undefined && document.expires_on === null) {
        throw new DocumentValidationError('Set expires_on before setting remind_days_before')
      }

      const resolved = resolveExpiryUpdate(document, {
        expiresOn: expires_on,
        remindDaysBefore: remind_days_before,
      })
      const updated = await updateDocumentExpiry(c.env.DB, {
        householdId,
        documentId: document.id,
        actorUserId: c.get('userId'),
        expiresOn: resolved.expiresOn,
        remindDaysBefore: resolved.remindDaysBefore,
      })
      const res = c.json({ document: updated })
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    }
  )

  documentsApp.post(
    '/api/documents/:id/files',
    describeRoute({
      description:
        'Adds one file to an existing document (multipart/form-data: file, optional label). Max 20 files per document — a full document refuses another file with 409 before the body is read. Same 10 MB cap (Content-Length pre-check + parsed bytes) and magic-byte policy as create; the file lands at sort_order = max + 1 (upload order). Returns the updated document with all files. No public URLs exist — bytes are served only via the per-file content endpoint.',
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['file'],
              properties: {
                file: { type: 'string', format: 'binary' },
                label: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        201: {
          description: 'File added — the updated document comes back',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['document'],
                properties: { document: documentSummarySchema },
              },
            },
          },
        },
        ...JSON_ERROR_RESPONSES,
        409: {
          description:
            'The document already holds the maximum of 20 files, or a purge drain is in flight for this vault (uploads paused)',
        },
        413: { description: 'File exceeds the 10 MB cap' },
        415: { description: 'Unsupported or mismatched file type' },
        429: { description: 'Too many uploads' },
      },
    }),
    async (c) => {
      const userId = c.get('userId')
      const householdId = c.get('householdId')

      const { limited, retryAfter } = enforceUploadRate(userId)
      if (limited) {
        return c.json({ error: 'Too many uploads. Please slow down.' }, 429, {
          'Retry-After': String(retryAfter),
        })
      }

      // The purge write-gate, same as create: before the body is read.
      await enforcePurgeWriteGate(c.env.DB, householdId)

      // Scoped lookup first (no existence leak), cap check inside the lib
      // BEFORE any byte touches storage.
      const document = await getDocumentRow(c.env.DB, householdId, c.req.param('id'))
      if (!document) {
        throw new DocumentNotFoundError()
      }

      const upload = await parseUpload(c)
      const label = sanitizeDocumentLabel(upload.fields['label'])
      const { bytes, mime, fileName } = validateFileBytes(upload.file)

      const updated = await addDocumentFile(c.env.DB, storage, {
        householdId,
        documentId: document.id,
        file: { fileName, bytes, mime, label },
        uploadedBy: userId,
      })

      const res = c.json({ document: updated }, 201)
      res.headers.set('Cache-Control', 'private, no-cache')
      return res
    }
  )

  // Binary content endpoint, PER FILE since #422. Described here for the API
  // docs (binary response, the contract's codegen handles format:'binary'
  // fine) — the browser client calls it with a hand-written fetch because the
  // typed client's JSON unwrap has no blob path; recorded as a flagged choice
  // in the #388 PR.
  documentsApp.get(
    '/api/documents/:id/files/:fileId/content',
    describeRoute({
      description:
        'Streams one file’s bytes, authenticated and household-scoped (the file must belong to the document, the document to the household). Content-Type is the stored mime; disposition=inline previews (audited as view), disposition=attachment downloads (audited as download). Cache-Control is private, no-store — bytes never leak through any cache, and no public or presigned URL exists.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'disposition',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['inline', 'attachment'], default: 'inline' },
        },
      ],
      responses: {
        200: {
          description: 'Byte stream',
          content: {
            'application/pdf': { schema: { type: 'string', format: 'binary' } },
            'image/jpeg': { schema: { type: 'string', format: 'binary' } },
            'image/png': { schema: { type: 'string', format: 'binary' } },
            'image/webp': { schema: { type: 'string', format: 'binary' } },
          },
        },
        ...JSON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const raw = c.req.query()
      const parsed = safeParse(dispositionQuerySchema, raw)
      if (!parsed.success) {
        throw new DocumentValidationError('Invalid disposition')
      }
      const disposition = parsed.output.disposition ?? 'inline'

      // The scoped lookups answer 404 for a foreign household's id BEFORE any
      // other decision (no existence leak) — document first, then its file.
      const document = await getDocumentRow(c.env.DB, c.get('householdId'), c.req.param('id'))
      if (!document) {
        throw new DocumentNotFoundError()
      }
      const file = await getDocumentFileRow(
        c.env.DB,
        c.get('householdId'),
        document.id,
        c.req.param('fileId')
      )
      if (!file) {
        throw new DocumentNotFoundError()
      }

      // Vault-key guard (review B1): a corrupted r2_key must never be fed to
      // the adapter — reading it could serve a sibling namespace's object.
      ensureVaultKey(file.r2_key)

      const stored = await storage.get(file.r2_key)
      if (!stored) {
        // Row without bytes (a failed delete batch mid-crash, say) is a dead
        // file — never a server error leak.
        throw new DocumentNotFoundError()
      }

      await recordDocumentAccess(c.env.DB, {
        documentId: document.id,
        fileId: file.id,
        householdId: document.household_id,
        actorUserId: c.get('userId'),
        action: disposition === 'attachment' ? 'download' : 'view',
      })

      return new Response(stored.stream, {
        headers: {
          'Content-Type': file.content_type,
          'Content-Disposition': contentDisposition(disposition, file.file_name),
          ...NO_STORE,
          // Defense-in-depth (review A3): the stored mime is sniff-pinned at
          // upload; this header stops the browser from second-guessing it.
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }
  )

  // Expiry-date OCR (ahaqqu/RumaQ#433) lives in ./ocr.ts — the vault app file
  // stays under the 1k review bar and the OCR route's HTTP mapping is one
  // module. Auth + the plugin gate for its path are installed by the
  // VAULT_PROTECTED_PATTERNS loop above (the canonical wiring point), BEFORE
  // this registration. The route reads bytes through the injected storage
  // port, exactly like every other vault byte path.
  registerExpiryOcrRoutes(documentsApp, storage)

  documentsApp.delete(
    '/api/documents/:id/files/:fileId',
    describeRoute({
      description:
        'Removes ONE file from a document: the stored object AND its row, with the file_delete audit record in the same batch. Allowed for the household owner, the document’s uploader, or the file’s uploader. The last file may be deleted — the document survives with zero files until someone deletes it. Audit rows outlive the file they name.',
      security: [{ cookieAuth: [] }],
      responses: {
        204: { description: 'Deleted' },
        401: { description: 'Unauthorized' },
        403: {
          description:
            'Only the household owner, the document uploader, or the file uploader can do that',
        },
        404: { description: 'Document or file not found' },
      },
    }),
    async (c) => {
      const householdId = c.get('householdId')
      const document = await getDocumentRow(c.env.DB, householdId, c.req.param('id'))
      if (!document) {
        throw new DocumentNotFoundError()
      }
      const file = await getDocumentFileRow(
        c.env.DB,
        householdId,
        document.id,
        c.req.param('fileId')
      )
      if (!file) {
        throw new DocumentNotFoundError()
      }
      await deleteDocumentFile(c.env.DB, storage, {
        householdId,
        userId: c.get('userId'),
        document,
        file,
      })
      return c.newResponse(null, 204)
    }
  )

  documentsApp.delete(
    '/api/documents/:id',
    describeRoute({
      description:
        'Hard-deletes a document: every file’s stored object AND the metadata rows, with the deletion audit record in the same batch (the file rows cascade). Uploader or household owner only. Audit rows outlive the document (the deletion record survives).',
      security: [{ cookieAuth: [] }],
      responses: {
        204: { description: 'Deleted' },
        401: { description: 'Unauthorized' },
        403: { description: 'Only the uploader or a household owner can do that' },
        404: { description: 'Document not found' },
      },
    }),
    async (c) => {
      const document = await getDocumentRow(c.env.DB, c.get('householdId'), c.req.param('id'))
      if (!document) {
        throw new DocumentNotFoundError()
      }
      await deleteDocument(c.env.DB, storage, {
        householdId: c.get('householdId'),
        userId: c.get('userId'),
        document,
      })
      return c.newResponse(null, 204)
    }
  )

  return {
    manifest: documentsManifest,
    app: documentsApp,
    // The purge job (ticket 5, #439) rides the registration, closing over
    // the SAME injected port the routes use — the core cron tick and the
    // household-dissolution drain call it through PluginPurgeJob, never
    // through plugin internals. Bytes go through the port, never inline R2.
    // The budget floor is the job's per-chunk minimum (a chunk deletes
    // whole documents; one may hold DOCUMENT_MAX_FILES files) — the driver
    // stops on `remaining < floor` instead of manufacturing a chunk the
    // job must refuse (P1-A2, PR #474 review).
    purge: createDocumentsPurgeJob(storage),
    purgeBudgetFloor: DOCUMENT_MAX_FILES,
    // The export job (ticket 6, #440) rides the registration the same way:
    // the owner-only catalog route dispatches through PluginExportJob —
    // core owns the authz and the file budget, the plugin owns the archive
    // (its index, its port). Read-only by design; no gating with the purge.
    export: createDocumentsExportJob(storage),
  }
}
