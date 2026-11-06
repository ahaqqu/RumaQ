// The documents plugin's export job (ahaqqu/RumaQ#440 — plugin architecture
// ticket 6, docs/plan/plugin-architecture.md §3.4 "export event recorded",
// §3.5 ticket 6). One ARCHIVE of one household's vault: the documents rows
// (the #422 free-text names), the document_files rows, and — the point of
// the ticket — the file BYTES themselves, so a household can take its data
// out BEFORE a purge. Read-only: it never gates, blocks, or mutates the
// purge machinery, and it stays available while a drain is in flight (the
// write gate pauses uploads, never reads). Format: a stored (uncompressed)
// ZIP of the bytes at files/<document>/<sort>-<name> + two CSVs (UTF-8 +
// BOM, RFC 4180) + a trailing manifest.json — dependency-free (the ticket's
// acceptance criterion; the writer is lib/zip.ts), CSV because the issue
// names it, and the per-file sha256 rides the metadata for byte-level
// verification.
//
// SIZE STRATEGY (the Worker-side constraints, §7's "keep it simple"):
// - One archive carries at most `maxFiles` files (core's subrequest budget,
//   lib/plugin-export.ts — free plan 50: ≤ 4 D1 statements + 40 R2 gets),
//   WHOLE documents only — a document's files never split across two
//   archives (the purge chunk's whole-document discipline). The
//   per-document cap is 20 files (DOCUMENT_MAX_FILES), so any budget ≥ that
//   fits a document and a vault of any size drains through sequential
//   archives via the continuation cursor.
// - The archive STREAMS with LAZY per-file loaders (lib/zip.ts): each R2
//   get happens as the body drains, and peak memory is the largest single
//   file (≤ DOCUMENT_MAX_BYTES = 10 MB) — never the page, never the vault,
//   well under the 128 MB isolate limit.
// - No zip64: maxFiles × 10 MB stays far below the 4 GB field ceiling.
//
// HOUSEHOLD PREDICATE EVERYWHERE (the P1-/C1- standard): every query below
// filters household_id, the cursor carries the household it was issued for
// (a cursor from household A replayed against household B is a 400, not a
// silently wrong slice), and the port reads are vault-key-guarded
// (ensureVaultKey — review B1 of #388) so a corrupted r2_key can never pull
// a sibling namespace's object into the archive.

import { DOCUMENT_MAX_FILES, ensureVaultKey, contentDisposition } from './lib.js'
import { documentsManifest } from './manifest.js'
import type { StorageAdapter } from '../../ports/storage/index.js'
import {
  PluginExportCursorError,
  type PluginExportArchive,
  type PluginExportJob,
} from '../types.js'
import { zipStream, type ZipEntry } from '../../lib/zip.js'

// The metadata page ceiling: one `document_id IN (...)` query serves the
// whole page and D1 caps a statement at 100 bound parameters — 50 documents
// keeps that query at ≤ 50 parameters with headroom (the purge chunk's
// CHUNK_DOC_MAX precedent, one notch looser because the export's file query
// binds only the ids).
const DOC_PAGE_MAX = 50

/** The keyset ordering key (created_at, id) — the purge cursor's shape,
 * plus the household the archive sequence was issued for: the cursor is
 * replayed against the ACTIVE household, and a household must never
 * consume another household's cursor (it would silently export a slice
 * of the wrong data window). Serialized as base64url(JSON) — opaque to
 * the client, verified here. */
type ExportCursor = { household_id: string; created_at: string; id: string }

function encodeCursor(cursor: ExportCursor): string {
  const json = JSON.stringify(cursor)
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeCursor(raw: string): ExportCursor | null {
  try {
    const binary = atob(raw.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as ExportCursor).household_id === 'string' &&
      typeof (parsed as ExportCursor).created_at === 'string' &&
      typeof (parsed as ExportCursor).id === 'string'
    ) {
      return parsed as ExportCursor
    }
  } catch {
    // Unparseable → fall through: the caller refuses it (400) rather than
    // silently restarting from the oldest document — the cursor came from
    // THIS endpoint's own response header, so a value we can't decode means
    // tampering or truncation, and a silent restart would duplicate the
    // first archive under a new name with no explanation.
  }
  return null
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180): CRLF records, minimal quoting (quote only when the field
// contains a quote, comma, or newline; double the quotes), UTF-8 with a BOM
// — the BOM is what makes Excel's default import decode non-ASCII names as
// UTF-8 instead of the system codepage.
// ---------------------------------------------------------------------------

function csvField(value: string | number | null): string {
  const text = value === null ? '' : String(value)
  if (text.includes('"') || text.includes(',') || text.includes('\r') || text.includes('\n')) {
    return `"${text.replaceAll('"', '""')}"`
  }
  return text
}

function csvTable(header: string[], rows: Array<Array<string | number | null>>): string {
  const lines = [header, ...rows.map((row) => row.map(csvField))]
  return '\uFEFF' + lines.map((line) => line.join(',')).join('\r\n')
}

/** The stored document_files row, as the export reads it (r2_key included —
 * lib-internal, like listDocumentFiles; the CSVs never carry it). */
type ExportFileRow = {
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

/** SQLite datetime('now') text → Date (UTC). The frontend's
 * `replace(' ', 'T') + 'Z'` idiom; invalid text yields undefined (the entry
 * then defaults to now). */
function parseSqliteDate(raw: string | null): Date | undefined {
  if (!raw) return undefined
  const parsed = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z')
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/**
 * The archive path for one file: files/<document>/<sort>-<name>. The
 * sort_order prefix keeps two same-named files apart inside one document
 * (the #422 model never required unique names); the document id segment
 * keeps documents apart. The separator replacement is defensive —
 * sanitizeFileName stripped path separators at upload — so a hand-edited
 * row can never make the entry name carry a `/` of its own.
 */
function archivePath(documentId: string, file: ExportFileRow): string {
  const safeName = file.file_name.replaceAll('/', '_').replaceAll('\\', '_')
  return `files/${documentId}/${file.sort_order}-${safeName}`
}

/**
 * One file's bytes, through the injected port. Two SKIP-WITH-NOTE states
 * (the export must not fail wholesale on a half-dead vault — the exact
 * vault that most needs to export before its purge):
 * - a corrupted r2_key (ensureVaultKey's only throw): never fed to the
 *   adapter, so a sibling namespace's object can never be read into the
 *   archive,
 * - a row whose object is gone (get → null): the dead-file state the
 *   content endpoint also 404s.
 * Both resolve to ZERO bytes at the file's archive path — stored files are
 * never legitimately empty (the upload path rejects empty files), so a
 * 0-byte entry where files.csv reports size_bytes > 0 unambiguously marks
 * the loss, and the trailing manifest counts them. A storage ERROR
 * (transient R2 failure) still propagates — an archive that silently drops
 * bytes on a retried read would be a lie; a failed stream is retried by
 * the client.
 */
async function loadFileBytes(storage: StorageAdapter, r2Key: string): Promise<Uint8Array | null> {
  try {
    ensureVaultKey(r2Key)
  } catch {
    return null
  }
  const stored = await storage.get(r2Key)
  if (!stored) return null
  const reader = stored.stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}

/**
 * The documents export job — the PluginExportJob the factory hands the
 * registry (closing over the SAME injected port the routes use, the T4/T5
 * seam). Per archive: one batched D1 round trip (the 'plugin_exported'
 * lifecycle receipt FIRST, then the keyset document page), one file-rows
 * query, a continuation probe only when the page outcome needs it, and at
 * most `maxFiles` port reads — those as the body drains, not up front. The
 * receipt rides the CORE audit table (household_plugin_audit — 0036 widened
 * the CHECK for it) exactly like the purge job's plugin_purged completion
 * receipt: plugin code writing core's audit is the established T5 pattern.
 */
export function createDocumentsExportJob(storage: StorageAdapter): PluginExportJob {
  return async ({ db, householdId, actorUserId, cursor, maxFiles }) => {
    // A wiring mistake, not a runtime state: a budget below the per-document
    // maximum could never fit a single 20-file document, stalling the
    // sequence forever (the purge job's identical floor guard).
    if (maxFiles < DOCUMENT_MAX_FILES) {
      throw new Error(
        `export budget ${maxFiles} is below the per-document maximum of ${DOCUMENT_MAX_FILES} files — a whole document could never fit`
      )
    }

    const cursorRow = cursor ? decodeCursor(cursor) : null
    if (cursor && !cursorRow) {
      // The contract-level refusal (mapped to 400 by the core route) — an
      // unparseable cursor is tampering or truncation, not a restart signal.
      throw new PluginExportCursorError('Unknown export cursor')
    }
    if (cursorRow && cursorRow.household_id !== householdId) {
      // A cursor from another household (a stale tab after a household
      // switch, say): refuse rather than silently export a wrong slice.
      throw new PluginExportCursorError('Export cursor belongs to another household')
    }

    // The receipt FIRST + the keyset document page, one batch (one D1
    // subrequest; D1 serializes the statements, the receipt commits with
    // the page it describes). The receipt names the owner — the route is
    // requireOwner-gated, so actorUserId IS the owner.
    const after = cursorRow ? { created_at: cursorRow.created_at, id: cursorRow.id } : null
    const batchResults = (await db.batch([
      db
        .prepare(
          `INSERT INTO household_plugin_audit (id, household_id, plugin_id, actor_user_id, action)
           VALUES (?, ?, ?, ?, 'plugin_exported')`
        )
        .bind(crypto.randomUUID(), householdId, documentsManifest.id, actorUserId),
      db
        .prepare(
          `SELECT d.id, d.created_at, d.household_id, d.member_id, d.name,
                  d.uploaded_by, d.expires_on, d.remind_days_before
             FROM documents d
            WHERE d.household_id = ?
              AND (? IS NULL OR d.created_at > ? OR (d.created_at = ? AND d.id > ?))
            ORDER BY d.created_at ASC, d.id ASC
            LIMIT ?`
        )
        .bind(
          householdId,
          after?.created_at ?? null,
          after?.created_at ?? null,
          after?.created_at ?? null,
          after?.id ?? null,
          DOC_PAGE_MAX
        ),
    ])) as Array<{ results?: Array<Record<string, unknown>> }>
    const docRows = (batchResults[1]?.results ?? []) as Array<{
      id: string
      created_at: string
      household_id: string
      member_id: string | null
      name: string
      uploaded_by: string
      expires_on: string | null
      remind_days_before: number | null
    }>

    // The page's file rows, complete (one IN query, ≤ 50 parameters).
    const filesByDoc = new Map<string, ExportFileRow[]>()
    if (docRows.length > 0) {
      const { results } = await db
        .prepare(
          `SELECT f.id, f.document_id, f.r2_key, f.file_name, f.size_bytes, f.content_type,
                  f.label, f.sort_order, f.sha256, f.uploaded_by, f.uploaded_at
             FROM document_files f
            WHERE f.document_id IN (${docRows.map(() => '?').join(', ')})
            ORDER BY f.document_id ASC, f.sort_order ASC, f.id ASC`
        )
        .bind(...docRows.map((doc) => doc.id))
        .all<ExportFileRow>()
      for (const row of results) {
        const list = filesByDoc.get(row.document_id) ?? []
        list.push(row)
        filesByDoc.set(row.document_id, list)
      }
    }

    // WHOLE documents only, oldest-first, until one more would exceed the
    // file budget. The tail stays for the next archive (the cursor advances
    // past INCLUDED documents only — a partial page cannot strand half a
    // document, and with maxFiles ≥ DOCUMENT_MAX_FILES at least one document
    // always fits: no stall is reachable).
    const included: typeof docRows = []
    let pageFileCount = 0
    let trimmed = false
    for (const doc of docRows) {
      const docFiles = filesByDoc.get(doc.id) ?? []
      if (pageFileCount + docFiles.length > maxFiles) {
        trimmed = true
        break
      }
      included.push(doc)
      pageFileCount += docFiles.length
    }

    // Continuation: a trimmed page has its excluded document IN the page
    // (next cursor, no probe); an untrimmed FULL page might have a 51st
    // document (one probe); an untrimmed short page is keyset exhaustion
    // (no cursor, no probe). Worst-case spend stays ≤ 45 subrequests.
    const last = included[included.length - 1] ?? null
    let nextCursor: string | null = null
    if (last && (trimmed || docRows.length === DOC_PAGE_MAX)) {
      const probe = await db
        .prepare(
          `SELECT 1 FROM documents d
            WHERE d.household_id = ?
              AND (d.created_at > ? OR (d.created_at = ? AND d.id > ?))
            LIMIT 1`
        )
        .bind(householdId, last.created_at, last.created_at, last.id)
        .first<{ 1: number }>()
      if (probe) {
        nextCursor = encodeCursor({
          household_id: householdId,
          created_at: last.created_at,
          id: last.id,
        })
      }
    }

    // The archive: byte entries with LAZY loaders (each R2 get + body read
    // happens as the response drains; peak memory = one file), then the two
    // CSVs (built from the metadata already in hand), then manifest.json
    // LAST — its loader runs after every file loader, so its counts report
    // what the stream ACTUALLY delivered, not what was planned.
    const generatedAt = new Date()
    const delivered = { files: 0, missing: 0, bytes: 0 }

    const entries: ZipEntry[] = []
    for (const doc of included) {
      for (const file of filesByDoc.get(doc.id) ?? []) {
        const path = archivePath(doc.id, file)
        entries.push({
          name: path,
          data: async () => {
            const bytes = await loadFileBytes(storage, file.r2_key)
            if (bytes === null) {
              delivered.missing++
              return new Uint8Array(0)
            }
            delivered.files++
            delivered.bytes += bytes.byteLength
            return bytes
          },
          modified: parseSqliteDate(file.uploaded_at) ?? generatedAt,
        })
      }
    }

    entries.push(
      {
        name: 'documents.csv',
        data: new TextEncoder().encode(
          csvTable(
            [
              'id',
              'household_id',
              'member_id',
              'name',
              'uploaded_by',
              'created_at',
              'expires_on',
              'remind_days_before',
            ],
            included.map((doc) => [
              doc.id,
              doc.household_id,
              doc.member_id,
              doc.name,
              doc.uploaded_by,
              doc.created_at,
              doc.expires_on,
              doc.remind_days_before,
            ])
          )
        ),
        modified: generatedAt,
      },
      {
        name: 'files.csv',
        data: new TextEncoder().encode(
          csvTable(
            [
              'id',
              'document_id',
              'archive_path',
              'file_name',
              'content_type',
              'size_bytes',
              'label',
              'sort_order',
              'sha256',
              'uploaded_by',
              'uploaded_at',
            ],
            included.flatMap((doc) =>
              (filesByDoc.get(doc.id) ?? []).map((file) => [
                file.id,
                doc.id,
                archivePath(doc.id, file),
                file.file_name,
                file.content_type,
                file.size_bytes,
                file.label,
                file.sort_order,
                file.sha256,
                file.uploaded_by,
                file.uploaded_at,
              ])
            )
          )
        ),
        modified: generatedAt,
      },
      {
        name: 'manifest.json',
        // LAZY: the manifest's counts are the stream's DELIVERED truth, so
        // the encode runs when the writer pulls this (last) entry — after
        // every byte loader resolved. An eager encode would capture the
        // tallies at zero.
        data: () =>
          new TextEncoder().encode(
            JSON.stringify(
              {
                format: 'rumaq-plugin-export',
                format_version: 1,
                plugin: {
                  id: documentsManifest.id,
                  name: documentsManifest.name,
                  version: documentsManifest.version,
                },
                household_id: householdId,
                generated_at: generatedAt.toISOString(),
                // files = byte entries that delivered real bytes; a 0-byte
                // entry where files.csv reports size_bytes > 0 marks bytes
                // that were unavailable at export time (missing or
                // namespace-guarded keys — the half-dead-vault case).
                archive: {
                  documents: included.length,
                  files: delivered.files,
                  missing_files: delivered.missing,
                  bytes: delivered.bytes,
                },
                next_cursor: nextCursor,
              },
              null,
              2
            ) + '\n'
          ),
        modified: generatedAt,
      }
    )

    // The download name: ASCII by construction (the plugin id is a slug,
    // the timestamp is digits) — the Content-Disposition needs no RFC 5987
    // escaping beyond the helper's own.
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp =
      generatedAt.getUTCFullYear() +
      pad(generatedAt.getUTCMonth() + 1) +
      pad(generatedAt.getUTCDate()) +
      '-' +
      pad(generatedAt.getUTCHours()) +
      pad(generatedAt.getUTCMinutes()) +
      pad(generatedAt.getUTCSeconds())
    const filename = `rumaq-${documentsManifest.id}-export-${stamp}.zip`

    return {
      stream: zipStream(entries),
      filename,
      disposition: contentDisposition('attachment', filename),
      nextCursor,
    } satisfies PluginExportArchive
  }
}
