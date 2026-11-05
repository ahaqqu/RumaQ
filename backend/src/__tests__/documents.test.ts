import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { documentsApp, UPLOAD_TRANSPORT_SLACK } from '../apps/documents.js'
import { DOCUMENT_MAX_FILES } from '../lib/documents.js'
import { resetRateLimit } from '../lib/rate-limit.js'
import {
  createDocumentsHarness,
  createEnv,
  joinRowsFromLog,
  postDocument,
  uploadForm,
  COUNT_ROUTE,
  DOC_ROW,
  DOC_ROW_ROUTE,
  FILE_ROW,
  FILE_ROW_ROUTE,
  JOIN_ROUTE,
  JPEG_BYTES,
  MEMBER_ROUTE,
  PDF_BYTES,
  TEXT_BYTES,
  type WithFiles,
} from './support/documents-harness.js'

// The document routes (ahaqqu/RumaQ#422 rework of #388) run a fixed query
// chain per request (scoped lookup, membership checks, batched writes), so
// this file routes the fake D1 on SQL fragments — the households.test.ts
// idiom — and pairs it with the R2Bucket-shaped in-memory stub
// (support/documents-harness.ts) so the REAL R2 StorageAdapter runs in every
// route test: assertions cover what was actually stored and deleted, not
// mock call counts. This file owns the CREATE/LIST/BOUNDS surface; content
// streaming + deletes live in documents-files.test.ts, sanitizer units in
// documents-lib.test.ts (review B1 #422). Synthetic bytes only — no real
// documents, no real PII in fixtures.

describe('documents routes — create, list, bounds', () => {
  const h = createDocumentsHarness()

  beforeEach(() => {
    resetRateLimit()
  })

  it('401s without a session', async () => {
    const { db } = h.setup()
    const unauth = await documentsApp.request(
      '/api/documents',
      {},
      createEnv(db, { props: undefined })
    )
    expect(unauth.status).toBe(401)
  })

  it('creates a document with a free-text name + first file: bytes under documents/<household>/<doc>/<file>, three rows in one batch (#422)', async () => {
    const { db, env, bucket } = h.setup(
      [MEMBER_ROUTE],
      [[JOIN_ROUTE, (params) => h.readBackFromLog(params, DOC_ROW())]]
    )

    const res = await documentsApp.request(
      '/api/documents',
      postDocument(
        uploadForm(
          { bytes: JPEG_BYTES, name: 'ktp-bapak.jpg', type: 'image/jpeg' },
          { name: '  KTP Bapak  ' }
        )
      ),
      env
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { document: WithFiles }
    expect(body.document).toMatchObject({
      name: 'KTP Bapak', // trimmed — no preset list anywhere
      household_id: 'h1',
      member_id: null,
      uploaded_by: 'u1',
      files: [
        {
          file_name: 'ktp-bapak.jpg',
          content_type: 'image/jpeg',
          size_bytes: JPEG_BYTES.byteLength,
          label: null,
          sort_order: 1,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          uploaded_by: 'u1',
        },
      ],
    })
    // r2_key is an internal handle — never in the response.
    expect(JSON.stringify(body.document)).not.toContain('r2_key')

    // The bytes are really there, under the per-file key, with the sniffed
    // content type.
    expect(bucket.objects.size).toBe(1)
    const key = [...bucket.objects.keys()][0]!
    expect(key).toMatch(/^documents\/h1\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/)
    const stored = bucket.objects.get(key)
    expect(stored?.httpMetadata?.contentType).toBe('image/jpeg')
    expect(Array.from(stored!.bytes)).toEqual(Array.from(JPEG_BYTES))

    // One batch: the document row + the file row + the 'upload' audit record.
    const batched = db.log.filter(
      (entry) =>
        /INSERT INTO documents \(/.test(entry.sql) ||
        /INSERT INTO document_files/.test(entry.sql) ||
        /INSERT INTO document_audit/.test(entry.sql)
    )
    expect(batched).toHaveLength(3)
    expect(batched.find((e) => /document_audit/.test(e.sql))?.params[4]).toBe('upload')
  })

  it('carries the optional per-file label through create (owner decision #422-1)', async () => {
    const { env } = h.setup(
      [MEMBER_ROUTE],
      [[JOIN_ROUTE, (params) => h.readBackFromLog(params, DOC_ROW())]]
    )

    const res = await documentsApp.request(
      '/api/documents',
      postDocument(
        uploadForm(
          { bytes: JPEG_BYTES, name: 'ktp.jpg', type: 'image/jpeg' },
          { name: 'KTP', label: 'Halaman depan' }
        )
      ),
      env
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { document: WithFiles }
    expect(body.document.files[0]).toMatchObject({ label: 'Halaman depan' })
  })

  it('rejects a missing or whitespace name with 400 — free text does not mean anonymous', async () => {
    const { env, bucket } = h.setup()
    const noName = await documentsApp.request(
      '/api/documents',
      postDocument(uploadForm({ bytes: JPEG_BYTES, name: 'ktp.jpg', type: 'image/jpeg' })),
      env
    )
    expect(noName.status).toBe(400)

    const blankName = await documentsApp.request(
      '/api/documents',
      postDocument(
        uploadForm({ bytes: JPEG_BYTES, name: 'ktp.jpg', type: 'image/jpeg' }, { name: '   ' })
      ),
      env
    )
    expect(blankName.status).toBe(400)
    expect(bucket.objects.size).toBe(0)
  })

  it('relates a document to a profile-only member (no account) via memberId', async () => {
    let memberParams: unknown[] = []
    const { env } = h.setup(
      [
        [
          /SELECT id FROM household_members WHERE id = \? AND household_id = \?/,
          (params) => {
            memberParams = params
            return { id: params[0] as string }
          },
        ],
      ],
      [[JOIN_ROUTE, (params) => h.readBackFromLog(params, DOC_ROW())]]
    )

    const res = await documentsApp.request(
      '/api/documents',
      postDocument(
        uploadForm(
          { bytes: PDF_BYTES, name: 'akta-adik.pdf', type: 'application/pdf' },
          { name: 'Akta Adik', memberId: 'm-toddler' }
        )
      ),
      env
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { document: WithFiles }
    expect(body.document.member_id).toBe('m-toddler')
    // The member lookup scoped to the household ran with both params bound.
    expect(memberParams).toEqual(['m-toddler', 'h1'])
  })

  it('rejects a memberId from another household with a validation error (no probe)', async () => {
    const { env, bucket } = h.setup([
      [/SELECT id FROM household_members WHERE id = \? AND household_id = \?/, () => null],
    ])
    const res = await documentsApp.request(
      '/api/documents',
      postDocument(
        uploadForm(
          { bytes: JPEG_BYTES, name: 'ktp.jpg', type: 'image/jpeg' },
          { name: 'KTP', memberId: 'm-other-household' }
        )
      ),
      env
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('Member') })
    expect(bucket.objects.size).toBe(0)
  })

  it('rejects a body larger than the cap (413) and never stores it', async () => {
    const { db, env, bucket } = h.setup()
    const big = new Uint8Array(10 * 1024 * 1024 + 1).fill(0xff)
    big[0] = 0xff
    big[1] = 0xd8
    big[2] = 0xff
    const res = await documentsApp.request(
      '/api/documents',
      postDocument(
        uploadForm({ bytes: big, name: 'huge.jpg', type: 'image/jpeg' }, { name: 'KTP' })
      ),
      env
    )
    expect(res.status).toBe(413)
    expect(bucket.objects.size).toBe(0)
    expect(db.log).toHaveLength(0)
  })

  it('accepts an exactly-10 MB file — the pre-check slack absorbs multipart overhead, the exact cap governs the bytes (review A1)', async () => {
    const { env, bucket } = h.setup(
      [MEMBER_ROUTE],
      [[JOIN_ROUTE, (params) => h.readBackFromLog(params, DOC_ROW())]]
    )
    const exact = new Uint8Array(10 * 1024 * 1024)
    exact[0] = 0xff
    exact[1] = 0xd8
    exact[2] = 0xff
    const res = await documentsApp.request(
      '/api/documents',
      postDocument(
        uploadForm({ bytes: exact, name: 'scan-big.jpg', type: 'image/jpeg' }, { name: 'KTP' })
      ),
      env
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { document: WithFiles }
    expect(body.document.files[0]).toMatchObject({ size_bytes: 10 * 1024 * 1024 })
    expect(bucket.objects.size).toBe(1)
  })

  // A chunked (Content-Length-less) multipart body, streamed in pieces — the
  // transport a proxy or fetch streaming upload produces.
  function chunkedUpload(fileBytes: Uint8Array, fileName: string): RequestInit {
    const boundary = '----rumaq-chunked'
    const encoder = new TextEncoder()
    const head = encoder.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: image/jpeg\r\n\r\n`
    )
    const namePart = encoder.encode(
      `--${boundary}\r\n` + `Content-Disposition: form-data; name="name"\r\n\r\n` + `KTP\r\n`
    )
    const tail = encoder.encode(`--${boundary}--\r\n`)
    const full = new Uint8Array(
      head.byteLength + fileBytes.byteLength + 2 + namePart.byteLength + tail.byteLength
    )
    let cursor = 0
    full.set(head, cursor)
    cursor += head.byteLength
    full.set(fileBytes, cursor)
    cursor += fileBytes.byteLength
    // The file part's terminating CRLF rides in front of the name part's
    // opening boundary.
    full.set(encoder.encode('\r\n'), cursor)
    cursor += 2
    full.set(namePart, cursor)
    cursor += namePart.byteLength
    full.set(tail, cursor)
    let offset = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= full.byteLength) {
          controller.close()
          return
        }
        const chunk = full.slice(offset, offset + 64 * 1024)
        offset += chunk.byteLength
        controller.enqueue(chunk)
      },
    })
    return {
      method: 'POST',
      body: stream,
      // Required for stream bodies; keeps undici from framing with
      // Content-Length — exactly the chunked shape the route must bound.
      duplex: 'half',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    } as RequestInit
  }

  it('parses a chunked (no Content-Length) exactly-10 MB upload through the bounded path (review A2)', async () => {
    const { env, bucket } = h.setup(
      [MEMBER_ROUTE],
      [[JOIN_ROUTE, (params) => h.readBackFromLog(params, DOC_ROW())]]
    )
    const exact = new Uint8Array(10 * 1024 * 1024)
    exact[0] = 0xff
    exact[1] = 0xd8
    exact[2] = 0xff
    const res = await documentsApp.request(
      '/api/documents',
      chunkedUpload(exact, 'scan-chunked.jpg'),
      env
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { document: WithFiles }
    expect(body.document.files[0]).toMatchObject({ size_bytes: 10 * 1024 * 1024 })
    expect(bucket.objects.size).toBe(1)
  })

  it('aborts a chunked upload past the cap during the stream read, before any parse or store (review A2)', async () => {
    const { db, env, bucket } = h.setup()
    // 10 MB + 65 KB of payload: over the pre-parse bound (cap + slack) no
    // matter how the multipart overhead lands — the stream read must stop
    // early instead of buffering the whole body.
    const over = new Uint8Array(10 * 1024 * 1024 + 65 * 1024)
    over[0] = 0xff
    over[1] = 0xd8
    over[2] = 0xff
    const res = await documentsApp.request(
      '/api/documents',
      chunkedUpload(over, 'huge-chunked.jpg'),
      env
    )
    expect(res.status).toBe(413)
    expect(bucket.objects.size).toBe(0)
    expect(db.log).toHaveLength(0)
  })

  it('exposes the transport slack through the app module (the pre-parse bound is cap + slack)', () => {
    // Pinned so the A1 contract cannot silently drift: the slack exists to
    // let an exactly-10 MB multipart body reach the exact post-parse cap.
    expect(UPLOAD_TRANSPORT_SLACK).toBe(64 * 1024)
  })

  it('rejects magic bytes that do not match the declared type (415) — sniff policy is reject, never override', async () => {
    const { env, bucket } = h.setup()
    // Declared JPEG, actually text.
    const res = await documentsApp.request(
      '/api/documents',
      postDocument(
        uploadForm({ bytes: TEXT_BYTES, name: 'fake.jpg', type: 'image/jpeg' }, { name: 'KTP' })
      ),
      env
    )
    expect(res.status).toBe(415)
    // Declared PNG, actually PDF.
    const res2 = await documentsApp.request(
      '/api/documents',
      postDocument(
        uploadForm({ bytes: PDF_BYTES, name: 'image.pdf', type: 'image/png' }, { name: 'KTP' })
      ),
      env
    )
    expect(res2.status).toBe(415)
    expect(bucket.objects.size).toBe(0)
  })

  it('rejects missing files and non-multipart bodies with 400', async () => {
    // The add-file path resolves the document BEFORE parsing, so it needs a
    // document to find.
    const { env, bucket } = h.setup([[DOC_ROW_ROUTE, () => DOC_ROW()]])
    const notMultipart = await documentsApp.request('/api/documents', { method: 'POST' }, env)
    expect(notMultipart.status).toBe(400)

    const noFileForm = new FormData()
    noFileForm.append('name', 'KTP')
    const noFile = await documentsApp.request('/api/documents', postDocument(noFileForm), env)
    expect(noFile.status).toBe(400)

    const addFileNoFile = new FormData()
    addFileNoFile.append('label', 'depan')
    const addFile = await documentsApp.request(
      '/api/documents/doc-1/files',
      postDocument(addFileNoFile),
      env
    )
    expect(addFile.status).toBe(400)
    expect(bucket.objects.size).toBe(0)
  })

  it('lists documents newest first with q (name search) and memberId filters composing', async () => {
    let lastParams: unknown[] = []
    const { env } = h.setup(
      [],
      [
        [
          JOIN_ROUTE,
          (params) => {
            lastParams = params
            // The scope predicate is always bound; filters append their own.
            expect(params[0]).toBe('h1')
            if (params.length === 3) {
              return joinRowsFromLog(
                DOC_ROW({ id: 'doc-filtered', member_id: params[1], name: params[2] }),
                []
              )
            }
            if (params.length === 2) {
              return joinRowsFromLog(DOC_ROW({ id: 'doc-filtered' }), [])
            }
            return [
              ...joinRowsFromLog(DOC_ROW({ id: 'doc-new', name: 'KTP Bapak' }), [
                FILE_ROW({ id: 'f-1', sort_order: 1 }),
              ]),
              ...joinRowsFromLog(DOC_ROW({ id: 'doc-old', name: 'Akta Adik' }), []),
            ]
          },
        ],
      ]
    )

    const all = await documentsApp.request('/api/documents', {}, env)
    expect(all.status).toBe(200)
    const allBody = (await all.json()) as { documents: Array<WithFiles> }
    expect(allBody.documents.map((d) => d.id)).toEqual(['doc-new', 'doc-old'])
    // Files arrive in upload order inside the document payload.
    expect(allBody.documents[0]?.files).toHaveLength(1)
    expect(allBody.documents[0]?.files[0]).toMatchObject({ sort_order: 1, label: null })

    // q + memberId compose (both bound after the household scope).
    const filtered = await documentsApp.request('/api/documents?q=ktp&memberId=m-toddler', {}, env)
    expect(filtered.status).toBe(200)
    expect(lastParams).toEqual(['h1', 'm-toddler', '%ktp%'])

    const badFilter = await documentsApp.request('/api/documents?q=' + 'x'.repeat(121), {}, env)
    expect(badFilter.status).toBe(400)
  })

  it('answers 404 for a foreign household document before any authz decision', async () => {
    const { env } = h.setup([
      [
        DOC_ROW_ROUTE,
        // The scoped query misses for ids belonging to other households —
        // exactly the shape the route receives. No role lookup ever runs.
        () => null,
      ],
    ])

    const meta = await documentsApp.request('/api/documents/doc-foreign', {}, env)
    expect(meta.status).toBe(404)
    const content = await documentsApp.request(
      '/api/documents/doc-foreign/files/file-1/content?disposition=inline',
      {},
      env
    )
    expect(content.status).toBe(404)
    const addFile = await documentsApp.request(
      '/api/documents/doc-foreign/files',
      postDocument(
        uploadForm({ bytes: JPEG_BYTES, name: 'x.jpg', type: 'image/jpeg' }, { name: 'x' })
      ),
      env
    )
    expect(addFile.status).toBe(404)
    const del = await documentsApp.request('/api/documents/doc-foreign', { method: 'DELETE' }, env)
    expect(del.status).toBe(404)
    // No existence leak: the response body is the generic not-found error.
    expect(await meta.json()).toMatchObject({ error: 'Document not found' })
  })

  it('answers 404 for a file of another document even within the household (file lookup joins the document)', async () => {
    const { env } = h.setup([
      [DOC_ROW_ROUTE, () => DOC_ROW()],
      // The file lookup binds fileId + documentId + householdId — a file id
      // from a DIFFERENT document must miss.
      [FILE_ROW_ROUTE, (params) => (params[1] === 'doc-1' ? FILE_ROW() : null)],
    ])
    const res = await documentsApp.request('/api/documents/doc-other/files/file-1/content', {}, env)
    expect(res.status).toBe(404)
  })

  it('adds a file to an existing document: sort_order = max + 1, bytes stored, file_add audit carries the file id (#422)', async () => {
    const { db, env, bucket } = h.setup(
      [[DOC_ROW_ROUTE, () => DOC_ROW()], COUNT_ROUTE(1)],
      [[JOIN_ROUTE, (params) => h.readBackFromLog(params, DOC_ROW())]],
      { fileSortSeeds: { 'doc-1': 1 } }
    )

    const res = await documentsApp.request(
      '/api/documents/doc-1/files',
      postDocument(
        uploadForm(
          { bytes: JPEG_BYTES, name: 'belakang.jpg', type: 'image/jpeg' },
          { label: 'Belakang' }
        )
      ),
      env
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { document: WithFiles }
    expect(body.document.files).toHaveLength(1)
    expect(body.document.files[0]).toMatchObject({ label: 'Belakang', sort_order: 2 })

    // The bytes are under the document's namespace with the next sort_order.
    expect(bucket.objects.size).toBe(1)
    const key = [...bucket.objects.keys()][0]!
    expect(key).toMatch(/^documents\/h1\/doc-1\/[0-9a-f-]{36}$/)

    // One batch: file row + 'file_add' audit, and the audit row NAMES the
    // file (sixth bound parameter).
    const audit = db.log.filter((e) => /INSERT INTO document_audit/.test(e.sql))
    expect(audit).toHaveLength(1)
    expect(audit[0]?.params[4]).toBe('file_add')
    expect(audit[0]?.params[5]).toBe(body.document.files[0]?.id)
    const fileInsert = db.log.find((e) => /INSERT INTO document_files/.test(e.sql))
    // The add-file insert is the guarded INSERT..SELECT: sort_order is
    // computed IN the statement (max+1) and the cap re-check rides the same
    // statement — no bound sort_order param to race (review A2 #422).
    expect(fileInsert?.sql).toContain('WHERE (SELECT COUNT(*) FROM document_files')
    expect(fileInsert?.sql).toContain('(SELECT COALESCE(MAX(sort_order), 0) + 1')
  })

  it('refuses a 21st file with 409 BEFORE any byte is stored (#422 owner decision 3)', async () => {
    const { db, env, bucket } = h.setup([
      [DOC_ROW_ROUTE, () => DOC_ROW()],
      COUNT_ROUTE(DOCUMENT_MAX_FILES),
    ])
    const res = await documentsApp.request(
      '/api/documents/doc-1/files',
      postDocument(
        uploadForm({ bytes: JPEG_BYTES, name: 'extra.jpg', type: 'image/jpeg' }, { name: 'x' })
      ),
      env
    )
    expect(res.status).toBe(409)
    expect(bucket.objects.size).toBe(0)
    expect(db.log).toHaveLength(0)
  })

  it('rate-limits bursts of uploads per user (429 with Retry-After) across both upload endpoints', async () => {
    const { env } = h.setup(
      [[DOC_ROW_ROUTE, () => DOC_ROW()], COUNT_ROUTE(0), MEMBER_ROUTE],
      [[JOIN_ROUTE, (params) => h.readBackFromLog(params, DOC_ROW())]]
    )
    let last: Response | undefined
    // The window holds a full maxed document (20) plus add-file calls — the
    // limit itself is 40; drive past it with creates.
    for (let i = 0; i < 41; i++) {
      last = await documentsApp.request(
        '/api/documents',
        postDocument(
          uploadForm(
            { bytes: JPEG_BYTES, name: `ktp-${i}.jpg`, type: 'image/jpeg' },
            { name: `KTP ${i}` }
          )
        ),
        env
      )
    }
    expect(last?.status).toBe(429)
    expect(last?.headers.get('Retry-After')).toBeTruthy()
  })
})
