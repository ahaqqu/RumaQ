// Shared harness for the document route tests (ahaqqu/RumaQ#422). The route
// surface grew past one file's worth of seams, so the fake D1 + R2 stub +
// fixtures live here and the three sibling test files (documents.test.ts —
// create/list/bounds; documents-files.test.ts — content streaming + deletes;
// documents-lib.test.ts — sanitizer units) import from one place.
//
// The document routes run a fixed query chain per request (scoped lookup,
// membership checks, batched writes), so the fake routes on SQL fragments —
// the households.test.ts idiom — and pairs with the R2Bucket-shaped
// in-memory stub (support/env.ts) so the REAL R2 StorageAdapter runs in
// every route test: assertions cover what was actually stored and deleted,
// not mock call counts. Synthetic bytes only — no real documents, no real
// PII in fixtures.
import { createDocumentsPlugin } from '../../plugins/documents/app.js'
import { createR2StorageAdapter } from '../../ports/storage/r2.js'
import { createDocumentsStub, type MockEnv } from './env.js'

export type Row = Record<string, unknown>

// Every document payload embeds its file summaries — model it so the tests
// can index `files` without unknown-narrowing noise (#422 multi-file).
export type WithFiles = Row & { files: Row[] }

export type FakeDb = {
  prepare: (sql: string) => {
    // The REAL D1 interface: a prepared statement answers directly (no
    // parameters) AND through bind(). The plugin gate's flags read uses the
    // unbound form — both levels route through the same SQL-fragment routes.
    first: <T>() => Promise<T | null>
    all: <T>() => Promise<{ results: T[] }>
    run: () => Promise<unknown>
    bind: (...params: unknown[]) => {
      first: <T>() => Promise<T | null>
      all: <T>() => Promise<{ results: T[] }>
      run: () => Promise<unknown>
    }
  }
  batch: (stmts: unknown[]) => Promise<unknown[]>
  log: Array<{ sql: string; params: unknown[] }>
}

// Plugin gate defaults (ahaqqu/RumaQ#435): every documents request now reads
// the caller's enablement row (first()) and the deployment flag list (all())
// before the route handler. The defaults model the ABSENT-row state — the
// manifest default (documents → enabled) and an empty flag table — which is
// exactly phase-A behavior, so the pre-gate tests stay green untouched.
// Appended AFTER the test-declared routes, so a test overrides either
// statement by declaring its own route (plugin-gate.test.ts does).
const GATE_DEFAULT_FIRST_ROUTES: [RegExp, (params: unknown[]) => Row | null][] = [
  [/FROM household_plugins/, () => null],
]
const GATE_DEFAULT_ALL_ROUTES: [RegExp, (params: unknown[]) => Row[]][] = [
  [/SELECT key, value FROM deployment_flags/, () => []],
]

export function createFakeDb(
  firstRoutes: [RegExp, (params: unknown[]) => Row | null][] = [],
  allRoutes: [RegExp, (params: unknown[]) => Row[]][] = []
): FakeDb {
  const log: Array<{ sql: string; params: unknown[] }> = []
  const firstWithGateDefaults = [...firstRoutes, ...GATE_DEFAULT_FIRST_ROUTES]
  const allWithGateDefaults = [...allRoutes, ...GATE_DEFAULT_ALL_ROUTES]
  return {
    log,
    prepare: (sql: string) => {
      const flat = sql.replace(/\s+/g, ' ')
      const exec = (params: unknown[]) => ({
        first: async <T>() => {
          const hit = firstWithGateDefaults.find(([re]) => re.test(flat))
          if (!hit) throw new Error(`fake DB: no first() route for: ${sql}`)
          return ((await hit[1](params)) as T) ?? null
        },
        all: async <T>() => {
          const hit = allWithGateDefaults.find(([re]) => re.test(flat))
          if (!hit) throw new Error(`fake DB: no all() route for: ${sql}`)
          return { results: (await hit[1](params)) as T[] }
        },
        run: async () => {
          log.push({ sql: flat, params })
          // D1 reports per-statement meta.changes — the lib reads it off
          // the guarded insert to map a refused cap to 409.
          return { meta: { changes: 1 } }
        },
      })
      // Both D1 shapes: prepare().all() and prepare().bind(...).all().
      return { ...exec([]), bind: (...params: unknown[]) => exec(params) }
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

export function createEnv(db: FakeDb, overrides: Partial<MockEnv> = {}): MockEnv {
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
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
])
export const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
export const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56,
])
export const TEXT_BYTES = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]) // "hello"

// The INSERT parameter orders (plugins/documents/lib.ts) — the fake read-back
// reconstructs the rows from what was actually written. `uploaded_at` is NOT
// in the list: the INSERT omits the column on purpose so the table DEFAULT
// fills it (review A1 #422) — there is no bound param to echo.
export const DOCUMENT_INSERT_COLUMNS = [
  'id',
  'household_id',
  'member_id',
  'name',
  'uploaded_by',
] as const
export const FILE_INSERT_COLUMNS = [
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
export const GUARDED_FILE_INSERT = /INSERT INTO document_files.*SELECT/

// The lib's read-back projection: one flat row per (document, file) pair.
export const JOIN_ROUTE =
  /SELECT d\.id AS document_id, d\.household_id, d\.member_id, d\.name.*LEFT JOIN document_files f/

// The documents-only row the authz flows start from.
export const DOC_ROW_ROUTE =
  /SELECT d\.id, d\.household_id, d\.member_id, d\.name.*WHERE d\.id = \? AND d\.household_id = \?/

export const FILE_ROW_ROUTE =
  /SELECT f\.id, f\.document_id, f\.r2_key.*JOIN documents d ON d\.id = f\.document_id/

export const LIST_ROUTES: [RegExp, (params: unknown[]) => Row[]][] = [[JOIN_ROUTE, () => []]]

export const MEMBER_ROUTE: [RegExp, (params: unknown[]) => Row | null] = [
  /SELECT id FROM household_members WHERE id = \? AND household_id = \?/,
  (params) => ({ id: params[0] as string }),
]

export const MEMBERSHIP_ROUTE: [RegExp, (params: unknown[]) => Row | null] = [
  /SELECT h\.id, h\.name, m\.role/,
  () => ({ id: 'h1', name: 'R', role: 'member' }),
]

export const COUNT_ROUTE = (count: number): [RegExp, (params: unknown[]) => Row | null] => [
  /SELECT COUNT\(\*\) AS cnt FROM document_files WHERE document_id = \?/,
  () => ({ cnt: count }),
]

export function joinRowsFromLog(doc: Row, files: Row[]): Row[] {
  // The projection aliases d.id AS document_id — shape the fake rows the way
  // the real SQL hands them to the lib's grouping. expires_on/remind_days_before
  // ride the projection since #426 (days_until_expiry is computed by the lib,
  // never stored, so it is NOT part of the raw row shape).
  const base = {
    document_id: doc.id,
    household_id: doc.household_id,
    member_id: doc.member_id ?? null,
    name: doc.name,
    uploaded_by: doc.uploaded_by,
    created_at: doc.created_at,
    expires_on: doc.expires_on ?? null,
    remind_days_before: doc.remind_days_before ?? null,
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

export function uploadForm(
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
export function postDocument(form: FormData): RequestInit {
  return { method: 'POST', body: form }
}

export function DOC_ROW(overrides: Row = {}): Row {
  return {
    id: 'doc-1',
    household_id: 'h1',
    member_id: null,
    name: 'Akta Lahir Adik',
    uploaded_by: 'u1',
    created_at: '2026-11-04 00:00:00',
    expires_on: null,
    remind_days_before: null,
    ...overrides,
  }
}

export function FILE_ROW(overrides: Row = {}): Row {
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

// One harness per test file: `setup` rebinds the fake + stub + seeds per test
// and hands the trio back, so no module state bleeds across files. `app` is
// composed through the REAL plugin factory (createDocumentsPlugin) with the
// per-test R2 stub injected as ports.storage — exactly the wiring the
// registry performs against the real binding (ticket 4 #438), so route tests
// exercise the factory output, adapter included.
export function createDocumentsHarness() {
  let db: FakeDb
  let env: MockEnv
  let bucket: ReturnType<typeof createDocumentsStub>
  let app: ReturnType<typeof createDocumentsPlugin>['app']

  // Files a fixture document ALREADY holds (contiguous 1..n) — the guarded
  // insert's in-statement sort_order derives from this plus the log's priors.
  let fileSortSeeds: Record<string, number> = {}

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

  function setup(
    firstRoutes: [RegExp, (params: unknown[]) => Row | null][] = [],
    allRoutes: [RegExp, (params: unknown[]) => Row[]][] = LIST_ROUTES,
    options: { fileSortSeeds?: Record<string, number> } = {}
  ) {
    fileSortSeeds = options.fileSortSeeds ?? {}
    db = createFakeDb(firstRoutes, allRoutes)
    bucket = createDocumentsStub()
    env = createEnv(db, { DOCUMENTS: bucket as unknown as MockEnv['DOCUMENTS'] })
    app = createDocumentsPlugin({
      ports: {
        // Same cast idiom as the env line above — the stub is R2Bucket-shaped
        // for put/get/delete, the only methods the adapter calls.
        storage: createR2StorageAdapter(env.DOCUMENTS as unknown as R2Bucket),
      },
    }).app
    return { db, env, bucket, app }
  }

  return { setup, readBackFromLog }
}
