import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { documentsApp } from '../apps/documents.js'
import { sniffDocumentMime, sanitizeFileName, contentDisposition } from '../lib/documents.js'
import { resetRateLimit } from '../lib/rate-limit.js'
import { createDocumentsStub, type MockEnv } from './support/env.js'

// The document routes (ahaqqu/RumaQ#388) run a fixed query chain per request
// (scoped lookup, membership checks, batched writes), so this file routes the
// fake D1 on SQL fragments — the households.test.ts idiom — and pairs it with
// the R2Bucket-shaped in-memory stub (support/env.ts) so the REAL R2
// StorageAdapter runs in every route test: assertions cover what was actually
// stored and deleted, not mock call counts. Synthetic bytes only — no real
// documents, no real PII in fixtures.

type Row = Record<string, unknown>

type FakeDb = {
  prepare: (sql: string) => {
    bind: (...params: unknown[]) => {
      first: <T>() => Promise<T | null>
      all: <T>() => Promise<{ results: T[] }>
      run: () => Promise<unknown>
    }
  }
  batch: (stmts: unknown[]) => Promise<unknown[]>
  log: Array<{ sql: string; params: unknown[] }>
}

function createFakeDb(
  firstRoutes: [RegExp, (params: unknown[]) => Row | null][] = [],
  allRoutes: [RegExp, (params: unknown[]) => Row[]][] = []
): FakeDb {
  const log: Array<{ sql: string; params: unknown[] }> = []
  return {
    log,
    prepare: (sql: string) => {
      const flat = sql.replace(/\s+/g, ' ')
      return {
        bind: (...params: unknown[]) => ({
          first: async <T>() => {
            const hit = firstRoutes.find(([re]) => re.test(flat))
            if (!hit) throw new Error(`fake DB: no first() route for: ${sql}`)
            return ((await hit[1](params)) as T) ?? null
          },
          all: async <T>() => {
            const hit = allRoutes.find(([re]) => re.test(flat))
            if (!hit) throw new Error(`fake DB: no all() route for: ${sql}`)
            return { results: (await hit[1](params)) as T[] }
          },
          run: async () => {
            log.push({ sql: flat, params })
            return undefined
          },
        }),
      }
    },
    batch: async (stmts: unknown[]) => {
      for (const stmt of stmts as Array<{ run: () => Promise<void> }>) {
        await stmt.run()
      }
      return []
    },
  }
}

function createEnv(db: FakeDb, overrides: Partial<MockEnv> = {}): MockEnv {
  return {
    DB: db as unknown as MockEnv['DB'],
    RECEIPTS: {},
    BROCHURES: {} as MockEnv['BROCHURES'],
    DOCUMENTS: {} as MockEnv['DOCUMENTS'],
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    WORKER_JWT_SECRET: 'test-secret',
    WORKER_ENCRYPTION_KEY: 'test-enc-key',
    PAGES_ORIGIN: 'http://localhost:5173',
    EMAIL_AUTH_ENABLED: 'false',
    ASSETS: undefined as unknown as Fetcher,
    props: { userId: 'u1', householdId: 'h1' },
    TEST_MODE: 'true',
    ...overrides,
  }
}

// Synthetic magic-byte payloads (headers + a few filler bytes).
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
])
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56,
])
const TEXT_BYTES = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]) // "hello"

// The INSERT INTO documents parameter order (lib/documents.ts) — the fake
// read-back reconstructs the row from what was actually written.
const DOCUMENT_INSERT_COLUMNS = [
  'id',
  'household_id',
  'member_id',
  'category',
  'file_name',
  'mime_type',
  'size_bytes',
  'storage_key',
  'sha256',
  'uploaded_by',
] as const

const SCOPED_DOC_ROUTE =
  /SELECT d\.id, d\.household_id, d\.member_id, d\.category.*WHERE d\.id = \? AND d\.household_id = \?/

const LIST_ROUTES: [RegExp, (params: unknown[]) => Row[]][] = [
  [/SELECT d\.id, d\.household_id, d\.member_id, d\.category/, () => []],
]

function uploadForm(
  file: { bytes: Uint8Array; name: string; type: string },
  fields: Record<string, string> = {}
): FormData {
  const form = new FormData()
  const blob = new Blob([file.bytes as BlobPart], { type: file.type })
  form.append('file', blob, file.name)
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value)
  }
  return form
}

// Hono's request() is (input, requestInit, Env, executionCtx) — the env goes
// in the THIRD slot, so these helpers produce requestInit, never a Request.
function postDocument(form: FormData): RequestInit {
  return { method: 'POST', body: form }
}

function DOC_ROW(overrides: Row = {}): Row {
  return {
    id: 'doc-1',
    household_id: 'h1',
    member_id: null,
    category: 'akta',
    file_name: 'akta.pdf',
    mime_type: 'application/pdf',
    size_bytes: PDF_BYTES.byteLength,
    storage_key: 'documents/h1/doc-1',
    sha256: 'a'.repeat(64),
    uploaded_by: 'u1',
    created_at: '2026-11-04 00:00:00',
    ...overrides,
  }
}

describe('magic-byte sniffer', () => {
  it('recognizes JPEG (FF D8 FF), PNG, WebP (RIFF/WEBP), and PDF (%PDF-)', () => {
    expect(sniffDocumentMime(JPEG_BYTES)).toBe('image/jpeg')
    expect(sniffDocumentMime(PNG_BYTES)).toBe('image/png')
    expect(sniffDocumentMime(WEBP_BYTES)).toBe('image/webp')
    expect(sniffDocumentMime(PDF_BYTES)).toBe('application/pdf')
  })

  it('rejects text bytes, truncated signatures, and empty payloads', () => {
    expect(sniffDocumentMime(TEXT_BYTES)).toBeNull()
    expect(sniffDocumentMime(new Uint8Array([0xff, 0xd8]))).toBeNull() // JPEG cut short
    expect(sniffDocumentMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00]))).toBeNull() // RIFF, not WEBP
    expect(sniffDocumentMime(new Uint8Array(0))).toBeNull()
  })

  it('pins the sanitize + header helpers: no paths, no control chars, RFC 5987 names', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFileName('C:\\Users\\akta.pdf')).toBe('akta.pdf')
    expect(sanitizeFileName('a\u0000b.pdf')).toBe('ab.pdf')
    expect(sanitizeFileName('   ')).toBeNull()
    expect(sanitizeFileName('')).toBeNull()
    expect(sanitizeFileName('.')).toBeNull()
    expect(contentDisposition('inline', 'akta lahir.pdf')).toBe(
      'inline; filename="akta lahir.pdf"; filename*=UTF-8\'\'akta%20lahir.pdf'
    )
    // The em-dash is not ASCII-representable: the quoted fallback underscores
    // it, while filename* carries the real name.
    expect(contentDisposition('attachment', 'kartu anak — bayi.pdf')).toBe(
      'attachment; filename="kartu anak _ bayi.pdf"; filename*=UTF-8\'\'kartu%20anak%20%E2%80%94%20bayi.pdf'
    )
  })
})

describe('documents routes', () => {
  let db: FakeDb
  let env: MockEnv
  let bucket: ReturnType<typeof createDocumentsStub>

  // The scoped lookup's read-back: the route re-SELECTs after the batch, so
  // the fake answers from the insert log — the test sees the row that was
  // truly written, not a parallel fixture. Reads `db` at call time.
  function readBackFromLog(params: unknown[]): Row | null {
    const inserts = db.log.filter((entry) => /INSERT INTO documents/.test(entry.sql))
    const last = inserts[inserts.length - 1]
    if (!last) return null
    if (params[0] !== last.params[0]) return null // wrong document id
    const row: Row = { created_at: '2026-11-04 00:00:00' }
    DOCUMENT_INSERT_COLUMNS.forEach((column, i) => {
      row[column] = last.params[i]
    })
    return row
  }

  const setup = (
    firstRoutes: [RegExp, (params: unknown[]) => Row | null][] = [],
    allRoutes: [RegExp, (params: unknown[]) => Row[]][] = LIST_ROUTES
  ) => {
    db = createFakeDb(firstRoutes, allRoutes)
    bucket = createDocumentsStub()
    env = createEnv(db, { DOCUMENTS: bucket as unknown as MockEnv['DOCUMENTS'] })
    return env
  }

  beforeEach(() => {
    resetRateLimit()
  })

  it('401s without a session', async () => {
    setup()
    const unauth = await documentsApp.request(
      '/api/documents',
      {},
      createEnv(db, { props: undefined })
    )
    expect(unauth.status).toBe(401)
  })

  it('uploads a JPEG happy path: bytes stored under documents/<household>/, row + upload audit in one batch', async () => {
    setup([
      [
        /SELECT id FROM household_members WHERE id = \? AND household_id = \?/,
        (params) => ({ id: params[0] as string }),
      ],
      [SCOPED_DOC_ROUTE, readBackFromLog],
    ])

    const res = await documentsApp.request(
      '/api/documents',
      postDocument(
        uploadForm(
          { bytes: JPEG_BYTES, name: 'ktp-bapak.jpg', type: 'image/jpeg' },
          { category: 'ktp' }
        )
      ),
      env
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { document: Row }
    expect(body.document).toMatchObject({
      category: 'ktp',
      file_name: 'ktp-bapak.jpg',
      mime_type: 'image/jpeg',
      size_bytes: JPEG_BYTES.byteLength,
      household_id: 'h1',
      member_id: null,
      uploaded_by: 'u1',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    // storage_key is an internal handle — never in the response.
    expect(body.document.storage_key).toBeUndefined()

    // The bytes are really there, under the dedicated prefix, with the sniffed
    // content type.
    expect(bucket.objects.size).toBe(1)
    const key = [...bucket.objects.keys()][0]!
    expect(key.startsWith('documents/h1/')).toBe(true)
    const stored = bucket.objects.get(key)
    expect(stored?.httpMetadata?.contentType).toBe('image/jpeg')
    expect(Array.from(stored!.bytes)).toEqual(Array.from(JPEG_BYTES))

    // One batch: the document row + the 'upload' audit record (the action
    // rides as the fifth bound parameter).
    const batched = db.log.filter(
      (entry) =>
        /INSERT INTO documents/.test(entry.sql) || /INSERT INTO document_audit/.test(entry.sql)
    )
    expect(batched).toHaveLength(2)
    expect(batched.find((e) => /document_audit/.test(e.sql))?.params[4]).toBe('upload')
  })

  it('relates a document to a profile-only member (no account) via memberId', async () => {
    let memberParams: unknown[] = []
    setup([
      [
        /SELECT id FROM household_members WHERE id = \? AND household_id = \?/,
        (params) => {
          memberParams = params
          return { id: params[0] as string }
        },
      ],
      [SCOPED_DOC_ROUTE, readBackFromLog],
    ])

    const res = await documentsApp.request(
      '/api/documents',
      postDocument(
        uploadForm(
          { bytes: PDF_BYTES, name: 'akta-adik.pdf', type: 'application/pdf' },
          { category: 'akta', memberId: 'm-toddler' }
        )
      ),
      env
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { document: Row }
    expect(body.document.member_id).toBe('m-toddler')
    // The member lookup scoped to the household ran with both params bound.
    expect(memberParams).toEqual(['m-toddler', 'h1'])
  })

  it('rejects a memberId from another household with a validation error (no probe)', async () => {
    setup([[/SELECT id FROM household_members WHERE id = \? AND household_id = \?/, () => null]])
    const res = await documentsApp.request(
      '/api/documents',
      postDocument(
        uploadForm(
          { bytes: JPEG_BYTES, name: 'ktp.jpg', type: 'image/jpeg' },
          { category: 'ktp', memberId: 'm-other-household' }
        )
      ),
      env
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('Member') })
    expect(bucket.objects.size).toBe(0)
  })

  it('rejects a body larger than the cap (413) and never stores it', async () => {
    setup()
    const big = new Uint8Array(10 * 1024 * 1024 + 1).fill(0xff)
    big[0] = 0xff
    big[1] = 0xd8
    big[2] = 0xff
    const res = await documentsApp.request(
      '/api/documents',
      postDocument(
        uploadForm({ bytes: big, name: 'huge.jpg', type: 'image/jpeg' }, { category: 'ktp' })
      ),
      env
    )
    expect(res.status).toBe(413)
    expect(bucket.objects.size).toBe(0)
    expect(db.log).toHaveLength(0)
  })

  it('accepts an exactly-10 MB file — the pre-check slack absorbs multipart overhead, the exact cap governs the bytes (review A1)', async () => {
    setup([
      [/SELECT id FROM household_members WHERE id = \? AND household_id = \?/, () => ({ id: 'm' })],
      [SCOPED_DOC_ROUTE, readBackFromLog],
    ])
    const exact = new Uint8Array(10 * 1024 * 1024)
    exact[0] = 0xff
    exact[1] = 0xd8
    exact[2] = 0xff
    const res = await documentsApp.request(
      '/api/documents',
      postDocument(
        uploadForm({ bytes: exact, name: 'scan-big.jpg', type: 'image/jpeg' }, { category: 'ktp' })
      ),
      env
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { document: Row }
    expect(body.document.size_bytes).toBe(10 * 1024 * 1024)
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
    const categoryPart = encoder.encode(
      `--${boundary}\r\n` + `Content-Disposition: form-data; name="category"\r\n\r\n` + `ktp\r\n`
    )
    const tail = encoder.encode(`--${boundary}--\r\n`)
    const full = new Uint8Array(
      head.byteLength +
        fileBytes.byteLength +
        2 + // the file part's terminating CRLF
        categoryPart.byteLength +
        tail.byteLength
    )
    let cursor = 0
    full.set(head, cursor)
    cursor += head.byteLength
    full.set(fileBytes, cursor)
    cursor += fileBytes.byteLength
    // The file part's terminating CRLF rides in front of the category part's
    // opening boundary.
    full.set(encoder.encode('\r\n'), cursor)
    cursor += 2
    full.set(categoryPart, cursor)
    cursor += categoryPart.byteLength
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
    setup([
      [/SELECT id FROM household_members WHERE id = \? AND household_id = \?/, () => ({ id: 'm' })],
      [SCOPED_DOC_ROUTE, readBackFromLog],
    ])
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
    const body = (await res.json()) as { document: Row }
    expect(body.document.size_bytes).toBe(10 * 1024 * 1024)
    expect(bucket.objects.size).toBe(1)
  })

  it('aborts a chunked upload past the cap during the stream read, before any parse or store (review A2)', async () => {
    setup()
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

  it('refuses to touch storage when a row carries a key outside the vault namespace (review B1)', async () => {
    setup([
      [/SELECT h.id, h.name, m.role/, () => ({ id: 'h1', name: 'R', role: 'owner' })],
      [SCOPED_DOC_ROUTE, () => DOC_ROW({ storage_key: 'receipts/h1/escaped.jpg' })],
    ])

    // Content: the escaped key must never reach the adapter (it could serve a
    // sibling namespace's object) — the row is a dead document.
    const content = await documentsApp.request('/api/documents/doc-1/content', {}, env)
    expect(content.status).toBe(404)

    // Delete: refusing protects the sibling namespace even though the row
    // technically matches the scope.
    const del = await documentsApp.request('/api/documents/doc-1', { method: 'DELETE' }, env)
    expect(del.status).toBe(404)
    expect(bucket.deleted).toHaveLength(0)
    expect(bucket.objects.size).toBe(0)
  })

  it('rejects magic bytes that do not match the declared type (415) — sniff policy is reject, never override', async () => {
    setup()
    // Declared JPEG, actually text.
    const res = await documentsApp.request(
      '/api/documents',
      postDocument(
        uploadForm({ bytes: TEXT_BYTES, name: 'fake.jpg', type: 'image/jpeg' }, { category: 'ktp' })
      ),
      env
    )
    expect(res.status).toBe(415)
    // Declared PNG, actually PDF.
    const res2 = await documentsApp.request(
      '/api/documents',
      postDocument(
        uploadForm({ bytes: PDF_BYTES, name: 'image.pdf', type: 'image/png' }, { category: 'ktp' })
      ),
      env
    )
    expect(res2.status).toBe(415)
    expect(bucket.objects.size).toBe(0)
  })

  it('rejects off-allowlist declared types, unknown categories, and missing files with 400/415', async () => {
    setup()
    const notMultipart = await documentsApp.request('/api/documents', { method: 'POST' }, env)
    expect(notMultipart.status).toBe(400)

    const badCategory = await documentsApp.request(
      '/api/documents',
      postDocument(
        uploadForm(
          { bytes: JPEG_BYTES, name: 'ktp.jpg', type: 'image/jpeg' },
          { category: 'ijazah' }
        )
      ),
      env
    )
    expect(badCategory.status).toBe(400)

    const noFileForm = new FormData()
    noFileForm.append('category', 'ktp')
    const noFile = await documentsApp.request('/api/documents', postDocument(noFileForm), env)
    expect(noFile.status).toBe(400)
  })

  it('lists documents newest first and honors memberId/category filters', async () => {
    setup(
      [],
      [
        [
          /SELECT d\.id, d\.household_id, d\.member_id, d\.category/,
          (params) => {
            // The scope predicate is always bound; filters append their own.
            expect(params[0]).toBe('h1')
            if (params.length === 3) {
              return [DOC_ROW({ id: 'doc-filtered', member_id: params[1], category: params[2] })]
            }
            if (params.length === 2) {
              return [DOC_ROW({ id: 'doc-filtered' })]
            }
            return [DOC_ROW({ id: 'doc-new' }), DOC_ROW({ id: 'doc-old' })]
          },
        ],
      ]
    )

    const all = await documentsApp.request('/api/documents', {}, env)
    expect(all.status).toBe(200)
    const allBody = (await all.json()) as { documents: Row[] }
    expect(allBody.documents.map((d) => d.id)).toEqual(['doc-new', 'doc-old'])

    const filtered = await documentsApp.request(
      '/api/documents?memberId=m-toddler&category=akta',
      {},
      env
    )
    expect(filtered.status).toBe(200)
    const filteredBody = (await filtered.json()) as { documents: Row[] }
    expect(filteredBody.documents[0]?.member_id).toBe('m-toddler')

    const badFilter = await documentsApp.request('/api/documents?category=ijazah', {}, env)
    expect(badFilter.status).toBe(400)
  })

  it('answers 404 for a foreign household document before any authz decision', async () => {
    setup([
      [
        SCOPED_DOC_ROUTE,
        // The scoped query misses for ids belonging to other households —
        // exactly the shape the route receives. No role lookup ever runs.
        () => null,
      ],
    ])

    const meta = await documentsApp.request('/api/documents/doc-foreign', {}, env)
    expect(meta.status).toBe(404)
    const content = await documentsApp.request(
      '/api/documents/doc-foreign/content?disposition=inline',
      {},
      env
    )
    expect(content.status).toBe(404)
    const del = await documentsApp.request('/api/documents/doc-foreign', { method: 'DELETE' }, env)
    expect(del.status).toBe(404)
    // No existence leak: the response body is the generic not-found error.
    expect(await meta.json()).toMatchObject({ error: 'Document not found' })
  })

  it('streams content inline with stored mime, private no-store, and audits a view', async () => {
    setup([[SCOPED_DOC_ROUTE, () => DOC_ROW({ storage_key: 'documents/h1/doc-1' })]])
    await bucket.put('documents/h1/doc-1', PDF_BYTES, {
      httpMetadata: { contentType: 'application/pdf' },
    })

    const res = await documentsApp.request('/api/documents/doc-1/content', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain('inline')
    expect(res.headers.get('Content-Disposition')).toContain('akta.pdf')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(bytes)).toEqual(Array.from(PDF_BYTES))
    // View audited (inline default).
    expect(db.log.filter((e) => /INSERT INTO document_audit/.test(e.sql))[0]?.params[4]).toBe(
      'view'
    )
  })

  it('disposition=attachment streams with attachment header and audits a download', async () => {
    setup([[SCOPED_DOC_ROUTE, () => DOC_ROW({ storage_key: 'documents/h1/doc-1' })]])
    await bucket.put('documents/h1/doc-1', JPEG_BYTES, {
      httpMetadata: { contentType: 'image/jpeg' },
    })

    const res = await documentsApp.request(
      '/api/documents/doc-1/content?disposition=attachment',
      {},
      env
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toContain('attachment')
    expect(db.log.filter((e) => /INSERT INTO document_audit/.test(e.sql))[0]?.params[4]).toBe(
      'download'
    )
    const bad = await documentsApp.request(
      '/api/documents/doc-1/content?disposition=weird',
      {},
      env
    )
    expect(bad.status).toBe(400)
  })

  it('returns 404 when the row exists but the object is gone (dead document, no leak)', async () => {
    setup([[SCOPED_DOC_ROUTE, () => DOC_ROW({ storage_key: 'documents/h1/doc-ghost' })]])
    // Nothing put into storage under that key.
    const res = await documentsApp.request('/api/documents/doc-1/content', {}, env)
    expect(res.status).toBe(404)
  })

  it('delete (uploader): removes the object first, then row + delete audit in one batch — no orphan object', async () => {
    setup([
      [/SELECT h.id, h.name, m.role/, () => ({ id: 'h1', name: 'R', role: 'member' })],
      [SCOPED_DOC_ROUTE, () => DOC_ROW({ storage_key: 'documents/h1/doc-1', uploaded_by: 'u1' })],
    ])
    await bucket.put('documents/h1/doc-1', PDF_BYTES, {
      httpMetadata: { contentType: 'application/pdf' },
    })

    const res = await documentsApp.request('/api/documents/doc-1', { method: 'DELETE' }, env)
    expect(res.status).toBe(204)
    // The stub recorded the delete and the map is empty — no orphan.
    expect(bucket.deleted).toEqual(['documents/h1/doc-1'])
    expect(bucket.objects.size).toBe(0)
    // Audit row rides in the same batch as the DELETE, action = 'delete'.
    const audit = db.log.filter((e) => /INSERT INTO document_audit/.test(e.sql))
    expect(audit).toHaveLength(1)
    expect(audit[0]?.params[4]).toBe('delete')
    expect(
      db.log.some((e) => /DELETE FROM documents WHERE id = \? AND household_id = \?/.test(e.sql))
    ).toBe(true)
  })

  it('delete: household owner may remove another member’s upload; plain member cannot (403)', async () => {
    const docRoutes: [RegExp, (params: unknown[]) => Row | null][] = [
      [SCOPED_DOC_ROUTE, () => DOC_ROW({ storage_key: 'documents/h1/doc-1', uploaded_by: 'u2' })],
    ]

    // Owner path.
    setup([
      [/SELECT h.id, h.name, m.role/, () => ({ id: 'h1', name: 'R', role: 'owner' })],
      ...docRoutes,
    ])
    await bucket.put('documents/h1/doc-1', PDF_BYTES, {
      httpMetadata: { contentType: 'application/pdf' },
    })
    const ownerRes = await documentsApp.request('/api/documents/doc-1', { method: 'DELETE' }, env)
    expect(ownerRes.status).toBe(204)
    expect(bucket.deleted).toEqual(['documents/h1/doc-1'])

    // Member path — forbidden, object untouched.
    setup([
      [/SELECT h.id, h.name, m.role/, () => ({ id: 'h1', name: 'R', role: 'member' })],
      ...docRoutes,
    ])
    await bucket.put('documents/h1/doc-1', PDF_BYTES, {
      httpMetadata: { contentType: 'application/pdf' },
    })
    const memberRes = await documentsApp.request('/api/documents/doc-1', { method: 'DELETE' }, env)
    expect(memberRes.status).toBe(403)
    expect(bucket.deleted).toHaveLength(0)
    expect(bucket.objects.size).toBe(1)
    // No write ever ran.
    expect(db.log).toHaveLength(0)
  })

  it('rate-limits bursts of uploads per user (429 with Retry-After)', async () => {
    setup([
      [/SELECT id FROM household_members WHERE id = \? AND household_id = \?/, () => ({ id: 'm' })],
      [SCOPED_DOC_ROUTE, readBackFromLog],
    ])
    let last: Response | undefined
    for (let i = 0; i < 21; i++) {
      last = await documentsApp.request(
        '/api/documents',
        postDocument(
          uploadForm(
            { bytes: JPEG_BYTES, name: `ktp-${i}.jpg`, type: 'image/jpeg' },
            { category: 'ktp' }
          )
        ),
        env
      )
    }
    expect(last?.status).toBe(429)
    expect(last?.headers.get('Retry-After')).toBeTruthy()
  })
})
