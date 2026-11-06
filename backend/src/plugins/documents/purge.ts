// The documents plugin's purge job (ahaqqu/RumaQ#439 — plugin architecture
// ticket 5, docs/plan/plugin-architecture.md §3.4). One CHUNK of one
// household's vault purge per call: bytes-before-rows, idempotent per
// document, resumable from the enablement row's cursor. The core driver
// (lib/plugin-purge.ts) owns WHEN (the nightly cron tick / the
// household-dissolution drain) and the subrequest budget; this module owns
// HOW — and the HOW is where the ticket's data-safety invariant lives:
//
//   THE KEYS COME FROM THE INDEX BEFORE ANY ROWS GO. The storage port has no
//   `list` BY DESIGN ("the D1 index owns listing", ports/storage/index.ts) —
//   document_files.r2_key is the ONLY record of where a household's bytes
//   live. documents.household_id is ON DELETE CASCADE (0022/0025), so if the
//   cascade ever ran before the bytes, the keys would be gone with the rows
//   and the objects would be orphaned forever (unreachable, unfindable,
//   unbilled-to-zero). Every chunk therefore reads the keys from
//   document_files, deletes each object through the injected port, and only
//   then deletes the rows — the same order deleteDocument already uses, now
//   as a resumable job. plugin_purged is written ONCE, at completion — never
//   at the start (§3.4's lifecycle table).

import { ensureVaultKey, DOCUMENT_MAX_FILES } from './lib.js'
import type { StorageAdapter } from '../../ports/storage/index.js'
import type { PluginPurgeChunk, PluginPurgeJob } from '../types.js'

/** The purge state machine's row shape (migration 0035). */
type PurgeStateRow = {
  purge_state: 'pending' | 'running' | 'done' | null
  purge_cursor: string | null
}

/**
 * The chunk's document ceiling (independent of the object budget): the file
 * lookup is one `document_id IN (...)` query and D1 caps a statement at 100
 * bound parameters, so a chunk never reads more than 40 documents' keys in
 * one statement. The object budget (40 on the free plan) trims the chunk
 * further when files are plentiful; this ceiling bounds the parameter list
 * when they are not (40 zero-file documents cost zero subrequests but would
 * still need 40 IN-parameters).
 */
const CHUNK_DOC_MAX = 40

/** The resumability cursor (0035): the ordering key of the last PROCESSED
 * document. Keyset pagination over (created_at, id) — created_at alone can
 * tie (SQLite datetime('now') has second resolution; two uploads in one
 * second are legal), the id tiebreaker keeps the total order stable, and a
 * stable total order is what makes "resume from the cursor" exact instead
 * of approximate. Serialized as JSON on the enablement row (0035's
 * json_valid CHECK). */
type PurgeCursor = { created_at: string; id: string }

function parseCursor(raw: string | null): PurgeCursor | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as PurgeCursor).created_at === 'string' &&
      typeof (parsed as PurgeCursor).id === 'string'
    ) {
      return parsed as PurgeCursor
    }
  } catch {
    // Corrupted cursor → fall through: NULL semantics (restart from the
    // oldest document). Every step is idempotent — R2 delete of an
    // already-deleted key is a success, the row DELETE matches zero rows —
    // so a restart re-does work safely rather than skipping anything.
  }
  return null
}

function serializeCursor(cursor: PurgeCursor): string {
  return JSON.stringify({ created_at: cursor.created_at, id: cursor.id })
}

/**
 * The claim: pending → running. Advisory (the driver's work-set query is
 * the real gate) but it makes the drain window observable in the catalog
 * the moment the first chunk starts. A no-op when another tick already
 * claimed (changes = 0) — two concurrent ticks converge on the same
 * idempotent chunk work, so no lease exists to expire.
 */
const CLAIM_RUNNING_SQL = `UPDATE household_plugins SET purge_state = 'running'
WHERE household_id = ? AND plugin_id = ? AND purge_state = 'pending'`

/**
 * The chunk's key READ — the data-safety invariant's first half. Keyset
 * after the cursor, oldest-first (new documents land after the cursor even
 * if created mid-drain; the write gate blocks them during the drain
 * anyway). The (household_id, created_at, id) prefix of
 * idx_documents_household serves the seek in reverse; pinned by an EXPLAIN
 * in plugin-purge.test.ts. Exported for that pin (the ENABLEMENT_UPSERT_SQL
 * precedent — tests run the exact statement, not a transcription).
 */
export function documentPageSql(): string {
  return `SELECT d.id, d.created_at
  FROM documents d
 WHERE d.household_id = ?
   AND (? IS NULL OR d.created_at > ? OR (d.created_at = ? AND d.id > ?))
 ORDER BY d.created_at ASC, d.id ASC
 LIMIT ?`
}

/**
 * The completion batch (plugin_purged — once, at completion, never at the
 * start): the receipt FIRST with the pre-state guard (the AUDIT_INSERT_SQL
 * pattern from the enablement writer — D1 serializes the batch, not the
 * surrounding read, so the guard inside the batch is the only thing standing
 * between one purge and a doubled receipt), then the guarded 'done'
 * transition, the cursor re-seek clearance, and the plugin-owned audit
 * trail's own cleanup. The receipt / transition / cleanup share one
 * predicate — pre-state pending/running AND zero documents left — so they
 * commit or no-op as one; the cursor clearance is guarded on the state
 * alone so the defeat path (below) re-seeks from the oldest.
 *
 * THE `drained` DECISION (P1-A1, PR #474 review) is the data-safety crux:
 * the empty doc page is a keyset read (rows AFTER the cursor only) while
 * `zeroDocsLeft` counts the WHOLE household — they can disagree (an upload
 * whose body was in flight when the drain started commits mid-drain — the
 * in-statement write guard refuses it; two same-second commits plus
 * random-UUID ordering can also skip a smaller-id document past the cursor
 * permanently). On disagreement every guarded statement no-ops, and
 * reporting `drained: true` anyway would let the dissolution drain return
 * complete and let the cascade erase the surviving document's rows — its
 * r2_key with it — while the bytes live. So `drained` is DERIVED from the
 * batch's actual effect: the done-UPDATE's meta.changes = 1 → the
 * transition committed → drained; = 0 → read the row back — 'done' is the
 * legitimate nightly replay (drained), pending/running means the guard was
 * defeated → `drained: false` AND the cursor is cleared (the 3rd
 * statement) so the before-cursor escape is re-scanned from the oldest on
 * the very next chunk. The forbidden direction — a `drained` report with
 * documents still alive — is unreachable by construction.
 *
 * The receipt's actor is the household_plugins row's purge_requested_by —
 * the owner who typed the confirmation — copied onto the one record that
 * outlives the household (0032's plain handles; the enablement row itself
 * dies in the dissolution cascade). Absent initiator → NULL: the receipt is
 * still written, the system-actor row 0032 anticipated.
 */
function completionStatements(db: D1Database, householdId: string, pluginId: string) {
  const zeroDocsLeft = `NOT EXISTS (SELECT 1 FROM documents WHERE household_id = ?)`
  return [
    db
      .prepare(
        `INSERT INTO household_plugin_audit (id, household_id, plugin_id, actor_user_id, action)
 SELECT ?, ?, ?,
        (SELECT purge_requested_by FROM household_plugins WHERE household_id = ? AND plugin_id = ?),
        'plugin_purged'
 WHERE (SELECT purge_state FROM household_plugins WHERE household_id = ? AND plugin_id = ?)
         IN ('pending', 'running')
   AND ${zeroDocsLeft}`
      )
      .bind(
        crypto.randomUUID(),
        householdId,
        pluginId,
        householdId,
        pluginId,
        householdId,
        pluginId,
        householdId
      ),
    // The transition — meta.changes on THIS statement is the `drained` truth.
    db
      .prepare(
        `UPDATE household_plugins
            SET purge_state = 'done', purge_cursor = NULL, purge_completed_at = datetime('now')
          WHERE household_id = ? AND plugin_id = ?
            AND purge_state IN ('pending', 'running')
            AND ${zeroDocsLeft}`
      )
      .bind(householdId, pluginId, householdId),
    // The re-seek clearance: fires ONLY on the defeat path (pending/running
    // with documents still present) — on a committed transition the cursor
    // is already NULL above, and a 'done' replay no-ops on the state guard.
    db
      .prepare(
        `UPDATE household_plugins SET purge_cursor = NULL
          WHERE household_id = ? AND plugin_id = ?
            AND purge_state IN ('pending', 'running')`
      )
      .bind(householdId, pluginId),
    db
      .prepare(`DELETE FROM document_audit WHERE household_id = ? AND ${zeroDocsLeft}`)
      .bind(householdId, householdId),
  ]
}

/**
 * The documents purge job — the PluginPurgeJob implementation the factory
 * hands the registry (one per composed plugin, closing over the injected
 * storage port; bytes go through the port, never inline R2 — §4.1
 * forbidden-4, the T4 seam this ticket deletes through).
 */
export function createDocumentsPurgeJob(storage: StorageAdapter): PluginPurgeJob {
  return async ({ db, householdId, maxObjects }): Promise<PluginPurgeChunk> => {
    // A chunk deletes WHOLE documents only — splitting one across chunks
    // would mean rows outliving some of their bytes. The per-document file
    // cap is 20 (DOCUMENT_MAX_FILES, #422), so any budget below it could
    // stall forever on one file-heavy document: that is a wiring mistake,
    // not a runtime state — fail the way a missing port does.
    if (maxObjects < DOCUMENT_MAX_FILES) {
      throw new Error(
        `purge budget ${maxObjects} is below the per-document maximum of ${DOCUMENT_MAX_FILES} files — a whole document could never fit`
      )
    }

    // The state read + claim: one guarded UPDATE makes 'running' visible (a
    // pending row claims itself; a running row is a no-op). The read-back
    // doubles as the cursor source — one PK-prefix seek.
    await db.prepare(CLAIM_RUNNING_SQL).bind(householdId, 'documents').run()
    const stateRow = await db
      .prepare(
        `SELECT purge_state, purge_cursor FROM household_plugins
          WHERE household_id = ? AND plugin_id = ?`
      )
      .bind(householdId, 'documents')
      .first<PurgeStateRow>()
    if (!stateRow) {
      // No enablement row (dissolution cascade already ran, say): nothing to
      // drain, nothing to receipt. The drain caller treats this as done.
      return { objects: 0, drained: true }
    }

    const cursor = parseCursor(stateRow.purge_cursor)
    // The key READ (invariant's first half): the doc page after the cursor.
    const docPage = await db
      .prepare(documentPageSql())
      .bind(
        householdId,
        cursor?.created_at ?? null,
        cursor?.created_at ?? null,
        cursor?.created_at ?? null,
        cursor?.id ?? null,
        CHUNK_DOC_MAX
      )
      .all<{ id: string; created_at: string }>()
    const docs = docPage.results

    if (docs.length === 0) {
      // Nothing after the cursor — CANDIDATE for completion, but the batch's
      // own whole-household guard decides (P1-A1): the keyset read sees only
      // post-cursor rows, so a document the cursor can never reach (an
      // in-flight upload that committed mid-drain past the write gate's
      // read, or a same-second commit the random-UUID ordering skipped)
      // defeats every guarded statement here. Derive `drained` from the
      // done-UPDATE's meta.changes, never from the read.
      const results = (await db.batch(
        completionStatements(db, householdId, 'documents')
      )) as Array<{ meta?: { changes?: number } }>
      const transitioned = (results[1]?.meta?.changes ?? 0) > 0
      if (transitioned) {
        return { objects: 0, drained: true }
      }
      // changes = 0: either the legitimate replay (state already 'done') or
      // the defeat path (documents exist). One PK-prefix seek disambiguates.
      const after = await db
        .prepare(
          `SELECT purge_state FROM household_plugins
            WHERE household_id = ? AND plugin_id = ?`
        )
        .bind(householdId, 'documents')
        .first<{ purge_state: string | null }>()
      if (after?.purge_state === 'done') {
        return { objects: 0, drained: true }
      }
      // Guard defeated: the cursor clearance in the batch already reset the
      // re-seek — refuse the drain so the caller retries (the nightly tick's
      // next night, the dissolution drain's next loop) and the escaped
      // document is found from the oldest. NEVER report drained here.
      return { objects: 0, drained: false }
    }

    // The keys, per document (invariant's first half, continued): one IN
    // query — ≤ 40 parameters, inside D1's 100-parameter statement limit.
    const filePage = await db
      .prepare(
        `SELECT document_id, r2_key FROM document_files
          WHERE document_id IN (${docs.map(() => '?').join(', ')})`
      )
      .bind(...docs.map((doc) => doc.id))
      .all<{ document_id: string; r2_key: string }>()
    const keysByDoc = new Map<string, string[]>()
    for (const row of filePage.results) {
      const keys = keysByDoc.get(row.document_id) ?? []
      keys.push(row.r2_key)
      keysByDoc.set(row.document_id, keys)
    }

    // The budget trim: whole documents front-to-back until one more would
    // exceed maxObjects. Zero-file documents cost nothing and always fit;
    // the trimmed tail stays for the next chunk (the cursor only ever
    // advances past PROCESSED documents — partial chunks cannot strand a
    // half-processed document).
    const processed: typeof docs = []
    let objects = 0
    for (const doc of docs) {
      const docKeys = keysByDoc.get(doc.id) ?? []
      if (objects + docKeys.length > maxObjects) break
      processed.push(doc)
      objects += docKeys.length
    }
    if (processed.length === 0) {
      // Unreachable with maxObjects ≥ DOCUMENT_MAX_FILES (a single document
      // fits by construction); the guard exists so the invariant below can
      // never be argued away by a future edit.
      throw new Error('purge chunk trimmed to zero documents — budget accounting bug')
    }

    // BYTES BEFORE ROWS — the invariant's second half. Every key goes
    // through the vault-key guard (a corrupted r2_key must never delete a
    // sibling namespace's object — review B1 of #388) and through the port,
    // in doc/file order, BEFORE the batch below touches a single row. R2
    // delete of an already-deleted key succeeds: a crash between this loop
    // and the batch replays harmlessly on resume.
    for (const doc of processed) {
      for (const key of keysByDoc.get(doc.id) ?? []) {
        ensureVaultKey(key)
        await storage.delete(key)
      }
    }

    // The rows, one batch (one D1 subrequest): each document's DELETE keeps
    // the household predicate (belt-and-braces — the household cascade must
    // never be the thing that erased these), and the cursor advances past
    // the LAST processed document only after the deletes sit in the same
    // transaction. A failed batch rolls both back: the next invocation
    // re-reads the same window and replays the (idempotent) deletes.
    await db.batch([
      ...processed.map((doc) =>
        db
          .prepare('DELETE FROM documents WHERE id = ? AND household_id = ?')
          .bind(doc.id, householdId)
      ),
      db
        .prepare(
          `UPDATE household_plugins SET purge_cursor = ?
            WHERE household_id = ? AND plugin_id = ?
              AND purge_state IN ('pending', 'running')`
        )
        .bind(
          serializeCursor({
            created_at: processed[processed.length - 1].created_at,
            id: processed[processed.length - 1].id,
          }),
          householdId,
          'documents'
        ),
    ])

    return { objects, drained: false }
  }
}
