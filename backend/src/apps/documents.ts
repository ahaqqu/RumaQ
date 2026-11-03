// Document vault routes (ahaqqu/RumaQ#388 MVP). Same stack as the households
// app: logger + CORS + per-IP limiter, propsAuthMiddleware on every path, and
// an onError mapping the lib's typed errors. Documents scope to the caller's
// ACTIVE household (auth middleware) — there is no household id in the URL to
// forge, and every lookup carries the household predicate in its WHERE clause.

import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { describeRoute } from 'hono-openapi'
import type { OpenAPIV3_1 } from 'openapi-types'
import { object, picklist, string, optional, pipe, maxLength, safeParse } from 'valibot'

import type { Env } from '../types.js'
import { createCors } from '../cors.js'
import { propsAuthMiddleware } from '../auth.js'
import { ipRateLimitMiddleware, isRateLimited } from '../lib/rate-limit.js'
import { createR2StorageAdapter } from '../lib/storage.js'
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_MAX_BYTES,
  DocumentForbiddenError,
  DocumentNotFoundError,
  DocumentTooLargeError,
  DocumentUnsupportedTypeError,
  DocumentValidationError,
  contentDisposition,
  createDocument,
  ensureVaultKey,
  deleteDocument,
  getDocumentRow,
  isHouseholdMember,
  listDocuments,
  recordDocumentAccess,
  sanitizeFileName,
  sniffDocumentMime,
  type DocumentCategory,
  type DocumentSummary,
} from '../lib/documents.js'

const NO_CACHE = { 'Cache-Control': 'private, no-cache' }
// Byte bodies are session-scoped secrets: the browser must not memoize them
// anywhere (docs/ARCHITECTURE.md §10 — no public object URLs, ever).
const NO_STORE = { 'Cache-Control': 'private, no-store' }

const listQuerySchema = object({
  category: optional(picklist(DOCUMENT_CATEGORIES)),
  memberId: optional(pipe(string(), maxLength(64))),
})

const dispositionQuerySchema = object({
  disposition: optional(picklist(['inline', 'attachment'])),
})

// Upload rate limit: tighter than the global per-IP window — 10 MB bodies
// make uploads the endpoint abuse would ride.
const UPLOAD_RATE_WINDOW_MS = 60_000
const UPLOAD_RATE_MAX = 20

// Transport slack for the pre-parse cap (review A1): multipart framing adds
// boundary + field headers on top of the file bytes (~hundreds of bytes at
// this scale). The pre-check measures the whole body, so a legitimate
// exactly-10 MB file needs this headroom to reach the exact post-parse cap.
export const UPLOAD_TRANSPORT_SLACK = 64 * 1024

// The OpenAPI shape for one document — metadata only (storage_key is an
// internal R2 handle the client must not learn).
const documentSummarySchema: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  required: [
    'id',
    'household_id',
    'member_id',
    'category',
    'file_name',
    'mime_type',
    'size_bytes',
    'sha256',
    'uploaded_by',
    'created_at',
  ],
  properties: {
    id: { type: 'string' },
    household_id: { type: 'string' },
    // Nullable: household-level documents (kartu keluarga) have no single
    // person; both member modes (linked / profile-only, 0021) address here.
    member_id: { type: ['string', 'null'] },
    category: { type: 'string', enum: [...DOCUMENT_CATEGORIES] },
    file_name: { type: 'string' },
    mime_type: { type: 'string' },
    size_bytes: { type: 'integer' },
    sha256: { type: 'string' },
    uploaded_by: { type: 'string' },
    created_at: { type: 'string' },
  },
}

const JSON_ERROR_RESPONSES = {
  400: { description: 'Validation error' },
  401: { description: 'Unauthorized' },
  404: { description: 'Document not found' },
} as const

export const documentsApp = new Hono<Env>()

documentsApp.use(logger())
documentsApp.use('*', createCors())
documentsApp.use('*', ipRateLimitMiddleware)

documentsApp.onError((err, c) => {
  if (err instanceof DocumentValidationError) return c.json({ error: err.message }, 400)
  if (err instanceof DocumentTooLargeError) return c.json({ error: err.message }, 413)
  if (err instanceof DocumentUnsupportedTypeError) return c.json({ error: err.message }, 415)
  if (err instanceof DocumentNotFoundError) return c.json({ error: err.message }, 404, NO_CACHE)
  if (err instanceof DocumentForbiddenError) return c.json({ error: err.message }, 403, NO_CACHE)
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500, NO_CACHE)
})

// apiApp.use(path) does not cover subpaths (#292 landmine) — every path gets
// its own line here too.
documentsApp.use('/api/documents', propsAuthMiddleware)
documentsApp.use('/api/documents/:id', propsAuthMiddleware)
documentsApp.use('/api/documents/:id/content', propsAuthMiddleware)

documentsApp.get(
  '/api/documents',
  describeRoute({
    description:
      'Lists the active household’s documents, newest first. Optional filters: memberId (both member modes — linked accounts and profile-only members), category.',
    security: [{ cookieAuth: [] }],
    parameters: [
      {
        in: 'query',
        name: 'memberId',
        required: false,
        schema: { type: 'string', description: 'Surrogate member id (both modes)' },
      },
      {
        in: 'query',
        name: 'category',
        required: false,
        schema: { type: 'string', enum: [...DOCUMENT_CATEGORIES] },
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
      memberId: parsed.output.memberId,
      category: parsed.output.category,
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
      'Uploads one document (multipart/form-data: file, category, optional memberId) into the active household’s vault. Cap 10 MB enforced on Content-Length before the body is read and again on the parsed bytes; magic bytes must match the declared type (JPEG, PNG, WebP, PDF). memberId accepts both member modes (linked and profile-only). No public URLs exist — bytes are served only via the content endpoint.',
    security: [{ cookieAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            required: ['file', 'category'],
            properties: {
              file: { type: 'string', format: 'binary' },
              category: { type: 'string', enum: [...DOCUMENT_CATEGORIES] },
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
      413: { description: 'File exceeds the 10 MB cap' },
      415: { description: 'Unsupported or mismatched file type' },
      429: { description: 'Too many uploads' },
    },
  }),
  async (c) => {
    const userId = c.get('userId')
    const householdId = c.get('householdId')

    const { limited, retryAfter } = isRateLimited(
      `doc-upload:${userId}`,
      UPLOAD_RATE_WINDOW_MS,
      UPLOAD_RATE_MAX
    )
    if (limited) {
      return c.json({ error: 'Too many uploads. Please slow down.' }, 429, {
        'Retry-After': String(retryAfter),
      })
    }

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

    let file: { name: string; data: ArrayBuffer; type: string } | undefined
    let category: string | undefined
    let memberId: string | undefined
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
      if (uploaded && typeof uploaded !== 'string' && 'arrayBuffer' in uploaded) {
        file = {
          name: uploaded.name,
          data: await uploaded.arrayBuffer(),
          type: uploaded.type,
        }
      }
      if (typeof formData['category'] === 'string') category = formData['category']
      if (typeof formData['memberId'] === 'string') memberId = formData['memberId']
    } catch (err) {
      if (err instanceof DocumentTooLargeError) {
        throw err
      }
      throw new DocumentValidationError('Failed to parse upload')
    }

    if (!file) {
      throw new DocumentValidationError('No file provided. Use field name "file".')
    }

    // The EXACT cap fires here, on the parsed file bytes — the authoritative
    // check every transport (framed, chunked, lying headers) funnels into.
    const bytes = new Uint8Array(file.data)
    if (bytes.byteLength > DOCUMENT_MAX_BYTES) {
      throw new DocumentTooLargeError()
    }
    if (bytes.byteLength === 0) {
      throw new DocumentValidationError('Empty file')
    }

    if (!(DOCUMENT_CATEGORIES as readonly string[]).includes(category ?? '')) {
      throw new DocumentValidationError('Invalid category')
    }

    const fileName = sanitizeFileName(file.name)
    if (!fileName) {
      throw new DocumentValidationError('Invalid file name')
    }

    // The declared mime must be on the allowlist AND agree with the magic
    // bytes (sniff policy: reject on mismatch — pinned in the PR).
    const sniffed = sniffDocumentMime(bytes)
    if (!sniffed || sniffed !== file.type) {
      throw new DocumentUnsupportedTypeError()
    }

    // The member relation accepts BOTH modes (linked / profile-only, 0021) —
    // both address through the surrogate member id. An id from another
    // household is a body-validation failure, not a resource probe (400).
    if (memberId !== undefined && memberId !== '') {
      const known = await isHouseholdMember(c.env.DB, householdId, memberId)
      if (!known) {
        throw new DocumentValidationError('Member not found in this household')
      }
    } else {
      memberId = undefined
    }

    const document = await createDocument(c.env.DB, createR2StorageAdapter(c.env.DOCUMENTS), {
      householdId,
      memberId: memberId ?? null,
      category: (category ?? 'lainnya') as DocumentCategory,
      fileName,
      bytes,
      mime: sniffed,
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
      'Returns one document’s metadata. A document from another household answers the same 404 as a missing one (no existence leak).',
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
    const document = await getDocumentRow(c.env.DB, c.get('householdId'), c.req.param('id'))
    if (!document) {
      throw new DocumentNotFoundError()
    }
    const res = c.json({ document })
    res.headers.set('Cache-Control', 'private, no-cache')
    return res
  }
)

// Binary content endpoint. Described here for the API docs (binary response,
// the contract's codegen handles format:'binary' fine) — the browser client
// calls it with a hand-written fetch because the typed client's JSON unwrap
// has no blob path; recorded as a flagged choice in the PR.
documentsApp.get(
  '/api/documents/:id/content',
  describeRoute({
    description:
      'Streams the document’s bytes, authenticated and household-scoped. Content-Type is the stored mime; disposition=inline previews (audited as view), disposition=attachment downloads (audited as download). Cache-Control is private, no-store — bytes never leak through any cache, and no public or presigned URL exists.',
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

    // The scoped lookup answers 404 for a foreign household's id BEFORE any
    // other decision (no existence leak).
    const document = await getDocumentRow(c.env.DB, c.get('householdId'), c.req.param('id'))
    if (!document) {
      throw new DocumentNotFoundError()
    }

    // Vault-key guard (review B1): a corrupted storage_key must never be fed
    // to the adapter — reading it could serve a sibling namespace's object.
    ensureVaultKey(document.storage_key)

    const stored = await createR2StorageAdapter(c.env.DOCUMENTS).get(document.storage_key)
    if (!stored) {
      // Row without bytes (a failed delete batch mid-crash, say) is a dead
      // document — never a server error leak.
      throw new DocumentNotFoundError()
    }

    await recordDocumentAccess(c.env.DB, {
      documentId: document.id,
      householdId: document.household_id,
      actorUserId: c.get('userId'),
      action: disposition === 'attachment' ? 'download' : 'view',
    })

    return new Response(stored.stream, {
      headers: {
        'Content-Type': document.mime_type,
        'Content-Disposition': contentDisposition(disposition, document.file_name),
        ...NO_STORE,
        // Defense-in-depth (review A3): the stored mime is sniff-pinned at
        // upload; this header stops the browser from second-guessing it.
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }
)

documentsApp.delete(
  '/api/documents/:id',
  describeRoute({
    description:
      'Hard-deletes a document: the stored object AND the metadata row, with the deletion audit record in the same batch. Uploader or household owner only. Audit rows outlive the document (the deletion record survives).',
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
    await deleteDocument(c.env.DB, createR2StorageAdapter(c.env.DOCUMENTS), {
      householdId: c.get('householdId'),
      userId: c.get('userId'),
      document,
    })
    return c.newResponse(null, 204)
  }
)
