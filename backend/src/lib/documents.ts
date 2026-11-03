// Document vault domain logic (ahaqqu/RumaQ#388 MVP). Routes in
// apps/documents.ts stay HTTP-shaped; every rule lives here so the category
// allowlist, the size cap, the magic-byte policy and the audit vocabulary
// have exactly one definition.
//
// Authorization model: documents scope to the caller's ACTIVE household (the
// auth middleware resolves it — same substrate as receipts). Every lookup
// filters by household_id in the SQL itself, so a foreign document id and a
// nonexistent id are indistinguishable: both answer 404 (no existence leak,
// the households-app pattern). Delete is owner-or-uploader.

import { sha256HexBytes } from './crypto.js'
import { buildDocumentKey, type StorageAdapter } from './storage.js'
import { getMembership } from './households.js'

export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024

/** The MVP directive's closed category set (#388) — 'lainnya' is the catch-all. */
export const DOCUMENT_CATEGORIES = [
  'kartu_keluarga',
  'ktp',
  'kartu_anak',
  'akta',
  'paspor',
  'bpjs',
  'lainnya',
] as const

export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number]

/** Content types the vault accepts, and the bytes that must back them. */
export const DOCUMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

export type DocumentAction = 'upload' | 'view' | 'download' | 'delete'

export type DocumentRow = {
  id: string
  household_id: string
  member_id: string | null
  category: DocumentCategory
  file_name: string
  mime_type: string
  size_bytes: number
  storage_key: string
  sha256: string
  uploaded_by: string
  created_at: string
}

// The projection the API returns — metadata only, never storage_key (an
// internal R2 handle the client has no use for and must not learn).
export type DocumentSummary = {
  id: string
  household_id: string
  member_id: string | null
  category: DocumentCategory
  file_name: string
  mime_type: string
  size_bytes: number
  sha256: string
  uploaded_by: string
  created_at: string
}

export class DocumentValidationError extends Error {
  constructor(message = 'Invalid document upload') {
    super(message)
    this.name = 'DocumentValidationError'
  }
}

export class DocumentTooLargeError extends Error {
  constructor(message = 'File too large. Maximum size is 10 MB.') {
    super(message)
    this.name = 'DocumentTooLargeError'
  }
}

// One message for unknown bytes AND declared-vs-actual mismatch — the client
// must not learn which byte check failed (sniff policy: reject, never
// override; pinned in the PR).
export class DocumentUnsupportedTypeError extends Error {
  constructor(message = 'Unsupported file type. Accepted: JPEG, PNG, WebP, PDF.') {
    super(message)
    this.name = 'DocumentUnsupportedTypeError'
  }
}

export class DocumentNotFoundError extends Error {
  constructor(message = 'Document not found') {
    super(message)
    this.name = 'DocumentNotFoundError'
  }
}

export class DocumentForbiddenError extends Error {
  constructor(message = 'Only the uploader or a household owner can do that') {
    super(message)
    this.name = 'DocumentForbiddenError'
  }
}

/**
 * Magic-byte sniffing: the ONLY source of truth for what a file really is.
 * The client-declared mime is advisory — it must agree with the sniffed type
 * or the upload is rejected (declared-vs-actual mismatch). JPEG FF D8 FF,
 * PNG 89 50 4E 47 0D 0A 1A 0A, WebP RIFF· Weintrag ·WEBP, PDF %PDF-.
 */
export function sniffDocumentMime(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
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
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes.length >= 12 &&
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return 'image/webp'
  }
  if (
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  ) {
    return 'application/pdf'
  }
  return null
}

/**
 * Strip any directory component and control characters; reject empties.
 * The stored file_name is display/download data, never a path.
 */
export function sanitizeFileName(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = [...base]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code > 0x1f && code !== 0x7f
    })
    .join('')
    .trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') return null
  return cleaned.slice(0, 255)
}

/**
 * RFC 6266/5987 Content-Disposition: an ASCII-sanitized quoted fallback plus
 * the RFC 5987 filename* form, so Indonesian file names survive the header.
 */
export function contentDisposition(kind: 'inline' | 'attachment', fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (ch) => {
    return '%' + ch.charCodeAt(0).toString(16).toUpperCase()
  })
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

function toSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    household_id: row.household_id,
    member_id: row.member_id,
    category: row.category,
    file_name: row.file_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
  }
}

const DOCUMENT_PROJECTION = `SELECT d.id, d.household_id, d.member_id, d.category,
       d.file_name, d.mime_type, d.size_bytes, d.storage_key, d.sha256,
       d.uploaded_by, d.created_at
  FROM documents d`

/**
 * List the active household's documents, newest first, optionally filtered by
 * member and/or category. Conditions compose into the WHERE clause with bound
 * parameters only — no string interpolation of values.
 */
export async function listDocuments(
  db: D1Database,
  householdId: string,
  filters: { memberId?: string; category?: DocumentCategory } = {}
): Promise<DocumentSummary[]> {
  const conditions = ['d.household_id = ?']
  const params: string[] = [householdId]
  if (filters.memberId !== undefined) {
    conditions.push('d.member_id = ?')
    params.push(filters.memberId)
  }
  if (filters.category !== undefined) {
    conditions.push('d.category = ?')
    params.push(filters.category)
  }
  const { results } = await db
    .prepare(
      `${DOCUMENT_PROJECTION}
        WHERE ${conditions.join(' AND ')}
        ORDER BY d.created_at DESC, d.id DESC`
    )
    .bind(...params)
    .all<DocumentRow>()
  return results.map(toSummary)
}

/**
 * The scoped single-document lookup every route starts from: the household
 * predicate rides in the SQL, so a foreign household's id is just "not
 * found" — answered before any authz decision (no existence leak).
 */
export async function getDocumentRow(
  db: D1Database,
  householdId: string,
  documentId: string
): Promise<DocumentRow | null> {
  return db
    .prepare(`${DOCUMENT_PROJECTION} WHERE d.id = ? AND d.household_id = ?`)
    .bind(documentId, householdId)
    .first<DocumentRow>()
}

/**
 * The member relation accepts BOTH modes (0021): linked and profile-only
 * members share the surrogate id. Returns null when the member is not part of
 * THIS household — the caller turns that into a 400 (a body-reference
 * problem, not an addressable-resource probe).
 */
export async function isHouseholdMember(
  db: D1Database,
  householdId: string,
  memberId: string
): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM household_members WHERE id = ? AND household_id = ?')
    .bind(memberId, householdId)
    .first<{ id: string }>()
  return row !== null
}

function insertDocumentStatement(db: D1Database, row: DocumentRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO documents
         (id, household_id, member_id, category, file_name, mime_type, size_bytes,
          storage_key, sha256, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.id,
      row.household_id,
      row.member_id,
      row.category,
      row.file_name,
      row.mime_type,
      row.size_bytes,
      row.storage_key,
      row.sha256,
      row.uploaded_by
    )
}

function insertAuditStatement(
  db: D1Database,
  args: {
    documentId: string
    householdId: string
    actorUserId: string
    action: DocumentAction
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO document_audit (id, document_id, household_id, actor_user_id, action)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(crypto.randomUUID(), args.documentId, args.householdId, args.actorUserId, args.action)
}

/**
 * Upload: bytes already validated and sniffed by the route. The adapter write
 * comes FIRST (spec order); the row + its 'upload' audit record commit in one
 * D1 batch. A batch failure after the put leaves an unreferenced object —
 * unreachable by every route (rows are the only key source), the same
 * accept-and-move-on trade the receipt scan route makes.
 */
export async function createDocument(
  db: D1Database,
  storage: StorageAdapter,
  args: {
    householdId: string
    memberId: string | null
    category: DocumentCategory
    fileName: string
    bytes: Uint8Array
    mime: string
    uploadedBy: string
  }
): Promise<DocumentSummary> {
  const documentId = crypto.randomUUID()
  const storageKey = buildDocumentKey(args.householdId, documentId)
  const sha256 = await sha256HexBytes(args.bytes)

  await storage.put(storageKey, args.bytes, args.mime)

  const row: DocumentRow = {
    id: documentId,
    household_id: args.householdId,
    member_id: args.memberId,
    category: args.category,
    file_name: args.fileName,
    mime_type: args.mime,
    size_bytes: args.bytes.byteLength,
    storage_key: storageKey,
    sha256,
    uploaded_by: args.uploadedBy,
    created_at: '', // D1 default fills it; the read-back below returns truth.
  }

  await db.batch([
    insertDocumentStatement(db, row),
    insertAuditStatement(db, {
      documentId,
      householdId: args.householdId,
      actorUserId: args.uploadedBy,
      action: 'upload',
    }),
  ])

  const stored = await getDocumentRow(db, args.householdId, documentId)
  if (!stored) {
    // The batch committed but the read-back found nothing — a database that
    // broken fails every later request too; surface it as a 500.
    throw new Error('document insert did not persist')
  }
  return toSummary(stored)
}

/**
 * Delete: owner-or-uploader. The adapter object goes first (spec order — a
 * failed batch after it leaves a dead row the content route 404s, and a
 * DELETE retry recovers because R2 delete is idempotent); the audit row +
 * document row commit in one batch. The audit row is written BEFORE the
 * delete inside the batch and survives it (no FK on document_audit.
 * document_id — the deletion record must outlive the row it names).
 */
export async function deleteDocument(
  db: D1Database,
  storage: StorageAdapter,
  args: { householdId: string; userId: string; document: DocumentRow }
): Promise<void> {
  const { document } = args
  const membership = await getMembership(db, args.householdId, args.userId)
  if (!membership) {
    throw new DocumentNotFoundError()
  }
  const isUploader = document.uploaded_by === args.userId
  const isOwner = membership.role === 'owner'
  if (!isUploader && !isOwner) {
    throw new DocumentForbiddenError()
  }

  await storage.delete(document.storage_key)

  await db.batch([
    insertAuditStatement(db, {
      documentId: document.id,
      householdId: args.householdId,
      actorUserId: args.userId,
      action: 'delete',
    }),
    db
      .prepare('DELETE FROM documents WHERE id = ? AND household_id = ?')
      .bind(document.id, args.householdId),
  ])
}

/**
 * One audit record for a served byte stream — 'view' for inline, 'download'
 * for attachment (the route picks by disposition and calls this).
 */
export async function recordDocumentAccess(
  db: D1Database,
  args: {
    documentId: string
    householdId: string
    actorUserId: string
    action: 'view' | 'download'
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO document_audit (id, document_id, household_id, actor_user_id, action)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(crypto.randomUUID(), args.documentId, args.householdId, args.actorUserId, args.action)
    .run()
}
