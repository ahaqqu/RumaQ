// Document vault domain logic (ahaqqu/RumaQ#422 rework of the #388 MVP).
// Routes in apps/documents.ts stay HTTP-shaped; every rule lives here so the
// name/label bounds, the size cap, the files-per-document cap, the magic-byte
// policy and the audit vocabulary have exactly one definition.
//
// Authorization model: documents scope to the caller's ACTIVE household (the
// auth middleware resolves it — same substrate as receipts). Every lookup
// filters by household_id in the SQL itself, so a foreign document id and a
// nonexistent id are indistinguishable: both answer 404 (no existence leak,
// the households-app pattern). Document delete is owner-or-uploader; file
// delete is owner, document-uploader, or file-uploader.

import { sha256HexBytes } from './crypto.js'
import { buildDocumentFileKey, isDocumentKey, type StorageAdapter } from './storage.js'
import { getMembership } from './households.js'

export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024

/** Owner decision #422 (2026-11-05): one document holds at most 20 files. */
export const DOCUMENT_MAX_FILES = 20

/**
 * Free-text document name and per-file label bound (#422): trimmed, 1-120
 * chars. The app owns trim + non-empty; the schema CHECK (0025) is the
 * backstop for the upper bound.
 */
export const DOCUMENT_NAME_MAX = 120

/** Content types the vault accepts, and the bytes that must back them. */
export const DOCUMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

/**
 * Vault-key guard (review B1 of #388): `r2_key` comes from a D1 row, and the
 * bucket is SHARED with the receipts namespace. A corrupted, hand-edited, or
 * badly-migrated row must never turn the vault's get/delete into reads or
 * deletes of a sibling namespace's objects — so every storage touch by key
 * goes through this check first. Keys are written exclusively by
 * buildDocumentFileKey (documents/<household>/<document>/<file>); legacy
 * 3-segment keys (documents/<household>/<document>) survive as the migrated
 * first file of every pre-#422 document — the only way past this guard is a
 * bug elsewhere, exactly the case it exists for.
 */
export function ensureVaultKey(storageKey: string): void {
  if (!isDocumentKey(storageKey)) {
    throw new DocumentNotFoundError()
  }
}

/** Audit actions (#422 vocabulary): document-level + file-scoped records. */
export type DocumentAction =
  | 'upload' // document create (first file rides in the same batch)
  | 'view' // inline byte stream, per file
  | 'download' // attachment byte stream, per file
  | 'delete' // document delete (all files cascade)
  | 'file_add' // file added to an existing document
  | 'file_delete' // single file removed

export type DocumentRow = {
  id: string
  household_id: string
  member_id: string | null
  name: string
  uploaded_by: string
  created_at: string
}

export type DocumentFileRow = {
  id: string
  document_id: string
  r2_key: string
  file_name: string
  size_bytes: number
  content_type: string
  label: string | null
  sort_order: number
  sha256: string
  uploaded_by: string
  uploaded_at: string
}

// The projections the API returns — metadata only, never r2_key (an internal
// R2 handle the client has no use for and must not learn). A document embeds
// its files in upload order; ≤20 per document keeps the payload bounded.
export type DocumentFileSummary = {
  id: string
  file_name: string
  content_type: string
  size_bytes: number
  label: string | null
  sort_order: number
  sha256: string
  uploaded_by: string
  uploaded_at: string
}

export type DocumentSummary = {
  id: string
  household_id: string
  member_id: string | null
  name: string
  uploaded_by: string
  created_at: string
  files: DocumentFileSummary[]
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

// Owner decision #422: the 20-files-per-document cap. 409, not 413 — the
// request body is fine; the document's state refuses another file.
export class DocumentTooManyFilesError extends Error {
  constructor(message = `A document can hold at most ${DOCUMENT_MAX_FILES} files.`) {
    super(message)
    this.name = 'DocumentTooManyFilesError'
  }
}

// One message for unknown bytes AND declared-vs-actual mismatch — the client
// must not learn which byte check failed (sniff policy: reject, never
// override; pinned in the #388 PR).
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
 * PNG 89 50 4E 47 0D 0A 1A 0A, WebP RIFF·????·WEBP, PDF %PDF-.
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
 * The free-text document name (#422): control characters stripped, trimmed,
 * non-empty, capped at 120 — over-length truncates (the sanitizeFileName
 * precedent), so an API caller never gets a silent 400 from whitespace.
 * Null means "no valid name" — the route turns that into a 400.
 */
export function sanitizeDocumentName(raw: string): string | null {
  const cleaned = [...raw]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code > 0x1f && code !== 0x7f
    })
    .join('')
    .trim()
  if (!cleaned) return null
  return cleaned.slice(0, DOCUMENT_NAME_MAX)
}

/**
 * The optional per-file label (#422 owner decision 1): absent, empty, or
 * whitespace-only means NULL; otherwise control characters stripped,
 * trimmed, capped at 120.
 */
export function sanitizeDocumentLabel(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const cleaned = [...raw]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code > 0x1f && code !== 0x7f
    })
    .join('')
    .trim()
  if (!cleaned) return null
  return cleaned.slice(0, DOCUMENT_NAME_MAX)
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

// One LEFT JOIN round trip carries each document with its files — no second
// query, no IN-list parameter limits. The LEFT JOIN keeps zero-file documents
// visible (a file row simply comes back null); JS groups the flat rows.
type DocumentJoinRow = {
  document_id: string
  household_id: string
  member_id: string | null
  name: string
  uploaded_by: string
  created_at: string
  file_id: string | null
  file_name: string | null
  size_bytes: number | null
  content_type: string | null
  label: string | null
  sort_order: number | null
  file_sha256: string | null
  file_uploaded_by: string | null
  uploaded_at: string | null
}

const DOCUMENT_JOIN_PROJECTION = `SELECT d.id AS document_id, d.household_id, d.member_id,
       d.name, d.uploaded_by, d.created_at,
       f.id AS file_id, f.file_name, f.size_bytes, f.content_type,
       f.label, f.sort_order, f.sha256 AS file_sha256,
       f.uploaded_by AS file_uploaded_by, f.uploaded_at
  FROM documents d
  LEFT JOIN document_files f ON f.document_id = d.id`

function groupJoinRows(rows: DocumentJoinRow[]): DocumentSummary[] {
  const byId = new Map<string, DocumentSummary>()
  for (const row of rows) {
    let doc = byId.get(row.document_id)
    if (!doc) {
      doc = {
        id: row.document_id,
        household_id: row.household_id,
        member_id: row.member_id,
        name: row.name,
        uploaded_by: row.uploaded_by,
        created_at: row.created_at,
        files: [],
      }
      byId.set(row.document_id, doc)
    }
    if (row.file_id !== null) {
      doc.files.push({
        id: row.file_id,
        file_name: row.file_name as string,
        content_type: row.content_type as string,
        size_bytes: row.size_bytes as number,
        label: row.label,
        sort_order: row.sort_order as number,
        sha256: row.file_sha256 as string,
        uploaded_by: row.file_uploaded_by as string,
        uploaded_at: row.uploaded_at as string,
      })
    }
  }
  return [...byId.values()]
}

const DOCUMENTS_ORDER = `ORDER BY d.created_at DESC, d.id DESC, f.sort_order ASC, f.id ASC`

/**
 * List the active household's documents, newest first, each with its files in
 * upload order. Filters compose into the WHERE clause with bound parameters
 * only — no string interpolation of values. `q` is the #422 NAME SEARCH
 * (owner decision 2): a case-insensitive contains-match on the document
 * name; LIKE metacharacters are escaped so the needle is literal.
 */
export async function listDocuments(
  db: D1Database,
  householdId: string,
  filters: { q?: string; memberId?: string } = {}
): Promise<DocumentSummary[]> {
  const conditions = ['d.household_id = ?']
  const params: string[] = [householdId]
  if (filters.memberId !== undefined) {
    conditions.push('d.member_id = ?')
    params.push(filters.memberId)
  }
  if (filters.q !== undefined) {
    // lower() + LIKE: SQLite's LIKE folds ASCII case only, and lower() makes
    // the intent explicit on both sides. ESCAPE '\' keeps %, _, and \ literal
    // — a search for "50%" finds "50%" and not "50x".
    const needle = filters.q.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)
    conditions.push(`lower(d.name) LIKE ? ESCAPE '\\'`)
    params.push(`%${needle}%`)
  }
  const { results } = await db
    .prepare(
      `${DOCUMENT_JOIN_PROJECTION}
        WHERE ${conditions.join(' AND ')}
        ${DOCUMENTS_ORDER}`
    )
    .bind(...params)
    .all<DocumentJoinRow>()
  return groupJoinRows(results)
}

/**
 * The scoped single-document lookup with files — every route that serves a
 * document (or decides authz for one) starts here. The household predicate
 * rides in the SQL, so a foreign household's id is just "not found" —
 * answered before any authz decision (no existence leak).
 */
export async function getDocumentWithFiles(
  db: D1Database,
  householdId: string,
  documentId: string
): Promise<DocumentSummary | null> {
  const { results } = await db
    .prepare(`${DOCUMENT_JOIN_PROJECTION} WHERE d.id = ? AND d.household_id = ? ${DOCUMENTS_ORDER}`)
    .bind(documentId, householdId)
    .all<DocumentJoinRow>()
  const summaries = groupJoinRows(results)
  return summaries[0] ?? null
}

/** The documents-only row for authz flows (no join needed to delete). */
export async function getDocumentRow(
  db: D1Database,
  householdId: string,
  documentId: string
): Promise<DocumentRow | null> {
  return db
    .prepare(
      `SELECT d.id, d.household_id, d.member_id, d.name,
              d.uploaded_by, d.created_at
         FROM documents d
        WHERE d.id = ? AND d.household_id = ?`
    )
    .bind(documentId, householdId)
    .first<DocumentRow>()
}

/** The document's files in upload order (r2_key included — lib-internal). */
export async function listDocumentFiles(
  db: D1Database,
  documentId: string
): Promise<DocumentFileRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, document_id, r2_key, file_name, size_bytes, content_type,
              label, sort_order, sha256, uploaded_by, uploaded_at
         FROM document_files
        WHERE document_id = ?
        ORDER BY sort_order ASC, id ASC`
    )
    .bind(documentId)
    .all<DocumentFileRow>()
  return results
}

/**
 * The scoped single-file lookup: the file must belong to the named document,
 * and the document to the caller's household — one JOIN answers all three
 * (a foreign household's file id is just "not found").
 */
export async function getDocumentFileRow(
  db: D1Database,
  householdId: string,
  documentId: string,
  fileId: string
): Promise<DocumentFileRow | null> {
  return db
    .prepare(
      `SELECT f.id, f.document_id, f.r2_key, f.file_name, f.size_bytes,
              f.content_type, f.label, f.sort_order, f.sha256,
              f.uploaded_by, f.uploaded_at
         FROM document_files f
         JOIN documents d ON d.id = f.document_id
        WHERE f.id = ? AND f.document_id = ? AND d.household_id = ?`
    )
    .bind(fileId, documentId, householdId)
    .first<DocumentFileRow>()
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
      `INSERT INTO documents (id, household_id, member_id, name, uploaded_by)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(row.id, row.household_id, row.member_id, row.name, row.uploaded_by)
}

function insertFileStatement(db: D1Database, row: DocumentFileRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO document_files
         (id, document_id, r2_key, file_name, size_bytes, content_type, label,
          sort_order, sha256, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.id,
      row.document_id,
      row.r2_key,
      row.file_name,
      row.size_bytes,
      row.content_type,
      row.label,
      row.sort_order,
      row.sha256,
      row.uploaded_by,
      row.uploaded_at
    )
}

function insertAuditStatement(
  db: D1Database,
  args: {
    documentId: string
    householdId: string
    actorUserId: string
    action: DocumentAction
    fileId?: string
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO document_audit (id, document_id, household_id, actor_user_id, action, document_file_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      args.documentId,
      args.householdId,
      args.actorUserId,
      args.action,
      args.fileId ?? null
    )
}

async function readBackSummary(
  db: D1Database,
  householdId: string,
  documentId: string
): Promise<DocumentSummary> {
  const stored = await getDocumentWithFiles(db, householdId, documentId)
  if (!stored) {
    // The batch committed but the read-back found nothing — a database that
    // broken fails every later request too; surface it as a 500.
    throw new Error('document insert did not persist')
  }
  return stored
}

/**
 * Create: the free-text name + the FIRST file (#422). Bytes already validated
 * and sniffed by the route. The adapter write comes FIRST (spec order); the
 * document row, the file row (sort_order 1) and the 'upload' audit record
 * commit in one D1 batch. A batch failure after the put leaves an
 * unreferenced object — unreachable by every route (rows are the only key
 * source), the same accept-and-move-on trade the receipt scan route makes.
 */
export async function createDocument(
  db: D1Database,
  storage: StorageAdapter,
  args: {
    householdId: string
    memberId: string | null
    name: string
    file: { fileName: string; bytes: Uint8Array<ArrayBuffer>; mime: string; label: string | null }
    uploadedBy: string
  }
): Promise<DocumentSummary> {
  const documentId = crypto.randomUUID()
  const fileId = crypto.randomUUID()
  const storageKey = buildDocumentFileKey(args.householdId, documentId, fileId)
  const sha256 = await sha256HexBytes(args.file.bytes)

  await storage.put(storageKey, args.file.bytes, args.file.mime)

  await db.batch([
    insertDocumentStatement(db, {
      id: documentId,
      household_id: args.householdId,
      member_id: args.memberId,
      name: args.name,
      uploaded_by: args.uploadedBy,
      created_at: '', // D1 default fills it; the read-back below returns truth.
    }),
    insertFileStatement(db, {
      id: fileId,
      document_id: documentId,
      r2_key: storageKey,
      file_name: args.file.fileName,
      size_bytes: args.file.bytes.byteLength,
      content_type: args.file.mime,
      label: args.file.label,
      sort_order: 1,
      sha256,
      uploaded_by: args.uploadedBy,
      uploaded_at: '', // D1 default fills it; the read-back below returns truth.
    }),
    insertAuditStatement(db, {
      documentId,
      householdId: args.householdId,
      actorUserId: args.uploadedBy,
      action: 'upload',
    }),
  ])

  return readBackSummary(db, args.householdId, documentId)
}

/**
 * Add a file to an existing document (#422). The 20-files cap fires BEFORE
 * the storage put — the bucket never takes bytes the document cannot keep.
 * sort_order = max + 1 keeps upload order deterministic even when files land
 * in the same second. The file row + its 'file_add' audit record commit in
 * one batch, same put-first spec order as createDocument.
 */
export async function addDocumentFile(
  db: D1Database,
  storage: StorageAdapter,
  args: {
    householdId: string
    documentId: string
    file: { fileName: string; bytes: Uint8Array<ArrayBuffer>; mime: string; label: string | null }
    uploadedBy: string
  }
): Promise<DocumentSummary> {
  const countRow = await db
    .prepare('SELECT COUNT(*) AS cnt FROM document_files WHERE document_id = ?')
    .bind(args.documentId)
    .first<{ cnt: number }>()
  if ((countRow?.cnt ?? 0) >= DOCUMENT_MAX_FILES) {
    throw new DocumentTooManyFilesError()
  }

  const sortRow = await db
    .prepare(
      'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM document_files WHERE document_id = ?'
    )
    .bind(args.documentId)
    .first<{ max_order: number }>()

  const fileId = crypto.randomUUID()
  const storageKey = buildDocumentFileKey(args.householdId, args.documentId, fileId)
  const sha256 = await sha256HexBytes(args.file.bytes)

  await storage.put(storageKey, args.file.bytes, args.file.mime)

  await db.batch([
    insertFileStatement(db, {
      id: fileId,
      document_id: args.documentId,
      r2_key: storageKey,
      file_name: args.file.fileName,
      size_bytes: args.file.bytes.byteLength,
      content_type: args.file.mime,
      label: args.file.label,
      sort_order: (sortRow?.max_order ?? 0) + 1,
      sha256,
      uploaded_by: args.uploadedBy,
      uploaded_at: '',
    }),
    insertAuditStatement(db, {
      documentId: args.documentId,
      householdId: args.householdId,
      actorUserId: args.uploadedBy,
      action: 'file_add',
      fileId,
    }),
  ])

  return readBackSummary(db, args.householdId, args.documentId)
}

/**
 * Delete ONE file: household owner, the document's uploader, or the file's
 * own uploader. The adapter object goes first (spec order — R2 delete is
 * idempotent, a failed batch after it is recoverable by retry); the
 * 'file_delete' audit row + file row commit in one batch. Deleting the last
 * file leaves a zero-file document — the owner deletes the document itself
 * explicitly; no hidden cascade surprise.
 */
export async function deleteDocumentFile(
  db: D1Database,
  storage: StorageAdapter,
  args: {
    householdId: string
    userId: string
    document: DocumentRow
    file: DocumentFileRow
  }
): Promise<void> {
  const { document, file } = args
  const membership = await getMembership(db, args.householdId, args.userId)
  if (!membership) {
    throw new DocumentNotFoundError()
  }
  const allowed =
    membership.role === 'owner' ||
    document.uploaded_by === args.userId ||
    file.uploaded_by === args.userId
  if (!allowed) {
    throw new DocumentForbiddenError()
  }

  // Vault-key guard (review B1 of #388): a row whose key escaped the
  // documents/ namespace never touches storage.
  ensureVaultKey(file.r2_key)

  await storage.delete(file.r2_key)

  await db.batch([
    insertAuditStatement(db, {
      documentId: document.id,
      householdId: args.householdId,
      actorUserId: args.userId,
      action: 'file_delete',
      fileId: file.id,
    }),
    db
      .prepare('DELETE FROM document_files WHERE id = ? AND document_id = ?')
      .bind(file.id, document.id),
  ])
}

/**
 * Delete the WHOLE document: owner-or-uploader. Every file's R2 object goes
 * first (spec order — a failed batch after the deletes leaves rows the file
 * routes 404 on, and a DELETE retry recovers because R2 delete is
 * idempotent); the audit row + document row commit in one batch, and the
 * document_files FK cascade (0025) removes the file rows atomically. The
 * audit row is written BEFORE the delete inside the batch and survives it
 * (no FK on document_audit.document_id — the deletion record must outlive
 * the row it names).
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

  const files = await listDocumentFiles(db, document.id)
  for (const file of files) {
    // Vault-key guard (review B1): one escaped key must never take a sibling
    // namespace's object with it (e.g. a receipt).
    ensureVaultKey(file.r2_key)
    await storage.delete(file.r2_key)
  }

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
 * for attachment (the route picks by disposition and calls this). Per file
 * since #422: the record names the exact file.
 */
export async function recordDocumentAccess(
  db: D1Database,
  args: {
    documentId: string
    fileId: string
    householdId: string
    actorUserId: string
    action: 'view' | 'download'
  }
): Promise<void> {
  await insertAuditStatement(db, {
    documentId: args.documentId,
    householdId: args.householdId,
    actorUserId: args.actorUserId,
    action: args.action,
    fileId: args.fileId,
  }).run()
}
