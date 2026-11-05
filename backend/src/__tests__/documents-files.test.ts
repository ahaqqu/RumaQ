import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { documentsApp } from '../apps/documents.js'
import { resetRateLimit } from '../lib/rate-limit.js'
import {
  createDocumentsHarness,
  DOC_ROW,
  DOC_ROW_ROUTE,
  FILE_ROW,
  FILE_ROW_ROUTE,
  JPEG_BYTES,
  MEMBERSHIP_ROUTE,
  PDF_BYTES,
  type Row,
} from './support/documents-harness.js'

// The per-file surface of the document routes (ahaqqu/RumaQ#422): content
// streaming (view/download with their per-request audits, the vault-key
// guard, the dead-file 404) and both delete flows. Split out of the create/
// list route file (review B1 #422) — the shared fake lives in the harness.
describe('documents routes — files (stream, delete)', () => {
  const h = createDocumentsHarness()

  beforeEach(() => {
    resetRateLimit()
  })

  it('refuses to touch storage when a row carries a key outside the vault namespace (review B1)', async () => {
    const { env, bucket } = h.setup([
      MEMBERSHIP_ROUTE,
      [DOC_ROW_ROUTE, () => DOC_ROW()],
      [FILE_ROW_ROUTE, () => FILE_ROW({ r2_key: 'receipts/h1/escaped.jpg' })],
    ])

    // Content: the escaped key must never reach the adapter (it could serve a
    // sibling namespace's object) — the row is a dead file.
    const content = await documentsApp.request('/api/documents/doc-1/files/file-1/content', {}, env)
    expect(content.status).toBe(404)

    // File delete: refusing protects the sibling namespace even though the
    // row technically matches the scope — the vault-key guard answers the
    // same 404 a missing row would.
    const del = await documentsApp.request(
      '/api/documents/doc-1/files/file-1',
      { method: 'DELETE' },
      env
    )
    expect(del.status).toBe(404)
    expect(bucket.deleted).toHaveLength(0)
    expect(bucket.objects.size).toBe(0)
  })

  it('streams one file’s content inline with stored mime, private no-store, and audits a view per file', async () => {
    const { db, env, bucket } = h.setup([
      [DOC_ROW_ROUTE, () => DOC_ROW()],
      [FILE_ROW_ROUTE, () => FILE_ROW()],
    ])
    await bucket.put('documents/h1/doc-1/file-1', JPEG_BYTES, {
      httpMetadata: { contentType: 'image/jpeg' },
    })

    const res = await documentsApp.request('/api/documents/doc-1/files/file-1/content', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(res.headers.get('Content-Disposition')).toContain('inline')
    expect(res.headers.get('Content-Disposition')).toContain('depan.jpg')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(bytes)).toEqual(Array.from(JPEG_BYTES))
    // View audited (inline default) with the file id in the record.
    const audit = db.log.filter((e) => /INSERT INTO document_audit/.test(e.sql))
    expect(audit).toHaveLength(1)
    expect(audit[0]?.params[4]).toBe('view')
    expect(audit[0]?.params[5]).toBe('file-1')
  })

  it('disposition=attachment streams with the attachment header and audits a download; a bad disposition is a 400', async () => {
    const { db, env, bucket } = h.setup([
      [DOC_ROW_ROUTE, () => DOC_ROW()],
      [FILE_ROW_ROUTE, () => FILE_ROW()],
    ])
    await bucket.put('documents/h1/doc-1/file-1', JPEG_BYTES, {
      httpMetadata: { contentType: 'image/jpeg' },
    })

    const res = await documentsApp.request(
      '/api/documents/doc-1/files/file-1/content?disposition=attachment',
      {},
      env
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toContain('attachment')
    const audit = db.log.filter((e) => /INSERT INTO document_audit/.test(e.sql))
    expect(audit[0]?.params[4]).toBe('download')

    const bad = await documentsApp.request(
      '/api/documents/doc-1/files/file-1/content?disposition=weird',
      {},
      env
    )
    expect(bad.status).toBe(400)
  })

  it('returns 404 when the file row exists but the object is gone (dead file, no leak)', async () => {
    const { env } = h.setup([
      [DOC_ROW_ROUTE, () => DOC_ROW()],
      [FILE_ROW_ROUTE, () => FILE_ROW({ r2_key: 'documents/h1/doc-1/file-ghost' })],
    ])
    // Nothing put into storage under that key.
    const res = await documentsApp.request('/api/documents/doc-1/files/file-1/content', {}, env)
    expect(res.status).toBe(404)
  })

  it('delete-file (uploader): removes the object first, then row + file_delete audit in one batch — no orphan', async () => {
    const { db, env, bucket } = h.setup([
      MEMBERSHIP_ROUTE,
      [DOC_ROW_ROUTE, () => DOC_ROW()],
      [FILE_ROW_ROUTE, () => FILE_ROW()],
    ])
    await bucket.put('documents/h1/doc-1/file-1', PDF_BYTES, {
      httpMetadata: { contentType: 'application/pdf' },
    })

    const res = await documentsApp.request(
      '/api/documents/doc-1/files/file-1',
      { method: 'DELETE' },
      env
    )
    expect(res.status).toBe(204)
    // The stub recorded the delete and the map is empty — no orphan.
    expect(bucket.deleted).toEqual(['documents/h1/doc-1/file-1'])
    expect(bucket.objects.size).toBe(0)
    // Audit row rides in the same batch as the DELETE, action names the file.
    const audit = db.log.filter((e) => /INSERT INTO document_audit/.test(e.sql))
    expect(audit).toHaveLength(1)
    expect(audit[0]?.params[4]).toBe('file_delete')
    expect(audit[0]?.params[5]).toBe('file-1')
    expect(
      db.log.some((e) =>
        /DELETE FROM document_files WHERE id = \? AND document_id = \?/.test(e.sql)
      )
    ).toBe(true)
  })

  it('delete-file authz: household owner, document uploader, and file uploader may; a plain member cannot (403)', async () => {
    // A member (u2) uploaded the FILE; the caller is u1 (the document
    // uploader but not an owner).
    const fileRoutes: [RegExp, (params: unknown[]) => Row | null][] = [
      [DOC_ROW_ROUTE, () => DOC_ROW({ uploaded_by: 'u1' })],
      [FILE_ROW_ROUTE, () => FILE_ROW({ uploaded_by: 'u2' })],
    ]

    // Document uploader may remove another member's file.
    const uploader = h.setup([MEMBERSHIP_ROUTE, ...fileRoutes])
    await uploader.bucket.put('documents/h1/doc-1/file-1', PDF_BYTES, {
      httpMetadata: { contentType: 'application/pdf' },
    })
    const uploaderRes = await documentsApp.request(
      '/api/documents/doc-1/files/file-1',
      { method: 'DELETE' },
      uploader.env
    )
    expect(uploaderRes.status).toBe(204)
    expect(uploader.bucket.deleted).toEqual(['documents/h1/doc-1/file-1'])

    // Owner path.
    const owner = h.setup([
      [/SELECT h\.id, h\.name, m\.role/, () => ({ id: 'h1', name: 'R', role: 'owner' })],
      ...fileRoutes,
    ])
    await owner.bucket.put('documents/h1/doc-1/file-1', PDF_BYTES, {
      httpMetadata: { contentType: 'application/pdf' },
    })
    const ownerRes = await documentsApp.request(
      '/api/documents/doc-1/files/file-1',
      { method: 'DELETE' },
      owner.env
    )
    expect(ownerRes.status).toBe(204)

    // Plain member path — forbidden, object untouched.
    const member = h.setup([
      [/SELECT h\.id, h\.name, m\.role/, () => ({ id: 'h1', name: 'R', role: 'member' })],
      [
        DOC_ROW_ROUTE,
        () => DOC_ROW({ uploaded_by: 'u3' }), // not the caller either
      ],
      ...fileRoutes.slice(1),
    ])
    await member.bucket.put('documents/h1/doc-1/file-1', PDF_BYTES, {
      httpMetadata: { contentType: 'application/pdf' },
    })
    const memberRes = await documentsApp.request(
      '/api/documents/doc-1/files/file-1',
      { method: 'DELETE' },
      member.env
    )
    expect(memberRes.status).toBe(403)
    expect(member.bucket.deleted).toHaveLength(0)
    expect(member.bucket.objects.size).toBe(1)
    // No write ever ran.
    expect(member.db.log).toHaveLength(0)
  })

  const FILES_LIST_ROUTE = (): [RegExp, (params: unknown[]) => Row[]] => [
    /SELECT id, document_id, r2_key, file_name, size_bytes, content_type/,
    () => [
      FILE_ROW({ id: 'file-1', r2_key: 'documents/h1/doc-1/file-1' }),
      FILE_ROW({ id: 'file-2', r2_key: 'documents/h1/doc-1/file-2', sort_order: 2 }),
    ],
  ]

  it('delete-document: every file object goes first, then the row (files cascade) + delete audit in one batch', async () => {
    const { db, env, bucket } = h.setup(
      [MEMBERSHIP_ROUTE, [DOC_ROW_ROUTE, () => DOC_ROW()]],
      [FILES_LIST_ROUTE()]
    )
    await bucket.put('documents/h1/doc-1/file-1', PDF_BYTES, {
      httpMetadata: { contentType: 'application/pdf' },
    })
    await bucket.put('documents/h1/doc-1/file-2', JPEG_BYTES, {
      httpMetadata: { contentType: 'image/jpeg' },
    })

    const res = await documentsApp.request('/api/documents/doc-1', { method: 'DELETE' }, env)
    expect(res.status).toBe(204)
    // Both objects gone — no orphan.
    expect(bucket.deleted).toEqual(['documents/h1/doc-1/file-1', 'documents/h1/doc-1/file-2'])
    expect(bucket.objects.size).toBe(0)
    // Audit row rides in the same batch as the DELETE, action = 'delete'.
    const audit = db.log.filter((e) => /INSERT INTO document_audit/.test(e.sql))
    expect(audit).toHaveLength(1)
    expect(audit[0]?.params[4]).toBe('delete')
    expect(audit[0]?.params[5]).toBe(null)
    expect(
      db.log.some((e) => /DELETE FROM documents WHERE id = \? AND household_id = \?/.test(e.sql))
    ).toBe(true)
  })

  it('delete-document: household owner may remove another member’s upload; plain member cannot (403)', async () => {
    const SINGLE_FILE_LIST_ROUTE: [RegExp, (params: unknown[]) => Row[]] = [
      /SELECT id, document_id, r2_key, file_name, size_bytes, content_type/,
      () => [FILE_ROW({ r2_key: 'documents/h1/doc-1/file-1' })],
    ]

    // Owner path.
    const owner = h.setup(
      [
        [/SELECT h\.id, h\.name, m\.role/, () => ({ id: 'h1', name: 'R', role: 'owner' })],
        [DOC_ROW_ROUTE, () => DOC_ROW({ uploaded_by: 'u2' })],
      ],
      [SINGLE_FILE_LIST_ROUTE]
    )
    await owner.bucket.put('documents/h1/doc-1/file-1', PDF_BYTES, {
      httpMetadata: { contentType: 'application/pdf' },
    })
    const ownerRes = await documentsApp.request(
      '/api/documents/doc-1',
      { method: 'DELETE' },
      owner.env
    )
    expect(ownerRes.status).toBe(204)
    expect(owner.bucket.deleted).toEqual(['documents/h1/doc-1/file-1'])

    // Member path — forbidden, object untouched.
    const member = h.setup(
      [
        [/SELECT h\.id, h\.name, m\.role/, () => ({ id: 'h1', name: 'R', role: 'member' })],
        [DOC_ROW_ROUTE, () => DOC_ROW({ uploaded_by: 'u2' })],
      ],
      [SINGLE_FILE_LIST_ROUTE]
    )
    await member.bucket.put('documents/h1/doc-1/file-1', PDF_BYTES, {
      httpMetadata: { contentType: 'application/pdf' },
    })
    const memberRes = await documentsApp.request(
      '/api/documents/doc-1',
      { method: 'DELETE' },
      member.env
    )
    expect(memberRes.status).toBe(403)
    expect(member.bucket.deleted).toHaveLength(0)
    expect(member.bucket.objects.size).toBe(1)
    // No write ever ran.
    expect(member.db.log).toHaveLength(0)
  })
})
