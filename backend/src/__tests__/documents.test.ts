import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { documentsApp, UPLOAD_TRANSPORT_SLACK } from '../apps/documents.js'
import {
  sniffDocumentMime,
  sanitizeFileName,
  sanitizeDocumentName,
  sanitizeDocumentLabel,
  contentDisposition,
  DOCUMENT_MAX_FILES,
} from '../lib/documents.js'
import { resetRateLimit } from '../lib/rate-limit.js'
import { createDocumentsStub, type MockEnv } from './support/env.js'

// The document routes (ahaqqu/RumaQ#422 rework of #388) run a fixed query
// chain per request (scoped lookup, membership checks, batched writes), so
// this file routes the fake D1 on SQL fragments — the households.test.ts
// idiom — and pairs it with the R2Bucket-shaped in-memory stub
// (support/env.ts) so the REAL R2 StorageAdapter runs in every route test:
// assertions cover what was actually stored and deleted, not mock call
// counts. Synthetic bytes only — no real documents, no real PII in fixtures.

type Row = Record<string, unknown>

// Every document payload embeds its file summaries — model it so the tests
// can index `files` without unknown-narrowing noise (#422 multi-file).
type WithFiles = Row & { files: Row[] }

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
            // D1 reports per-statement meta.changes — the lib reads it off
            // the guarded insert to map a refused cap to 409.
            return { meta: { changes: 1 } }
          },
        }),
      }
    },
    batch: async (stmts: unknown[]) => {
      const results = []
      for (const stmt of stmts as Array<{ run: () => Promise<unknown> }>) {
        results.push(await stmt.run())
      }
      return results
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

// The INSERT parameter orders (lib/documents.ts) — the fake read-back
// reconstructs the rows from what was actually written. `uploaded_at` is NOT
// in the list: the INSERT omits the column on purpose so the table DEFAULT
// fills it (review A1 #422) — there is no bound param to echo.
const DOCUMENT_INSERT_COLUMNS = ['id', 'household_id', 'member_id', 'name', 'uploaded_by'] as const
const FILE_INSERT_COLUMNS = [
  'id',
  'document_id',
  'r2_key',
  'file_name',
  'size_bytes',
  'content_type',
  'label',
  'sort_order',
  'sha256',
  'uploaded_by',
] as const

// The add-file INSERT is the guarded INSERT..SELECT (review A2 #422): neither
// sort_order (computed in-statement as max+1) nor the cap bound is a plain
// column value, so the read-back derives sort_order the same way — prior file
// inserts for the document in the log, plus any seed the test declares for
// files the fixture already had, plus 1.
const GUARDED_FILE_INSERT = /INSERT INTO document_files.*SELECT/

// The lib's read-back projection: one flat row per (document, file) pair.
const JOIN_ROUTE =
  /SELECT d\.id AS document_id, d\.household_id, d\.member_id, d\.name.*LEFT JOIN document_files f/

// The documents-only row the authz flows start from.
const DOC_ROW_ROUTE =
  /SELECT d\.id, d\.household_id, d\.member_id, d\.name.*WHERE d\.id = \? AND d\.household_id = \?/

const FILE_ROW_ROUTE =
  /SELECT f\.id, f\.document_id, f\.r2_key.*JOIN documents d ON d\.id = f\.document_id/

function joinRowsFromLog(doc: Row, files: Row[]): Row[] {
  // The projection aliases d.id AS document_id — shape the fake rows the way
  // the real SQL hands them to the lib's grouping.
  const base = {
    document_id: doc.id,
    household_id: doc.household_id,
    member_id: doc.member_id ?? null,
    name: doc.name,
    uploaded_by: doc.uploaded_by,
    created_at: doc.created_at,
  }
  if (files.length === 0) {
    return [{ ...base, file_id: null }]
  }
  return files.map((file) => ({
    ...base,
    file_id: file.id,
    file_name: file.file_name,
    size_bytes: file.size_bytes,
    content_type: file.content_type,
    label: file.label ?? null,
    sort_order: file.sort_order,
    file_sha256: file.sha256,
    file_uploaded_by: file.uploaded_by,
    uploaded_at: file.uploaded_at,
  }))
}

const LIST_ROUTES: [RegExp, (params: unknown[]) => Row[]][] = [[JOIN_ROUTE, () => []]]

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
    name: 'Akta Lahir Adik',
    uploaded_by: 'u1',
    created_at: '2026-11-04 00:00:00',
    ...overrides,
  }
}

function FILE_ROW(overrides: Row = {}): Row {
  return {
    id: 'file-1',
    document_id: 'doc-1',
    r2_key: 'documents/h1/doc-1/file-1',
    file_name: 'depan.jpg',
    size_bytes: JPEG_BYTES.byteLength,
    content_type: 'image/jpeg',
    label: null,
    sort_order: 1,
    sha256: 'a'.repeat(64),
    uploaded_by: 'u1',
    uploaded_at: '2026-11-04 00:00:00',
    ...overrides,
  }
}

describe('upload sanitizers', () => {
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

  it('pins the free-text name sanitizer: trim, control chars, 120-char cap (#422)', () => {
    expect(sanitizeDocumentName('  Kartu Keluarga  ')).toBe('Kartu Keluarga')
    expect(sanitizeDocumentName('KTP\u0000\u001f Bapak')).toBe('KTP Bapak')
    expect(sanitizeDocumentName('   ')).toBeNull()
    expect(sanitizeDocumentName('')).toBeNull()
    expect(sanitizeDocumentName('x'.repeat(200))).toBe('x'.repeat(120))
  })

  it('pins the optional label sanitizer: absent/empty → null, trim, 120-char cap', () => {
    expect(sanitizeDocumentLabel(undefined)).toBeNull()
    expect(sanitizeDocumentLabel('')).toBeNull()
    expect(sanitizeDocumentLabel('   ')).toBeNull()
    expect(sanitizeDocumentLabel(' Halaman 3 ')).toBe('Halaman 3')
    expect(sanitizeDocumentLabel('y'.repeat(150))).toBe('y'.repeat(120))
  })

  it('pins the file-name sanitize + header helpers: no paths, no control chars, RFC 5987 names', () => {
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

  // The lib's read-back: createDocument/addDocumentFile re-SELECT the joined
  // projection after the batch, so the fake answers from the insert log — the
  // test sees the rows that were truly written, not a parallel fixture.
  // The DOCUMENT row comes from the last INSERT INTO documents in the log
  // (create) or the doc fixture passed in (add-file, where no document row is
  // inserted); the FILE rows come from every INSERT INTO document_files for
  // that document id.
  function readBackFromLog(params: unknown[], doc: Row): Row[] {
    const docInserts = db.log.filter((entry) => /INSERT INTO documents \(/.test(entry.sql))
    const lastDoc = docInserts[docInserts.length - 1]
    let document = doc
    if (lastDoc && lastDoc.params[0] === params[0]) {
      const row: Row = { created_at: '2026-11-04 00:00:00' }
      DOCUMENT_INSERT_COLUMNS.forEach((column, i) => {
        row[column] = lastDoc.params[i]
      })
      document = row
    }
    const fileInserts = db.log.filter((entry) => /INSERT INTO document_files/.test(entry.sql))
    const fileRows = fileInserts
      .filter((entry) => entry.params[1] === params[0])
      .map((entry) => {
        const row: Row = {}
        if (GUARDED_FILE_INSERT.test(entry.sql)) {
          // Guarded shape binds [id, doc, key, name, size, ctype, label,
          // doc(for max+1), sha, uploader, doc(for cap), MAX] — every column
          // maps 1:1 EXCEPT sort_order (column 7), which is computed
          // in-statement, and param 7 is the subquery's document_id.
          FILE_INSERT_COLUMNS.forEach((column, i) => {
            if (i !== 7) row[column] = entry.params[i]
          })
          // sort_order mimics the in-statement max+1: the fixture's
          // pre-existing files (seed) + prior inserts in the log + 1.
          const priors = fileInserts.filter(
            (prior) => prior !== entry && prior.params[1] === params[0]
          ).length
          row['sort_order'] = (fileSortSeeds[String(params[0])] ?? 0) + priors + 1
        } else {
          FILE_INSERT_COLUMNS.forEach((column, i) => {
            row[column] = entry.params[i]
          })
        }
        return row
      })
    return joinRowsFromLog(document, fileRows)
  }

  const MEMBER_ROUTE: [RegExp, (params: unknown[]) => Row | null] = [
    /SELECT id FROM household_members WHERE id = \? AND household_id = \?/,
    (params) => ({ id: params[0] as string }),
  ]
  const MEMBERSHIP_ROUTE: [RegExp, (params: unknown[]) => Row | null] = [
    /SELECT h\.id, h\.name, m\.role/,
    () => ({ id: 'h1', name: 'R', role: 'member' }),
  ]
  const COUNT_ROUTE = (count: number): [RegExp, (params: unknown[]) => Row | null] => [
    /SELECT COUNT\(\*\) AS cnt FROM document_files WHERE document_id = \?/,
    () => ({ cnt: count }),
  ]

  // Files a fixture document ALREADY holds (contiguous 1..n) — the guarded
  // insert's in-statement sort_order derives from this plus the log's priors.
  let fileSortSeeds: Record<string, number> = {}

  const setup = (
    firstRoutes: [RegExp, (params: unknown[]) => Row | null][] = [],
    allRoutes: [RegExp, (params: unknown[]) => Row[]][] = LIST_ROUTES,
    options: { fileSortSeeds?: Record<string, number> } = {}
  ) => {
    fileSortSeeds = options.fileSortSeeds ?? {}
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

  it('creates a document with a free-text name + first file: bytes under documents/<household>/<doc>/<file>, three rows in one batch (#422)', async () => {
    setup([MEMBER_ROUTE], [[JOIN_ROUTE, (params) => readBackFromLog(params, DOC_ROW())]])

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
    setup([MEMBER_ROUTE], [[JOIN_ROUTE, (params) => readBackFromLog(params, DOC_ROW())]])

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
    setup()
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
    setup(
      [
        [
          /SELECT id FROM household_members WHERE id = \? AND household_id = \?/,
          (params) => {
            memberParams = params
            return { id: params[0] as string }
          },
        ],
      ],
      [[JOIN_ROUTE, (params) => readBackFromLog(params, DOC_ROW())]]
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
    setup([[/SELECT id FROM household_members WHERE id = \? AND household_id = \?/, () => null]])
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
    setup()
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
    setup([MEMBER_ROUTE], [[JOIN_ROUTE, (params) => readBackFromLog(params, DOC_ROW())]])
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
    setup([MEMBER_ROUTE], [[JOIN_ROUTE, (params) => readBackFromLog(params, DOC_ROW())]])
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

  it('exposes the transport slack through the app module (the pre-parse bound is cap + slack)', () => {
    // Pinned so the A1 contract cannot silently drift: the slack exists to
    // let an exactly-10 MB multipart body reach the exact post-parse cap.
    expect(UPLOAD_TRANSPORT_SLACK).toBe(64 * 1024)
  })

  it('refuses to touch storage when a row carries a key outside the vault namespace (review B1)', async () => {
    setup([
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

  it('rejects magic bytes that do not match the declared type (415) — sniff policy is reject, never override', async () => {
    setup()
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
    setup([[DOC_ROW_ROUTE, () => DOC_ROW()]])
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
    setup(
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
    setup([
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
    setup([
      [DOC_ROW_ROUTE, () => DOC_ROW()],
      // The file lookup binds fileId + documentId + householdId — a file id
      // from a DIFFERENT document must miss.
      [FILE_ROW_ROUTE, (params) => (params[1] === 'doc-1' ? FILE_ROW() : null)],
    ])
    const res = await documentsApp.request('/api/documents/doc-other/files/file-1/content', {}, env)
    expect(res.status).toBe(404)
  })

  it('adds a file to an existing document: sort_order = max + 1, bytes stored, file_add audit carries the file id (#422)', async () => {
    setup(
      [[DOC_ROW_ROUTE, () => DOC_ROW()], COUNT_ROUTE(1)],
      [[JOIN_ROUTE, (params) => readBackFromLog(params, DOC_ROW())]],
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
    setup([[DOC_ROW_ROUTE, () => DOC_ROW()], COUNT_ROUTE(DOCUMENT_MAX_FILES)])
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

  it('streams one file’s content inline with stored mime, private no-store, and audits a view per file', async () => {
    setup([
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
    setup([
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
    setup([
      [DOC_ROW_ROUTE, () => DOC_ROW()],
      [FILE_ROW_ROUTE, () => FILE_ROW({ r2_key: 'documents/h1/doc-1/file-ghost' })],
    ])
    // Nothing put into storage under that key.
    const res = await documentsApp.request('/api/documents/doc-1/files/file-1/content', {}, env)
    expect(res.status).toBe(404)
  })

  it('delete-file (uploader): removes the object first, then row + file_delete audit in one batch — no orphan', async () => {
    setup([MEMBERSHIP_ROUTE, [DOC_ROW_ROUTE, () => DOC_ROW()], [FILE_ROW_ROUTE, () => FILE_ROW()]])
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
    setup([MEMBERSHIP_ROUTE, ...fileRoutes])
    await bucket.put('documents/h1/doc-1/file-1', PDF_BYTES, {
      httpMetadata: { contentType: 'application/pdf' },
    })
    const uploaderRes = await documentsApp.request(
      '/api/documents/doc-1/files/file-1',
      { method: 'DELETE' },
      env
    )
    expect(uploaderRes.status).toBe(204)
    expect(bucket.deleted).toEqual(['documents/h1/doc-1/file-1'])

    // Owner path.
    setup([
      [/SELECT h\.id, h\.name, m\.role/, () => ({ id: 'h1', name: 'R', role: 'owner' })],
      ...fileRoutes,
    ])
    await bucket.put('documents/h1/doc-1/file-1', PDF_BYTES, {
      httpMetadata: { contentType: 'application/pdf' },
    })
    const ownerRes = await documentsApp.request(
      '/api/documents/doc-1/files/file-1',
      { method: 'DELETE' },
      env
    )
    expect(ownerRes.status).toBe(204)

    // Plain member path — forbidden, object untouched.
    setup([
      [/SELECT h\.id, h\.name, m\.role/, () => ({ id: 'h1', name: 'R', role: 'member' })],
      [
        DOC_ROW_ROUTE,
        () => DOC_ROW({ uploaded_by: 'u3' }), // not the caller either
      ],
      ...fileRoutes.slice(1),
    ])
    await bucket.put('documents/h1/doc-1/file-1', PDF_BYTES, {
      httpMetadata: { contentType: 'application/pdf' },
    })
    const memberRes = await documentsApp.request(
      '/api/documents/doc-1/files/file-1',
      { method: 'DELETE' },
      env
    )
    expect(memberRes.status).toBe(403)
    expect(bucket.deleted).toHaveLength(0)
    expect(bucket.objects.size).toBe(1)
    // No write ever ran.
    expect(db.log).toHaveLength(0)
  })

  const FILES_LIST_ROUTE: [RegExp, (params: unknown[]) => Row[]] = [
    /SELECT id, document_id, r2_key, file_name, size_bytes, content_type/,
    () => [
      FILE_ROW({ id: 'file-1', r2_key: 'documents/h1/doc-1/file-1' }),
      FILE_ROW({ id: 'file-2', r2_key: 'documents/h1/doc-1/file-2', sort_order: 2 }),
    ],
  ]

  it('delete-document: every file object goes first, then the row (files cascade) + delete audit in one batch', async () => {
    setup([MEMBERSHIP_ROUTE, [DOC_ROW_ROUTE, () => DOC_ROW()]], [FILES_LIST_ROUTE])
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
    setup(
      [
        [/SELECT h\.id, h\.name, m\.role/, () => ({ id: 'h1', name: 'R', role: 'owner' })],
        [DOC_ROW_ROUTE, () => DOC_ROW({ uploaded_by: 'u2' })],
      ],
      [SINGLE_FILE_LIST_ROUTE]
    )
    await bucket.put('documents/h1/doc-1/file-1', PDF_BYTES, {
      httpMetadata: { contentType: 'application/pdf' },
    })
    const ownerRes = await documentsApp.request('/api/documents/doc-1', { method: 'DELETE' }, env)
    expect(ownerRes.status).toBe(204)
    expect(bucket.deleted).toEqual(['documents/h1/doc-1/file-1'])

    // Member path — forbidden, object untouched.
    setup(
      [
        [/SELECT h\.id, h\.name, m\.role/, () => ({ id: 'h1', name: 'R', role: 'member' })],
        [DOC_ROW_ROUTE, () => DOC_ROW({ uploaded_by: 'u2' })],
      ],
      [SINGLE_FILE_LIST_ROUTE]
    )
    await bucket.put('documents/h1/doc-1/file-1', PDF_BYTES, {
      httpMetadata: { contentType: 'application/pdf' },
    })
    const memberRes = await documentsApp.request('/api/documents/doc-1', { method: 'DELETE' }, env)
    expect(memberRes.status).toBe(403)
    expect(bucket.deleted).toHaveLength(0)
    expect(bucket.objects.size).toBe(1)
    // No write ever ran.
    expect(db.log).toHaveLength(0)
  })

  it('rate-limits bursts of uploads per user (429 with Retry-After) across both upload endpoints', async () => {
    setup(
      [[DOC_ROW_ROUTE, () => DOC_ROW()], COUNT_ROUTE(0), MEMBER_ROUTE],
      [[JOIN_ROUTE, (params) => readBackFromLog(params, DOC_ROW())]]
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
