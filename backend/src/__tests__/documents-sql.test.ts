import { describe, it, expect } from 'vite-plus/test'
// Real-SQL coverage for the document vault (ahaqqu/RumaQ#422 rework of the
// #388 MVP), following the households-sql.test.ts pattern: the route tests
// route a fake D1 on SQL fragments — good for HTTP shapes, blind to actual
// storage behavior. This file runs the SAME statements the lib runs against a
// real SQLite engine (node:sqlite — D1 is SQLite) through the full migration
// chain, so the security-relevant semantics cannot drift from the schema:
//
//   - the household scope predicate: a foreign household's document is
//     invisible to every lookup (list, get, delete),
//   - the member relation accepts BOTH modes (linked + profile-only, 0021)
//     through the same surrogate id,
//   - the name search (#422): case-insensitive contains, LIKE metacharacters
//     stay literal,
//   - the 20-files-per-document cap and per-file bookkeeping (sort_order,
//     optional label, per-file audit),
//   - the deletion flows leave no orphans: objects gone, rows gone, and the
//     audit records survive the rows (and files) they name.
//
// The backend tsconfig pins `types` to @cloudflare/workers-types, so Node
// builtin imports carry no declarations — same contained suppressions as
// migrations.test.ts.
// @ts-expect-error — no node types in this tsconfig
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error — no node types in this tsconfig
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error — no node types in this tsconfig
import { join, dirname } from 'node:path'
// @ts-expect-error — no node types in this tsconfig
import { fileURLToPath } from 'node:url'

import {
  addDocumentFile,
  createDocument,
  daysUntil,
  deleteDocument,
  deleteDocumentFile,
  getDocumentFileRow,
  getDocumentRow,
  getDocumentWithFiles,
  listDocuments,
  listDocumentFiles,
  listDueDocumentReminders,
  recordDocumentAccess,
  resolveExpiryUpdate,
  updateDocumentExpiry,
  isHouseholdMember,
  DocumentForbiddenError,
  DocumentNotFoundError,
  DocumentTooManyFilesError,
  DOCUMENT_MAX_FILES,
  DEFAULT_REMIND_DAYS_BEFORE,
} from '../lib/documents.js'
import { createR2StorageAdapter } from '../lib/storage.js'
import { createDocumentsStub } from './support/env.js'

type Db = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number }
    get(...params: unknown[]): Record<string, unknown> | undefined
    all(...params: unknown[]): Array<Record<string, unknown>>
  }
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations')

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name: string) => name.endsWith('.sql'))
    .sort()
}

// A D1-shaped adapter over node:sqlite — only the surface the vault lib uses:
// prepare().bind().first/all/run and batch(), wrapped in a transaction so the
// delete batch's atomicity claim is exercised, not assumed.
function createD1Adapter(sqlite: Db): D1Database {
  const runBound = (sql: string, params: unknown[]) => {
    const info = sqlite.prepare(sql).run(...params)
    return { meta: { changes: info.changes } }
  }
  return {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: async <T>() => (sqlite.prepare(sql).get(...params) as T | undefined) ?? null,
        all: async <T>() => ({ results: sqlite.prepare(sql).all(...params) as T[] }),
        run: async () => runBound(sql, params),
      }),
    }),
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const stmt of stmts) {
          results.push(await stmt.run())
        }
        sqlite.exec('COMMIT')
        return results
      } catch (err) {
        sqlite.exec('ROLLBACK')
        throw err
      }
    },
  } as unknown as D1Database
}

function createDb(): { sqlite: Db; d1: D1Database } {
  const sqlite = new DatabaseSync(':memory:') as unknown as Db
  for (const file of migrationFiles()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  return { sqlite, d1: createD1Adapter(sqlite) }
}

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])

describe('documents vault semantics (real SQL)', () => {
  it('creates a named document with its first file, relates BOTH member modes, and lists scoped with files in upload order', async () => {
    const { sqlite, d1 } = createDb()
    const storage = createR2StorageAdapter(createDocumentsStub() as unknown as R2Bucket)

    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u2', 'b@c.com')").run()
    sqlite
      .prepare(
        `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
      )
      .run()
    sqlite
      .prepare(`INSERT INTO households (id, name, created_by) VALUES ('h2', 'Rumah Lain', 'u2')`)
      .run()
    sqlite
      .prepare(
        `INSERT INTO household_members (id, household_id, user_id, role)
         VALUES ('m-linked', 'h1', 'u1', 'owner')`
      )
      .run()
    // Mode B: the toddler with no account — the vault's core use case.
    sqlite
      .prepare(
        `INSERT INTO household_members (id, household_id, user_id, role, display_name, birth_date)
         VALUES ('m-toddler', 'h1', NULL, 'member', 'Adik', '2025-03-02')`
      )
      .run()

    // The relation check accepts both modes through the same surrogate id.
    expect(await isHouseholdMember(d1, 'h1', 'm-linked')).toBe(true)
    expect(await isHouseholdMember(d1, 'h1', 'm-toddler')).toBe(true)
    expect(await isHouseholdMember(d1, 'h1', 'm-other')).toBe(false)

    const linkedDoc = await createDocument(d1, storage, {
      householdId: 'h1',
      memberId: 'm-toddler',
      name: 'Akta Lahir Adik',
      file: {
        fileName: 'akta-adik.pdf',
        bytes: PDF_BYTES,
        mime: 'application/pdf',
        label: 'Halaman 1',
      },
      uploadedBy: 'u1',
    })
    const linkedMeta = await createDocument(d1, storage, {
      householdId: 'h1',
      memberId: 'm-linked',
      name: 'ktp bapak',
      file: { fileName: 'ktp-bapak.jpg', bytes: JPEG_BYTES, mime: 'image/jpeg', label: null },
      uploadedBy: 'u1',
    })
    const otherHouse = await createDocument(d1, storage, {
      householdId: 'h2', // the other household's own document
      memberId: null,
      name: 'Paspor',
      file: { fileName: 'paspor.pdf', bytes: PDF_BYTES, mime: 'application/pdf', label: null },
      uploadedBy: 'u2',
    })

    // The create payload: name + first file at sort_order 1 with its optional
    // label; r2_key never leaves the lib.
    expect(linkedDoc).toMatchObject({
      name: 'Akta Lahir Adik',
      member_id: 'm-toddler',
      files: [{ file_name: 'akta-adik.pdf', sort_order: 1, label: 'Halaman 1' }],
    })
    expect(JSON.stringify(linkedDoc)).not.toContain('r2_key')

    // The DEFAULT-owned timestamps are REAL (review A1 #422): both INSERTs
    // omit the columns so datetime('now') fills them — a bound '' would store
    // '' silently, which is exactly the bug the route fake cannot see.
    const storedDoc = sqlite
      .prepare('SELECT created_at FROM documents WHERE id = ?')
      .get(linkedDoc.id)
    expect(String(storedDoc?.created_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    const storedFile = sqlite
      .prepare('SELECT uploaded_at FROM document_files WHERE document_id = ?')
      .get(linkedDoc.id)
    expect(String(storedFile?.uploaded_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

    // Full listing for h1 — only its two documents, newest first, files in
    // upload order. Same-second inserts share created_at (D1's datetime('now')
    // granularity), so pin distinct timestamps before asserting the order.
    sqlite
      .prepare('UPDATE documents SET created_at = ? WHERE id = ?')
      .run('2026-11-04 10:00:00', linkedDoc.id)
    sqlite
      .prepare('UPDATE documents SET created_at = ? WHERE id = ?')
      .run('2026-11-04 11:00:00', linkedMeta.id)
    const all = await listDocuments(d1, 'h1')
    expect(all.map((d) => d.id)).toEqual([linkedMeta.id, linkedDoc.id])
    expect(all[1]?.files).toHaveLength(1)
    expect(all[1]?.files[0]).toMatchObject({ sort_order: 1, label: 'Halaman 1' })

    // The member filter works for both modes.
    const byToddler = await listDocuments(d1, 'h1', { memberId: 'm-toddler' })
    expect(byToddler.map((d) => d.id)).toEqual([linkedDoc.id])
    const byLinked = await listDocuments(d1, 'h1', { memberId: 'm-linked' })
    expect(byLinked.map((d) => d.id)).toEqual([linkedMeta.id])

    // The household scope: h2 sees only its own document.
    const otherHousehold = await listDocuments(d1, 'h2')
    expect(otherHousehold).toHaveLength(1)
    expect(otherHousehold[0]?.household_id).toBe('h2')
    expect(otherHousehold[0]?.files[0]?.file_name).toBe('paspor.pdf')

    // The scoped single lookup answers null across households — the 404
    // before any authz answer.
    expect(await getDocumentWithFiles(d1, 'h2', linkedDoc.id)).toBeNull()
    expect(await getDocumentRow(d1, 'h2', linkedDoc.id)).toBeNull()
    expect(await getDocumentWithFiles(d1, 'h1', linkedDoc.id)).not.toBeNull()
    void otherHouse
  })

  it('q search: case-insensitive contains on the name; LIKE metacharacters stay literal (#422)', async () => {
    const { sqlite, d1 } = createDb()
    const storage = createR2StorageAdapter(createDocumentsStub() as unknown as R2Bucket)

    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    sqlite
      .prepare(
        `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
      )
      .run()

    const kk = await createDocument(d1, storage, {
      householdId: 'h1',
      memberId: null,
      name: 'Kartu Keluarga',
      file: { fileName: 'kk.jpg', bytes: JPEG_BYTES, mime: 'image/jpeg', label: null },
      uploadedBy: 'u1',
    })
    const akta = await createDocument(d1, storage, {
      householdId: 'h1',
      memberId: null,
      name: 'akta lahir adik',
      file: { fileName: 'akta.pdf', bytes: PDF_BYTES, mime: 'application/pdf', label: null },
      uploadedBy: 'u1',
    })
    const odd = await createDocument(d1, storage, {
      householdId: 'h1',
      memberId: null,
      name: '50% off receipt',
      file: { fileName: 'odd.jpg', bytes: JPEG_BYTES, mime: 'image/jpeg', label: null },
      uploadedBy: 'u1',
    })
    const fifty = await createDocument(d1, storage, {
      householdId: 'h1',
      memberId: null,
      name: '50x off receipt',
      file: { fileName: 'fifty.jpg', bytes: JPEG_BYTES, mime: 'image/jpeg', label: null },
      uploadedBy: 'u1',
    })
    void kk
    void akta
    void fifty

    // Case-insensitive contains, needle in either case, mid-name.
    expect((await listDocuments(d1, 'h1', { q: 'ktp' })).map((d) => d.id)).toEqual([])
    expect((await listDocuments(d1, 'h1', { q: 'KELUARGA' })).map((d) => d.id)).toHaveLength(1)
    expect((await listDocuments(d1, 'h1', { q: 'lahir' })).map((d) => d.id)).toEqual([akta.id])
    // q composes with the member filter.
    expect(await listDocuments(d1, 'h1', { q: 'lahir', memberId: 'm-none' })).toEqual([])

    // % and _ are LITERAL: searching "50%" finds the percent name and never
    // the "50x" wildcard match.
    const pct = await listDocuments(d1, 'h1', { q: '50%' })
    expect(pct.map((d) => d.id)).toEqual([odd.id])
    const underscore = await listDocuments(d1, 'h1', { q: 'a_a' })
    expect(underscore).toEqual([])
  })

  it('add-file: sort_order climbs with uploads, the 20-file cap refuses #21 before any byte lands', async () => {
    const { sqlite, d1 } = createDb()
    const stub = createDocumentsStub()
    const storage = createR2StorageAdapter(stub as unknown as R2Bucket)

    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    sqlite
      .prepare(
        `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
      )
      .run()

    const doc = await createDocument(d1, storage, {
      householdId: 'h1',
      memberId: null,
      name: 'Buku Nika',
      file: { fileName: 'page-1.jpg', bytes: JPEG_BYTES, mime: 'image/jpeg', label: null },
      uploadedBy: 'u1',
    })

    // Pages 2..20 — the owner cap is 20 files per document.
    for (let i = 2; i <= DOCUMENT_MAX_FILES; i++) {
      const updated = await addDocumentFile(d1, storage, {
        householdId: 'h1',
        documentId: doc.id,
        file: {
          fileName: `page-${i}.jpg`,
          bytes: JPEG_BYTES,
          mime: 'image/jpeg',
          label: `Halaman ${i}`,
        },
        uploadedBy: 'u1',
      })
      expect(updated.files).toHaveLength(i)
    }
    expect(stub.objects.size).toBe(DOCUMENT_MAX_FILES)

    // Upload order is deterministic and matches the labels.
    const files = await listDocumentFiles(d1, doc.id)
    expect(files.map((f) => f.sort_order)).toEqual(
      Array.from({ length: DOCUMENT_MAX_FILES }, (_, i) => i + 1)
    )
    expect(files[19]?.label).toBe(`Halaman ${DOCUMENT_MAX_FILES}`)

    // Every write path got a REAL uploaded_at from the column DEFAULT (review
    // A1 #422) — the create's file #1 and all 19 add-file inserts alike; a
    // bound '' would have stored '' on every row.
    const uploadedAts = sqlite
      .prepare('SELECT uploaded_at FROM document_files WHERE document_id = ? ORDER BY sort_order')
      .all(doc.id)
    expect(uploadedAts).toHaveLength(DOCUMENT_MAX_FILES)
    for (const row of uploadedAts) {
      expect(String(row.uploaded_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    }

    // File #21 is refused BEFORE the storage put — the bucket stays at 20.
    await expect(
      addDocumentFile(d1, storage, {
        householdId: 'h1',
        documentId: doc.id,
        file: { fileName: 'page-21.jpg', bytes: JPEG_BYTES, mime: 'image/jpeg', label: null },
        uploadedBy: 'u1',
      })
    ).rejects.toBeInstanceOf(DocumentTooManyFilesError)
    expect(stub.objects.size).toBe(DOCUMENT_MAX_FILES)
    expect((await listDocumentFiles(d1, doc.id)).length).toBe(DOCUMENT_MAX_FILES)

    // The file-scoped audit rode every add: 20 'file_add' records naming the
    // exact file, plus the create's document-level 'upload'.
    const audit = sqlite.prepare('SELECT action, document_file_id FROM document_audit').all()
    expect(audit.filter((a) => a.action === 'upload')).toHaveLength(1)
    const adds = audit.filter((a) => a.action === 'file_add')
    expect(adds).toHaveLength(DOCUMENT_MAX_FILES - 1)
    expect(new Set(adds.map((a) => a.document_file_id)).size).toBe(DOCUMENT_MAX_FILES - 1)

    // The scoped file lookup: the right file under the right document.
    const file = await getDocumentFileRow(d1, 'h1', doc.id, files[1]!.id)
    expect(file).toMatchObject({ sort_order: 2, label: 'Halaman 2' })
    expect(await getDocumentFileRow(d1, 'h2', doc.id, files[1]!.id)).toBeNull()
    expect(await getDocumentFileRow(d1, 'h1', 'doc-other', files[1]!.id)).toBeNull()
  })

  it('add-file cap is enforced INSIDE the batch: a stale pre-read cannot exceed the cap and leaves no orphan audit (review A2 #422)', async () => {
    const { sqlite, d1 } = createDb()
    const stub = createDocumentsStub()
    const storage = createR2StorageAdapter(stub as unknown as R2Bucket)

    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    sqlite
      .prepare(
        `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
      )
      .run()

    const doc = await createDocument(d1, storage, {
      householdId: 'h1',
      memberId: null,
      name: 'Buku Nika',
      file: { fileName: 'page-1.jpg', bytes: JPEG_BYTES, mime: 'image/jpeg', label: null },
      uploadedBy: 'u1',
    })
    // Fill to the cap directly — the end state a lost race lands on.
    const insertSeed = sqlite.prepare(
      `INSERT INTO document_files
         (id, document_id, r2_key, file_name, size_bytes, content_type, label, sort_order, sha256, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
    )
    for (let i = 2; i <= DOCUMENT_MAX_FILES; i++) {
      insertSeed.run(
        `f-${i}`,
        doc.id,
        `documents/h1/${doc.id}/f-${i}`,
        `page-${i}.jpg`,
        JPEG_BYTES.byteLength,
        'image/jpeg',
        i,
        'a'.repeat(64),
        'u1'
      )
    }

    // The race, simulated: the COUNT pre-read answers one slot short (the
    // value it had before a concurrent add committed), while the REAL table
    // the batch sees is already full. Single-threaded SQLite cannot interleave
    // the statements naturally, so the stale read is injected at the adapter —
    // exactly the window D1's concurrent execution opens.
    const staleD1 = {
      prepare: (sql: string) => {
        const inner = d1.prepare(sql)
        return {
          bind: (...params: unknown[]) => {
            const bound = inner.bind(...params)
            return {
              first: async <T>() => {
                if (/SELECT COUNT\(\*\) AS cnt FROM document_files/.test(sql)) {
                  return { cnt: DOCUMENT_MAX_FILES - 1 } as T
                }
                return bound.first<T>()
              },
              all: bound.all,
              run: bound.run,
            }
          },
        }
      },
      batch: (stmts: D1PreparedStatement[]) => d1.batch(stmts),
    } as unknown as D1Database

    // The pre-check passes on the stale count, but the guarded insert's
    // in-batch WHERE re-check sees the truth and inserts zero rows → 409.
    await expect(
      addDocumentFile(staleD1, storage, {
        householdId: 'h1',
        documentId: doc.id,
        file: { fileName: 'page-21.jpg', bytes: JPEG_BYTES, mime: 'image/jpeg', label: null },
        uploadedBy: 'u1',
      })
    ).rejects.toBeInstanceOf(DocumentTooManyFilesError)

    // Nothing leaked past the cap — and the guard-riding audit never wrote a
    // file_add record for the file that did not land. (The put happened
    // first — the documented unreferenced-object trade, unreachable by any
    // route; the stub holds it, no row names it.)
    expect(
      sqlite.prepare('SELECT COUNT(*) AS c FROM document_files WHERE document_id = ?').get(doc.id)
    ).toMatchObject({ c: DOCUMENT_MAX_FILES })
    expect(
      sqlite.prepare("SELECT COUNT(*) AS c FROM document_audit WHERE action = 'file_add'").get()
    ).toMatchObject({ c: 0 })
  })

  it('delete-file: object gone, row gone, file_delete audit survives naming the file; other files untouched', async () => {
    const { sqlite, d1 } = createDb()
    const stub = createDocumentsStub()
    const storage = createR2StorageAdapter(stub as unknown as R2Bucket)

    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u2', 'b@c.com')").run()
    sqlite
      .prepare(
        `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO household_members (id, household_id, user_id, role)
         VALUES ('m-owner', 'h1', 'u1', 'owner')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO household_members (id, household_id, user_id, role)
         VALUES ('m-plain', 'h1', 'u2', 'member')`
      )
      .run()

    const doc = await createDocument(d1, storage, {
      householdId: 'h1',
      memberId: null,
      name: 'KTP',
      file: { fileName: 'depan.jpg', bytes: JPEG_BYTES, mime: 'image/jpeg', label: 'Depan' },
      uploadedBy: 'u2', // a member added the first file
    })
    const first = (await listDocumentFiles(d1, doc.id))[0]!
    const docRow = await getDocumentRow(d1, 'h1', doc.id)
    expect(docRow).not.toBeNull()

    // An unknown caller (no membership) is a plain 404 — nothing changed.
    await expect(
      deleteDocumentFile(d1, storage, {
        householdId: 'h1',
        userId: 'u-ghost',
        document: docRow!,
        file: first,
      })
    ).rejects.toBeInstanceOf(DocumentNotFoundError)

    // delete-file authorization: the household OWNER may remove any file…
    await deleteDocumentFile(d1, storage, {
      householdId: 'h1',
      userId: 'u1', // owner, neither the document's nor the file's uploader
      document: docRow!,
      file: first,
    })
    expect(stub.deleted).toEqual([first.r2_key])
    expect(stub.objects.size).toBe(0)
    expect(await getDocumentFileRow(d1, 'h1', doc.id, first.id)).toBeNull()

    // …and the document's UPLOADER may too (u2 created the document below).
    const second = await addDocumentFile(d1, storage, {
      householdId: 'h1',
      documentId: doc.id,
      file: { fileName: 'belakang.jpg', bytes: JPEG_BYTES, mime: 'image/jpeg', label: null },
      uploadedBy: 'u1', // NOT the document uploader (u2), NOT an owner
    })
    const secondRow = (await listDocumentFiles(d1, doc.id))[0]!
    expect(secondRow.id).toBe(second.files[0]?.id)
    await deleteDocumentFile(d1, storage, {
      householdId: 'h1',
      userId: 'u2', // the document's uploader; someone else added the file
      document: docRow!,
      file: secondRow,
    })
    expect(stub.deleted).toEqual([first.r2_key, secondRow.r2_key])

    // The audit trail kept everything, including records about files that no
    // longer exist.
    const audit = sqlite.prepare('SELECT action, document_file_id FROM document_audit').all()
    const deletes = audit.filter((a) => a.action === 'file_delete')
    expect(deletes).toHaveLength(2)
    expect(new Set(deletes.map((a) => a.document_file_id))).toEqual(
      new Set([first.id, secondRow.id])
    )
  })

  it('delete-document: every object gone, rows cascade, the delete audit survives the row it names', async () => {
    const { sqlite, d1 } = createDb()
    const stub = createDocumentsStub()
    const storage = createR2StorageAdapter(stub as unknown as R2Bucket)

    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    sqlite
      .prepare(
        `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO household_members (id, household_id, user_id, role)
         VALUES ('m1', 'h1', 'u1', 'owner')`
      )
      .run()

    const doc = await createDocument(d1, storage, {
      householdId: 'h1',
      memberId: null,
      name: 'Kartu Anak',
      file: { fileName: 'kartu-anak.jpg', bytes: JPEG_BYTES, mime: 'image/jpeg', label: null },
      uploadedBy: 'u1',
    })
    await addDocumentFile(d1, storage, {
      householdId: 'h1',
      documentId: doc.id,
      file: { fileName: 'belakang.pdf', bytes: PDF_BYTES, mime: 'application/pdf', label: null },
      uploadedBy: 'u1',
    })
    expect(stub.objects.size).toBe(2)

    // Access records from earlier views ride along.
    const files = await listDocumentFiles(d1, doc.id)
    await recordDocumentAccess(d1, {
      documentId: doc.id,
      fileId: files[0]!.id,
      householdId: 'h1',
      actorUserId: 'u1',
      action: 'view',
    })
    await recordDocumentAccess(d1, {
      documentId: doc.id,
      fileId: files[0]!.id,
      householdId: 'h1',
      actorUserId: 'u1',
      action: 'download',
    })

    const row = await getDocumentRow(d1, 'h1', doc.id)
    expect(row).not.toBeNull()
    await deleteDocument(d1, storage, { householdId: 'h1', userId: 'u1', document: row! })

    // No orphan object, no orphan row — document_files cascaded with it.
    expect(stub.objects.size).toBe(0)
    expect(stub.deleted).toEqual(files.map((f) => f.r2_key))
    expect(await getDocumentRow(d1, 'h1', doc.id)).toBeNull()
    expect(await listDocuments(d1, 'h1')).toEqual([])
    expect(sqlite.prepare('SELECT COUNT(*) AS cnt FROM document_files').get()).toEqual({ cnt: 0 })

    // The audit trail keeps ALL of it — upload, file_add, view, download,
    // delete — including records about a document (and files) that no longer
    // exist. Same-second rows carry random ids, so the assertion is over the
    // multiset of actions, not their stored order.
    const audit = sqlite.prepare('SELECT action, document_id FROM document_audit').all()
    expect([...audit.map((a) => a.action)].sort()).toEqual(
      ['upload', 'file_add', 'view', 'download', 'delete'].sort()
    )
    expect(new Set(audit.map((a) => a.document_id))).toEqual(new Set([doc.id]))
  })

  it('delete authorization: a non-owner non-uploader member is forbidden, atomically', async () => {
    const { sqlite, d1 } = createDb()
    const stub = createDocumentsStub()
    const storage = createR2StorageAdapter(stub as unknown as R2Bucket)

    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u2', 'b@c.com')").run()
    sqlite
      .prepare(
        `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO household_members (id, household_id, user_id, role)
         VALUES ('m-owner', 'h1', 'u1', 'owner')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO household_members (id, household_id, user_id, role)
         VALUES ('m-plain', 'h1', 'u2', 'member')`
      )
      .run()

    const doc = await createDocument(d1, storage, {
      householdId: 'h1',
      memberId: null,
      name: 'Scan lainnya',
      file: { fileName: 'scan.jpg', bytes: JPEG_BYTES, mime: 'image/jpeg', label: null },
      uploadedBy: 'u1',
    })
    const row = await getDocumentRow(d1, 'h1', doc.id)
    expect(row).not.toBeNull()

    await expect(
      deleteDocument(d1, storage, { householdId: 'h1', userId: 'u2', document: row! })
    ).rejects.toBeInstanceOf(DocumentForbiddenError)

    // The forbidden attempt changed nothing.
    expect(stub.objects.size).toBe(1)
    expect(stub.deleted).toHaveLength(0)
    expect(await getDocumentRow(d1, 'h1', doc.id)).not.toBeNull()
    expect(
      sqlite.prepare("SELECT COUNT(*) AS cnt FROM document_audit WHERE action = 'delete'").get()
    ).toEqual({ cnt: 0 })

    // An unknown caller (no membership) is a plain 404.
    await expect(
      deleteDocument(d1, storage, { householdId: 'h1', userId: 'u-ghost', document: row! })
    ).rejects.toBeInstanceOf(DocumentNotFoundError)

    // The uploader can always delete their own upload.
    await deleteDocument(d1, storage, { householdId: 'h1', userId: 'u1', document: row! })
    expect(stub.objects.size).toBe(0)
  })

  it('member removal clears the relation but keeps the document and its files; household deletion cascades everything', async () => {
    const { sqlite, d1 } = createDb()
    const storage = createR2StorageAdapter(createDocumentsStub() as unknown as R2Bucket)

    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    sqlite
      .prepare(
        `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO household_members (id, household_id, user_id, role, display_name, birth_date)
         VALUES ('m-toddler', 'h1', NULL, 'member', 'Adik', '2025-03-02')`
      )
      .run()

    const doc = await createDocument(d1, storage, {
      householdId: 'h1',
      memberId: 'm-toddler',
      name: 'Akta Lahir',
      file: { fileName: 'akta.pdf', bytes: PDF_BYTES, mime: 'application/pdf', label: null },
      uploadedBy: 'u1',
    })
    await addDocumentFile(d1, storage, {
      householdId: 'h1',
      documentId: doc.id,
      file: { fileName: 'halaman-2.jpg', bytes: JPEG_BYTES, mime: 'image/jpeg', label: null },
      uploadedBy: 'u1',
    })

    // The toddler's member row is removed (owner action) — the document (and
    // its files' R2 objects) must survive with the link cleared, never
    // cascade-away.
    sqlite.prepare('DELETE FROM household_members WHERE id = ?').run('m-toddler')
    const afterMemberRemoval = await getDocumentRow(d1, 'h1', doc.id)
    expect(afterMemberRemoval).not.toBeNull()
    expect(afterMemberRemoval?.member_id).toBeNull()
    expect(await listDocuments(d1, 'h1', { memberId: 'm-toddler' })).toEqual([])
    expect((await listDocumentFiles(d1, doc.id)).length).toBe(2)

    // Household deletion cascades the documents AND their files AND the audit
    // trail (the household_id FKs) — nothing of that household lingers.
    sqlite.prepare('DELETE FROM households WHERE id = ?').run('h1')
    expect(sqlite.prepare('SELECT COUNT(*) AS cnt FROM documents').get()).toEqual({ cnt: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS cnt FROM document_files').get()).toEqual({ cnt: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS cnt FROM document_audit').get()).toEqual({ cnt: 0 })
  })
})

// Expiry & renewal reminders (#426): the date math lives in this file because
// `now` is an argument here — the exact boundaries (what counts as "within N
// days", the computed days_until_expiry, the due-set window) are pinned
// against real SQLite with a FIXED clock, immune to midnight races.
describe('documents expiry semantics (real SQL, fixed clock)', () => {
  // 2026-11-06 is the branch date; a fixed epoch keeps every boundary exact.
  const NOW = new Date('2026-11-06T09:30:00.000Z')
  const TODAY = '2026-11-06'

  function seedHousehold(): {
    sqlite: Db
    d1: D1Database
    storage: ReturnType<typeof createR2StorageAdapter>
  } {
    const { sqlite, d1 } = createDb()
    const storage = createR2StorageAdapter(createDocumentsStub() as unknown as R2Bucket)
    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    sqlite
      .prepare(
        `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
      )
      .run()
    sqlite
      .prepare(`INSERT INTO households (id, name, created_by) VALUES ('h2', 'Rumah Lain', 'u1')`)
      .run()
    return { sqlite, d1, storage }
  }

  function seedDocument(
    sqlite: Db,
    args: {
      id: string
      householdId?: string
      name?: string
      expiresOn?: string | null
      remindDaysBefore?: number | null
    }
  ): void {
    sqlite
      .prepare(
        `INSERT INTO documents (id, household_id, member_id, name, uploaded_by, expires_on, remind_days_before)
         VALUES (?, ?, NULL, ?, 'u1', ?, ?)`
      )
      .run(
        args.id,
        args.householdId ?? 'h1',
        args.name ?? 'KTP Bapak',
        args.expiresOn ?? null,
        args.remindDaysBefore ?? null
      )
  }

  it('persists the expiry metadata with its update audit record in one batch, and the read-back computes the distance', async () => {
    const { sqlite, d1, storage } = seedHousehold()
    const created = await createDocument(d1, storage, {
      householdId: 'h1',
      memberId: null,
      name: 'STNK Mobil',
      file: { fileName: 'stnk.pdf', bytes: PDF_BYTES, mime: 'application/pdf', label: null },
      uploadedBy: 'u1',
    })

    const updated = await updateDocumentExpiry(d1, {
      householdId: 'h1',
      documentId: created.id,
      actorUserId: 'u1',
      expiresOn: '2027-11-06',
      remindDaysBefore: 90,
      now: NOW,
    })

    // The stored row carries exactly what was written.
    const row = sqlite
      .prepare('SELECT expires_on, remind_days_before FROM documents WHERE id = ?')
      .get(created.id)
    expect(row).toEqual({ expires_on: '2027-11-06', remind_days_before: 90 })

    // The read-back computes days_until_expiry from the fixed clock — never a
    // stored column.
    expect(updated.expires_on).toBe('2027-11-06')
    expect(updated.remind_days_before).toBe(90)
    expect(updated.days_until_expiry).toBe(daysUntil('2027-11-06', TODAY))
    expect(updated.days_until_expiry).toBe(365) // 2026-11-06 → 2027-11-06

    // The audit trail records the metadata mutation. Same-second rows carry
    // random ids, so the assertion is over the action multiset + the
    // filtered row, never a stored order.
    const audit = sqlite.prepare('SELECT action, document_file_id FROM document_audit').all()
    expect([...audit.map((a: Record<string, unknown>) => a.action)].sort()).toEqual(
      ['update', 'upload'].sort()
    )
    const updateRow = sqlite
      .prepare('SELECT document_file_id FROM document_audit WHERE action = ?')
      .get('update')
    expect(updateRow).toMatchObject({ document_file_id: null })
  })

  it('resolveExpiryUpdate maintains the stored invariant across every accepted shape', () => {
    // Clearing takes the window with it.
    expect(
      resolveExpiryUpdate({ expires_on: '2027-01-01', remind_days_before: 90 }, { expiresOn: null })
    ).toEqual({ expiresOn: null, remindDaysBefore: null })
    // Fresh expiry without a window: the app-level 30 default.
    expect(
      resolveExpiryUpdate(
        { expires_on: null, remind_days_before: null },
        { expiresOn: '2027-01-01' }
      )
    ).toEqual({ expiresOn: '2027-01-01', remindDaysBefore: DEFAULT_REMIND_DAYS_BEFORE })
    // Fresh expiry with an explicit window.
    expect(
      resolveExpiryUpdate(
        { expires_on: null, remind_days_before: null },
        { expiresOn: '2027-01-01', remindDaysBefore: 14 }
      )
    ).toEqual({ expiresOn: '2027-01-01', remindDaysBefore: 14 })
    // Date correction keeps a chosen window.
    expect(
      resolveExpiryUpdate(
        { expires_on: '2027-01-01', remind_days_before: 90 },
        { expiresOn: '2028-02-02' }
      )
    ).toEqual({ expiresOn: '2028-02-02', remindDaysBefore: 90 })
    // Window-only PATCH applies to the existing expiry.
    expect(
      resolveExpiryUpdate(
        { expires_on: '2027-01-01', remind_days_before: 90 },
        { remindDaysBefore: 7 }
      )
    ).toEqual({ expiresOn: '2027-01-01', remindDaysBefore: 7 })
  })

  it('expiring_within filter: boundaries exact (horizon included, beyond excluded, expired included), scoped, expiry-ordered', async () => {
    const { sqlite, d1 } = createDb()

    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    sqlite
      .prepare(
        `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
      )
      .run()
    sqlite
      .prepare(`INSERT INTO households (id, name, created_by) VALUES ('h2', 'Rumah Lain', 'u1')`)
      .run()
    // The window: expiring_within=30 from 2026-11-06 → horizon 2026-12-06.
    seedDocument(sqlite, { id: 'doc-expired', name: 'SIM Lama', expiresOn: '2026-11-01' }) // 5 days ago — due
    seedDocument(sqlite, { id: 'doc-today', name: 'BPJS', expiresOn: TODAY }) // 0 days — due
    seedDocument(sqlite, { id: 'doc-edge', name: 'Paspor', expiresOn: '2026-12-06' }) // exactly the horizon — due
    seedDocument(sqlite, { id: 'doc-beyond', name: 'STNK', expiresOn: '2026-12-07' }) // horizon + 1 — NOT due
    seedDocument(sqlite, { id: 'doc-far', name: 'Akta', expiresOn: '2031-01-01' }) // years out — NOT due
    seedDocument(sqlite, { id: 'doc-nodate', name: 'Kartu Keluarga', expiresOn: null }) // no expiry — NOT due
    seedDocument(sqlite, {
      id: 'doc-other-hh',
      name: 'KTP Tetangga',
      householdId: 'h2',
      expiresOn: TODAY,
    }) // other household

    const within = await listDocuments(d1, 'h1', { expiringWithin: 30 }, NOW)
    expect(within.map((d) => d.id)).toEqual(['doc-expired', 'doc-today', 'doc-edge'])
    // Soonest-expiry-first (the expired one leads), tiebreakers stable.
    expect(within.map((d) => d.expires_on)).toEqual(['2026-11-01', TODAY, '2026-12-06'])

    // The computed distances: negative = expired, 0 = today, positive = ahead.
    expect(within.map((d) => d.days_until_expiry)).toEqual([-5, 0, 30])

    // A tighter window narrows the same set.
    const within3 = await listDocuments(d1, 'h1', { expiringWithin: 3 }, NOW)
    expect(within3.map((d) => d.id)).toEqual(['doc-expired', 'doc-today'])

    // The default listing (no filter) still shows everything, newest first,
    // with computed distances on the dated rows.
    const all = await listDocuments(d1, 'h1', {}, NOW)
    expect(all).toHaveLength(6)
    const nodate = all.find((d) => d.id === 'doc-nodate')
    expect(nodate).toMatchObject({
      expires_on: null,
      remind_days_before: null,
      days_until_expiry: null,
    })
    const today = all.find((d) => d.id === 'doc-today')
    expect(today?.days_until_expiry).toBe(0)

    // Household scoping held: h2's due document never leaks into h1's views.
    const h2 = await listDocuments(d1, 'h2', { expiringWithin: 30 }, NOW)
    expect(h2.map((d) => d.id)).toEqual(['doc-other-hh'])
  })

  it('due-set sweep: a document enters the set when the distance reaches its own window (default 30 when NULL)', async () => {
    const { sqlite, d1 } = createDb()
    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    sqlite
      .prepare(
        `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
      )
      .run()
    sqlite
      .prepare(`INSERT INTO households (id, name, created_by) VALUES ('h2', 'Rumah Lain', 'u1')`)
      .run()

    seedDocument(sqlite, {
      id: 'doc-win7',
      name: 'SIM',
      expiresOn: '2026-11-13',
      remindDaysBefore: 7,
    }) // 7 days out, window 7 — DUE (boundary)
    seedDocument(sqlite, {
      id: 'doc-win8',
      name: 'STNK',
      expiresOn: '2026-11-13',
      remindDaysBefore: 6,
    }) // 7 days out, window 6 — NOT
    seedDocument(sqlite, {
      id: 'doc-default',
      name: 'BPJS',
      expiresOn: '2026-12-06',
      remindDaysBefore: null,
    }) // 30 days out, NULL window → default 30 — DUE (boundary)
    seedDocument(sqlite, {
      id: 'doc-past-default',
      name: 'Paspor',
      expiresOn: '2026-12-07',
      remindDaysBefore: null,
    }) // 31 days out — NOT
    seedDocument(sqlite, {
      id: 'doc-long',
      name: 'Ijazah',
      expiresOn: '2036-01-01',
      remindDaysBefore: 365,
    }) // far out, max window — NOT
    seedDocument(sqlite, {
      id: 'doc-expired',
      name: 'SIM Lama',
      expiresOn: '2026-10-01',
      remindDaysBefore: 14,
    }) // long expired — DUE (most due)
    seedDocument(sqlite, { id: 'doc-h2', name: 'KTP Lain', householdId: 'h2', expiresOn: TODAY }) // other household — in ITS sweep, not h1's

    const due = await listDueDocumentReminders(d1, NOW)
    const dueH1 = due.filter((d) => d.household_id === 'h1')
    // Sorted by expiry ascending — the expired one leads.
    expect(dueH1.map((d) => d.id)).toEqual(['doc-expired', 'doc-win7', 'doc-default'])
    expect(dueH1[0]).toMatchObject({
      id: 'doc-expired',
      household_id: 'h1',
      days_until_expiry: -36,
    })
    // The other household's document is in the same global set (the cron has
    // no caller household) — but never inside h1's list.
    expect(due.map((d) => d.id)).toContain('doc-h2')

    // A different clock shifts the whole window exactly.
    const later = await listDueDocumentReminders(d1, new Date('2026-11-30T00:00:00.000Z'))
    const laterH1 = later.filter((d) => d.household_id === 'h1')
    // From 2026-11-30: doc-win7/-win8 are 17 days past expiry — inside every
    // window ≥ 1; doc-default 6 days out; doc-past-default 7 days out (now
    // inside its default-30 window). Only doc-long stays out.
    expect(laterH1.map((d) => d.id)).toEqual([
      'doc-expired',
      'doc-win7',
      'doc-win8',
      'doc-default',
      'doc-past-default',
    ])
  })

  it('expiring_within composes with the q and memberId filters', async () => {
    const { sqlite, d1 } = createDb()
    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    sqlite
      .prepare(
        `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
      )
      .run()
    seedDocument(sqlite, { id: 'doc-a', name: 'Paspor Bapak', expiresOn: TODAY })
    seedDocument(sqlite, { id: 'doc-b', name: 'Paspor Ibu', expiresOn: TODAY })
    seedDocument(sqlite, { id: 'doc-c', name: 'STNK', expiresOn: TODAY })

    const paspors = await listDocuments(d1, 'h1', { expiringWithin: 30, q: 'paspor' }, NOW)
    expect(paspors.map((d) => d.id).sort()).toEqual(['doc-a', 'doc-b'])
    expect(paspors.every((d) => d.days_until_expiry === 0)).toBe(true)
  })
})
