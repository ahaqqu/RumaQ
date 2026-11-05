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
  deleteDocument,
  deleteDocumentFile,
  getDocumentFileRow,
  getDocumentRow,
  getDocumentWithFiles,
  listDocuments,
  listDocumentFiles,
  recordDocumentAccess,
  isHouseholdMember,
  DocumentForbiddenError,
  DocumentNotFoundError,
  DocumentTooManyFilesError,
  DOCUMENT_MAX_FILES,
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
