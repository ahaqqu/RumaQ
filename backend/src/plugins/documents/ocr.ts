// Expiry-date OCR route (ahaqqu/RumaQ#433, review T4-B1): extracted from
// the vault app (plugins/documents/app.ts) so it stays under the 1k review bar — this
// module owns the route + its HTTP mapping, while the round-trip rules and
// the audit pairing live in lib/document-ocr.ts (runExpiryOcr). Auth and the
// plugin gate are NOT installed here: app.ts's VAULT_PROTECTED_PATTERNS
// loop remains the single canonical wiring point and covers this exact path
// string (apiApp.use(path) does not cover subpaths — #292 — so the pattern
// list entry is what makes the route protected).
//
// Reads one IMAGE file's validity date with the caller's OWN AI provider —
// the same user-first / server-fallback resolution as every AI route
// (lib/ai-access.ts), with the resolved VISION model (ai_vision_model →
// ai_model → provider default; the server's model only on the server-fallback
// branch). Opt-in per file ("Read date"), never automatic: the model's answer
// is a SUGGESTION that prefills the #426 expiry editor — only the
// user-confirmed PATCH writes, with its own audit row. The attempt itself is
// audited twice over, each row in its own ledger: ai_usage_events
// (provider/model/key_source/tokens, on failures too — the provider billed
// those inputs) plus the document_audit 'ocr' record for the byte read
// (review T4-A1: a read that ships bytes to a third party is audited like
// every other vault byte access, with a document reference). No document
// content is ever logged.

import type { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import type { Env } from '../../types.js'
import { isRateLimited } from '../../lib/rate-limit.js'
import type { StorageAdapter } from '../../ports/storage/index.js'
import {
  DocumentNotFoundError,
  DocumentUnsupportedTypeError,
  ensureVaultKey,
  getDocumentFileRow,
  getDocumentRow,
  recordDocumentAccess,
} from './lib.js'
import { DocumentOcrError, isExpiryOcrSupported, runExpiryOcr } from '../../lib/document-ocr.js'
import { loadUserAiSettings, resolveAiAccess } from '../../lib/ai-access.js'

// The expiry-OCR endpoint: no request body, but every accepted call is a
// provider-billed vision request over up to 10 MB of image. The opt-in
// "Read date" action is per file, so a full 20-file document is 20 calls —
// the window holds one full document plus headroom, same shape as the upload
// limiter (documents.ts).
const OCR_RATE_WINDOW_MS = 60_000
const OCR_RATE_MAX = 30

function enforceOcrRate(userId: string): { limited: boolean; retryAfter: number } {
  return isRateLimited(`doc-ocr:${userId}`, OCR_RATE_WINDOW_MS, OCR_RATE_MAX)
}

export function registerExpiryOcrRoutes(documentsApp: Hono<Env>, storage: StorageAdapter): void {
  documentsApp.post(
    '/api/documents/:id/files/:fileId/extract-expiry',
    describeRoute({
      description:
        'Reads one file’s expiry date with the caller’s own AI provider (vision model: ai_vision_model, falling back to ai_model; server key/model when no user key is set). Image files only (JPEG, PNG, WebP — PDFs are refused). Returns a SUGGESTED expires_on (null when the model found no date) and the model asked; nothing is written — the user confirms through PATCH /api/documents/{id}. Every attempt records an ai_usage_events row (failures included) and an outcome log line, and the byte read is audited as a document_audit ‘ocr’ record naming the file; document content is never logged.',
      security: [{ cookieAuth: [] }],
      responses: {
        200: {
          description:
            'OK — the suggested expiry date (null when none was found) and the vision model used',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['expires_on', 'model'],
                properties: {
                  expires_on: { type: ['string', 'null'], description: 'ISO YYYY-MM-DD or null' },
                  model: { type: ['string', 'null'] },
                },
              },
            },
          },
        },
        401: { description: 'Unauthorized' },
        404: { description: 'Document not found' },
        402: { description: 'AI provider not configured' },
        415: { description: 'Not an image file (JPEG, PNG, WebP)' },
        429: { description: 'Too many OCR requests' },
        502: { description: 'The provider call or its answer failed validation' },
      },
    }),
    async (c) => {
      const userId = c.get('userId')
      const householdId = c.get('householdId')

      const { limited, retryAfter } = enforceOcrRate(userId)
      if (limited) {
        return c.json({ error: 'Too many OCR requests. Please slow down.' }, 429, {
          'Retry-After': String(retryAfter),
        })
      }

      // Scoped lookups first, exactly like the content endpoint (no existence
      // leak): document, then its file, then the stored bytes.
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

      if (!isExpiryOcrSupported(file.content_type)) {
        throw new DocumentUnsupportedTypeError(
          'Reading a date needs an image file (JPEG, PNG, or WebP). PDF text extraction is not supported.'
        )
      }

      const settings = await loadUserAiSettings(c.env.DB, userId)
      const access = await resolveAiAccess(c.env, settings)
      if (!access) {
        return c.json(
          {
            error: 'AI provider not configured. Go to Settings to set up your AI key.',
          },
          402
        )
      }

      ensureVaultKey(file.r2_key)
      const stored = await storage.get(file.r2_key)
      if (!stored) {
        // Row without bytes (a failed delete batch mid-crash, say) is a dead
        // file — never a server error leak.
        throw new DocumentNotFoundError()
      }
      const imageBytes = await new Response(stored.stream).arrayBuffer()

      // The read is audited the moment the bytes leave storage — mirroring
      // the content endpoint's audit of the identical read (review T4-A1).
      // 'ocr' (not 'view'): the bytes are about to be disclosed to the
      // caller's AI provider, which is exactly what the audit trail must
      // survive to say. Later provider failures do not un-ring this bell.
      await recordDocumentAccess(c.env.DB, {
        documentId: document.id,
        fileId: file.id,
        householdId: document.household_id,
        actorUserId: userId,
        action: 'ocr',
      })

      // Every path that reaches the provider decision audits itself inside
      // runExpiryOcr (usage event + outcome log, once); this handler only
      // maps the outcome to HTTP.
      try {
        const { suggestion } = await runExpiryOcr(c.env, {
          access,
          imageBytes,
          contentType: file.content_type,
          userId,
          householdId,
          documentId: document.id,
          fileId: file.id,
        })

        // Metadata (never bytes) rides the vault app's no-cache posture —
        // the answer is household-scoped and session-fresh.
        const res = c.json({ expires_on: suggestion, model: access.visionModel })
        res.headers.set('Cache-Control', 'private, no-cache')
        return res
      } catch (err) {
        // DECISION (review T4-A4): the provider's own error text stays in the
        // 502 body, exactly like the receipts scan — it is the caller's OWN
        // provider answering their own key, so the disclosure is same-user,
        // and actionable copy ("your model rejected the request") would hide
        // the one signal that fixes it. The key and the document bytes never
        // ride this path (asserted in documents-ocr.test.ts); the generic
        // 500 envelope covers everything else.
        return c.json(
          {
            error:
              err instanceof DocumentOcrError
                ? err.message
                : `AI extraction failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
          },
          502
        )
      }
    }
  )
}
