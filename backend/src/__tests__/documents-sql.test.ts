import { describe, it, expect } from 'vite-plus/test'
// Real-SQL coverage for the document vault (ahaqqu/RumaQ#388 MVP), following
// the households-sql.test.ts pattern: the route tests above route a fake D1
// on SQL fragments — good for HTTP shapes, blind to actual storage behavior.
// This file runs the SAME statements the lib runs against a real SQLite
// engine (node:sqlite — D1 is SQLite) through the full migration chain, so
// the security-relevant semantics cannot drift from the schema:
//
//   - the household scope predicate: a foreign household's document is
//     invisible to every lookup (list, get, delete),
//   - the member relation accepts BOTH modes (linked + profile-only, 0021)
//     through the same surrogate id,
//   - the deletion flow leaves no orphan: the object is gone, the row is
//     gone, and the audit record survives the row it names.
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
  createDocument,
  deleteDocument,
  getDocumentRow,
  listDocuments,
  recordDocumentAccess,
  isHouseholdMember,
  DocumentForbiddenError,
  DocumentNotFoundError,
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
  it('relates documents to BOTH member modes and lists them scoped, newest first', async () => {
    const { sqlite, d1 } = createDb()
    const storage = createR2StorageAdapter(createDocumentsStub() as unknown as R2Bucket)

    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u2', 'b@c.com')").run()
    sqlite
      .prepare(`INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`)
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
      category: 'akta',
      fileName: 'akta-adik.pdf',
      bytes: PDF_BYTES,
      mime: 'application/pdf',
      uploadedBy: 'u1',
    })
    const linkedMeta = await createDocument(d1, storage, {
      householdId: 'h1',
      memberId: 'm-linked',
      category: 'ktp',
      fileName: 'ktp-bapak.jpg',
      bytes: JPEG_BYTES,
      mime: 'image/jpeg',
      uploadedBy: 'u1',
    })
    await createDocument(d1, storage, {
      householdId: 'h2', // the other household's own document
      memberId: null,
      category: 'paspor',
      fileName: 'paspor.pdf',
      bytes: PDF_BYTES,
      mime: 'application/pdf',
      uploadedBy: 'u2',
    })

    // Full listing for h1 — only its two documents. Same-second inserts share
    // created_at (D1's datetime('now') granularity), so pin distinct
    // timestamps before asserting the newest-first ordering.
    sqlite.prepare('UPDATE documents SET created_at = ? WHERE id = ?').run(
      '2026-11-04 10:00:00',
      linkedDoc.id
    )
    sqlite.prepare('UPDATE documents SET created_at = ? WHERE id = ?').run(
      '2026-11-04 11:00:00',
      linkedMeta.id
    )
    const all = await listDocuments(d1, 'h1')
    expect(all.map((d) => d.id)).toEqual([linkedMeta.id, linkedDoc.id])

    // The member filter works for both modes.
    const byToddler = await listDocuments(d1, 'h1', { memberId: 'm-toddler' })
    expect(byToddler.map((d) => d.id)).toEqual([linkedDoc.id])
    const byLinked = await listDocuments(d1, 'h1', { memberId: 'm-linked' })
    expect(byLinked.map((d) => d.id)).toEqual([linkedMeta.id])

    // The category filter composes with the member filter.
    const byCategory = await listDocuments(d1, 'h1', { category: 'akta' })
    expect(byCategory.map((d) => d.id)).toEqual([linkedDoc.id])

    // The household scope: h2 sees only its own document.
    const otherHousehold = await listDocuments(d1, 'h2')
    expect(otherHousehold).toHaveLength(1)
    expect(otherHousehold[0]?.household_id).toBe('h2')

    // The scoped single lookup answers null across households — the 404
    // before any authz answer.
    expect(await getDocumentRow(d1, 'h2', linkedDoc.id)).toBeNull()
    expect(await getDocumentRow(d1, 'h1', linkedDoc.id)).not.toBeNull()
  })

  it('delete: object gone, row gone, and the delete audit record survives the row', async () => {
    const { sqlite, d1 } = createDb()
    const stub = createDocumentsStub()
    const storage = createR2StorageAdapter(stub as unknown as R2Bucket)

    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    sqlite
      .prepare(`INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`)
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
      category: 'kartu_anak',
      fileName: 'kartu-anak.jpg',
      bytes: JPEG_BYTES,
      mime: 'image/jpeg',
      uploadedBy: 'u1',
    })
    expect(stub.objects.size).toBe(1)

    // Access records from earlier views ride along.
    await recordDocumentAccess(d1, {
      documentId: doc.id,
      householdId: 'h1',
      actorUserId: 'u1',
      action: 'view',
    })
    await recordDocumentAccess(d1, {
      documentId: doc.id,
      householdId: 'h1',
      actorUserId: 'u1',
      action: 'download',
    })

    const row = await getDocumentRow(d1, 'h1', doc.id)
    expect(row).not.toBeNull()
    await deleteDocument(d1, storage, { householdId: 'h1', userId: 'u1', document: row! })

    // No orphan object, no orphan row.
    expect(stub.objects.size).toBe(0)
    expect(stub.deleted).toEqual([`documents/h1/${doc.id}`])
    expect(await getDocumentRow(d1, 'h1', doc.id)).toBeNull()
    expect(await listDocuments(d1, 'h1')).toEqual([])

    // The audit trail keeps ALL of it — upload, view, download, delete —
    // including records about a document that no longer exists. Same-second
    // rows carry random ids, so the assertion is over the multiset of
    // actions, not their stored order.
    const audit = sqlite.prepare('SELECT action, document_id FROM document_audit').all()
    expect([...audit.map((a) => a.action)].sort()).toEqual(
      ['upload', 'view', 'download', 'delete'].sort()
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
      .prepare(`INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`)
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
      category: 'lainnya',
      fileName: 'scan.jpg',
      bytes: JPEG_BYTES,
      mime: 'image/jpeg',
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

  it('member removal clears the relation but keeps the document; household deletion cascades everything', async () => {
    const { sqlite, d1 } = createDb()
    const storage = createR2StorageAdapter(createDocumentsStub() as unknown as R2Bucket)

    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    sqlite
      .prepare(`INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`)
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
      category: 'akta',
      fileName: 'akta.pdf',
      bytes: PDF_BYTES,
      mime: 'application/pdf',
      uploadedBy: 'u1',
    })

    // The toddler's member row is removed (owner action) — the document (and
    // its R2 object) must survive with the link cleared, never cascade-away.
    sqlite.prepare('DELETE FROM household_members WHERE id = ?').run('m-toddler')
    const afterMemberRemoval = await getDocumentRow(d1, 'h1', doc.id)
    expect(afterMemberRemoval).not.toBeNull()
    expect(afterMemberRemoval?.member_id).toBeNull()
    expect(await listDocuments(d1, 'h1', { memberId: 'm-toddler' })).toEqual([])

    // Household deletion cascades the document AND its audit trail (the
    // household_id FKs) — nothing of that household lingers.
    sqlite.prepare('DELETE FROM households WHERE id = ?').run('h1')
    expect(sqlite.prepare('SELECT COUNT(*) AS cnt FROM documents').get()).toEqual({ cnt: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS cnt FROM document_audit').get()).toEqual({ cnt: 0 })
  })
})
