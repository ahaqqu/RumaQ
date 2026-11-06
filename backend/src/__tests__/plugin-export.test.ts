import { describe, it, expect, beforeEach } from 'vite-plus/test'
// @ts-expect-error — no node types in this tsconfig
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error — no node types in this tsconfig
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error — no node types in this tsconfig
import { join, dirname } from 'node:path'
// @ts-expect-error — no node types in this tsconfig
import { fileURLToPath } from 'node:url'

import { pluginsApp } from '../apps/plugins.js'
import { resetRateLimit } from '../lib/rate-limit.js'
import { createDocumentsExportJob } from '../plugins/documents/export.js'
import { addDocumentFile, createDocument, DOCUMENT_MAX_FILES } from '../plugins/documents/lib.js'
import type { StorageAdapter } from '../ports/storage/index.js'
import { createR2StorageAdapter } from '../ports/storage/r2.js'
import { EXPORT_ARCHIVE_FILE_BUDGET } from '../lib/plugin-export.js'
import { PluginExportCursorError } from '../plugins/types.js'
import { crc32 } from '../lib/zip.js'
import { createDocumentsStub } from './support/env.js'
import type { Env } from '../types.js'

// The plugin export route + job (ahaqqu/RumaQ#440 — plugin architecture
// ticket 6), following the plugin-purge.test.ts pattern: the data claims
// (byte integrity, household scoping, chunking) are SQL + storage semantics
// so they run against a REAL SQLite engine (node:sqlite — D1 is SQLite) with
// the shipped migrations and a REAL R2 adapter over an in-memory bucket.
// The archive is parsed with the hand-written reader (no third-party parser
// exists to lean on — the writer is the dependency-free point of the
// ticket), so every structural claim about the zip is proven, not assumed:
//
//   - ZIP STRUCTURE VALIDITY: central directory parses, local headers sit
//     where the directory says, method 0, UTF-8 flag, EOCD counts match,
//   - BYTE INTEGRITY: exported bytes == stored bytes, and the sha256 the
//     files.csv row carries re-verifies over the extracted bytes,
//   - HOUSEHOLD SCOPING (the C1- standard): a two-household vault exports
//     ZERO rows, names, or bytes of the other household,
//   - CHUNKING: a 60-file vault (3 × 20) exports as two chained archives of
//     whole documents (40 + 20) with a cursor that is household-bound,
//   - the half-dead-vault states (missing object, namespace-guarded key)
//     skip-with-note instead of failing the whole export,
//   - every archive writes ONE plugin_exported receipt with the owner as
//     actor (0036's widened CHECK).

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

// A D1-shaped adapter over node:sqlite — with a batch() that executes each
// statement in one transaction and returns SELECT results (the export job's
// receipt-first batch carries the document page SELECT; the purge suite's
// meta-only batch cannot serve it).
function createD1Adapter(sqlite: Db): D1Database {
  const makeStatement = (sql: string, params: unknown[]) => {
    const isSelect = /^\s*(SELECT|WITH)/i.test(sql)
    return {
      _sql: sql,
      first: async <T>() => (sqlite.prepare(sql).get(...params) as T | undefined) ?? null,
      all: async <T>() => ({ results: sqlite.prepare(sql).all(...params) as T[] }),
      run: async () => {
        const info = sqlite.prepare(sql).run(...params)
        return { meta: { changes: info.changes } }
      },
      _execute: async () => {
        if (isSelect) {
          return { results: sqlite.prepare(sql).all(...params) }
        }
        const info = sqlite.prepare(sql).run(...params)
        return { meta: { changes: info.changes } }
      },
    }
  }
  return {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => makeStatement(sql, params),
    }),
    batch: async (stmts: Array<{ _execute: () => Promise<unknown> }>) => {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const stmt of stmts) {
          results.push(await stmt._execute())
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

function seedHousehold(sqlite: Db, id: string, role = 'owner'): string {
  const userId = `u-${id}`
  sqlite.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(userId, `${id}@b.com`)
  sqlite
    .prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)')
    .run(id, `Keluarga ${id}`, userId)
  sqlite
    .prepare(
      `INSERT INTO household_members (id, household_id, user_id, role)
       VALUES (?, ?, ?, ?)`
    )
    .run(`m-${id}`, id, userId, role)
  return userId
}

// Route env: the REAL composed stack — node:sqlite D1 behind the DB binding
// and the real R2 adapter over the stub bucket behind DOCUMENTS, so the
// registry's factory wiring (the T4 seam) is exercised end-to-end through
// pluginsApp.
function createRouteEnv(
  sqlite: Db,
  bucket: unknown,
  props: { userId: string; householdId: string } | undefined
): Env['Bindings'] {
  return {
    DB: createD1Adapter(sqlite),
    DOCUMENTS: bucket,
    RECEIPTS: {},
    BROCHURES: {},
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    WORKER_JWT_SECRET: 'test-secret',
    WORKER_ENCRYPTION_KEY: 'test-enc-key',
    PAGES_ORIGIN: 'http://localhost:5173',
    EMAIL_AUTH_ENABLED: 'false',
    ASSETS: undefined,
    props,
    TEST_MODE: 'true',
  } as unknown as Env['Bindings']
}

// ---------------------------------------------------------------------------
// The hand-written ZIP reader (same discipline as zip.test.ts): signatures,
// method 0, UTF-8 flag, local headers where the directory says, CRC
// recomputed over the extracted bytes, CD ending exactly at the EOCD.
// ---------------------------------------------------------------------------

type ParsedEntry = { name: string; crc: number; size: number; bytes: Uint8Array<ArrayBuffer> }

function parseZip(bytes: Uint8Array<ArrayBuffer>): Map<string, ParsedEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('no EOCD record found')
  const total = view.getUint16(eocd + 10, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  const entries = new Map<string, ParsedEntry>()
  let at = cdOffset
  for (let n = 0; n < total; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('bad central directory signature')
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const crc = view.getUint32(at + 16, true)
    const size = view.getUint32(at + 20, true)
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    const localOffset = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen))
    if (method !== 0) throw new Error(`entry ${name}: not stored (method ${method})`)
    if ((flags & 0x0800) !== 0x0800) throw new Error(`entry ${name}: UTF-8 flag not set`)
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`entry ${name}: bad local header signature`)
    }
    const lfhNameLen = view.getUint16(localOffset + 26, true)
    const lfhExtraLen = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + lfhNameLen + lfhExtraLen
    const data = bytes.subarray(dataStart, dataStart + size)
    if (crc32(data) !== crc) throw new Error(`entry ${name}: CRC mismatch over extracted bytes`)
    entries.set(name, { name, crc, size, bytes: data })
    at += 46 + nameLen + extraLen + commentLen
  }
  if (at !== eocd) throw new Error('central directory does not end at the EOCD record')
  return entries
}

async function readArchive(res: Response): Promise<Map<string, ParsedEntry>> {
  return parseZip(new Uint8Array(await res.arrayBuffer()))
}

// The CSV text as RFC 4180 rows — a real field reader (quotes span embedded
// commas/newlines, doubled quotes are literals), because the suite
// deliberately seeds names like `Akta Lahir, file "resmi"` that a naive
// split() would shred.
function csvRecords(entry: ParsedEntry | undefined): string[][] {
  if (!entry) throw new Error('csv entry missing from archive')
  // ignoreBOM=true keeps the BOM in the output — the default utf-8
  // decoder STRIPS it, which would make the BOM assertion vacuous.
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(entry.bytes)
  if (!text.startsWith('\uFEFF')) throw new Error('csv without BOM')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let at = 1 // past the BOM
  while (at < text.length) {
    const ch = text[at]
    if (inQuotes) {
      if (ch === '"') {
        if (text[at + 1] === '"') {
          field += '"'
          at += 2
          continue
        }
        inQuotes = false
        at++
        continue
      }
      field += ch
      at++
      continue
    }
    if (ch === '"') {
      inQuotes = true
      at++
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      at++
      continue
    }
    if (ch === '\r' && text[at + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      at += 2
      continue
    }
    field += ch
    at++
  }
  // The writer ends the table WITHOUT a trailing CRLF — the final record
  // closes at end-of-text.
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

type Manifest = {
  format: string
  archive: { documents: number; files: number; missing_files: number; bytes: number }
  next_cursor: string | null
  household_id: string
}

function manifestOf(entries: Map<string, ParsedEntry>): Manifest {
  const entry = entries.get('manifest.json')
  if (!entry) throw new Error('manifest.json missing from archive')
  return JSON.parse(new TextDecoder().decode(entry.bytes)) as Manifest
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) // %PDF-
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xaa, 0xbb])

async function seedDoc(
  db: D1Database,
  storage: StorageAdapter,
  args: {
    householdId: string
    name: string
    files: Array<{
      fileName: string
      bytes: Uint8Array<ArrayBuffer>
      mime: string
      label?: string | null
    }>
  }
): Promise<string> {
  let documentId: string | null = null
  for (const file of args.files) {
    if (documentId === null) {
      const created = await createDocument(db, storage, {
        householdId: args.householdId,
        memberId: null,
        name: args.name,
        file: {
          fileName: file.fileName,
          bytes: file.bytes,
          mime: file.mime,
          label: file.label ?? null,
        },
        uploadedBy: `u-${args.householdId}`,
      })
      documentId = created.id
    } else {
      await addDocumentFile(db, storage, {
        householdId: args.householdId,
        documentId,
        file: {
          fileName: file.fileName,
          bytes: file.bytes,
          mime: file.mime,
          label: file.label ?? null,
        },
        uploadedBy: `u-${args.householdId}`,
      })
    }
  }
  return documentId as string
}

async function createStorage(bucket: unknown): Promise<StorageAdapter> {
  return createR2StorageAdapter(bucket as R2Bucket)
}

beforeEach(() => {
  resetRateLimit()
})

describe('plugin export route — authz matrix (#440)', () => {
  it('401s without a session', async () => {
    const { sqlite } = createDb()
    const env = createRouteEnv(sqlite, {}, undefined)
    const res = await pluginsApp.request('/api/plugins/documents/export', {}, env)
    expect(res.status).toBe(401)
  })

  it('403s a plain member (the exfiltration-sized payload is owner-tier)', async () => {
    const { sqlite } = createDb()
    const ownerId = seedHousehold(sqlite, 'h1')
    // A plain member of the SAME household — the role the gate reads.
    sqlite.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u-member', 'member@b.com')
    sqlite
      .prepare(
        `INSERT INTO household_members (id, household_id, user_id, role)
         VALUES ('m-member', 'h1', 'u-member', 'member')`
      )
      .run()
    const d1 = createD1Adapter(sqlite)
    const bucket = createDocumentsStub()
    await seedDoc(d1, await createStorage(bucket), {
      householdId: 'h1',
      name: 'Akta',
      files: [{ fileName: 'a.pdf', bytes: PDF, mime: 'application/pdf' }],
    })
    void ownerId
    const env = createRouteEnv(sqlite, bucket, { userId: 'u-member', householdId: 'h1' })
    const res = await pluginsApp.request('/api/plugins/documents/export', {}, env)
    expect(res.status).toBe(403)
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
  })

  it('404s an unknown plugin id (no existence leak beyond the registry)', async () => {
    const { sqlite } = createDb()
    seedHousehold(sqlite, 'h1')
    const env = createRouteEnv(sqlite, {}, { userId: 'u-h1', householdId: 'h1' })
    const res = await pluginsApp.request('/api/plugins/no-such-plugin/export', {}, env)
    expect(res.status).toBe(404)
  })
})

describe('plugin export — one archive, bytes + metadata (real SQL, #440)', () => {
  it('exports the household vault: byte integrity, sha256 cross-check, receipt, honest headers', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1')
    const bucket = createDocumentsStub()
    const storage = await createStorage(bucket)

    const docA = await seedDoc(d1, storage, {
      householdId: 'h1',
      name: 'Akta Lahir, file "resmi"',
      files: [
        { fileName: 'akta.pdf', bytes: PDF, mime: 'application/pdf', label: 'Asli' },
        { fileName: 'akta-2.pdf', bytes: JPEG, mime: 'image/jpeg', label: null },
      ],
    })
    const docB = await seedDoc(d1, storage, {
      householdId: 'h1',
      name: 'KTP',
      files: [{ fileName: 'ktp.jpg', bytes: JPEG, mime: 'image/jpeg' }],
    })

    const env = createRouteEnv(sqlite, bucket, { userId: 'u-h1', householdId: 'h1' })
    const res = await pluginsApp.request('/api/plugins/documents/export', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/zip')
    expect(res.headers.get('Content-Disposition')).toContain('attachment')
    expect(res.headers.get('Content-Disposition')).toContain('.zip')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('X-Export-Next-Cursor')).toBeNull()

    // ZIP structure validity + the metadata tables.
    const entries = await readArchive(res)
    expect([...entries.keys()].sort()).toEqual(
      [
        'documents.csv',
        'files.csv',
        'manifest.json',
        `files/${docA}/1-akta.pdf`,
        `files/${docA}/2-akta-2.pdf`,
        `files/${docB}/1-ktp.jpg`,
      ].sort()
    )

    const manifest = manifestOf(entries)
    expect(manifest.format).toBe('rumaq-plugin-export')
    expect(manifest.household_id).toBe('h1')
    expect(manifest.archive).toEqual({
      documents: 2,
      files: 3,
      missing_files: 0,
      bytes: PDF.byteLength + JPEG.byteLength * 2,
    })
    expect(manifest.next_cursor).toBeNull()

    const docRows = csvRecords(entries.get('documents.csv'))
    expect(docRows[0]).toEqual([
      'id',
      'household_id',
      'member_id',
      'name',
      'uploaded_by',
      'created_at',
      'expires_on',
      'remind_days_before',
    ])
    const names = docRows
      .slice(1)
      .map((r) => r[3])
      .sort()
    expect(names).toEqual(['Akta Lahir, file "resmi"', 'KTP'])

    const fileRows = csvRecords(entries.get('files.csv'))
    expect(fileRows[0]).toEqual([
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
    ])
    expect(fileRows).toHaveLength(4)

    // BYTE INTEGRITY: every archived file equals the bytes the vault stored,
    // and the sha256 the row carries re-verifies over the extracted bytes.
    const expectedBytes = new Map<string, Uint8Array>([
      [`files/${docA}/1-akta.pdf`, PDF],
      [`files/${docA}/2-akta-2.pdf`, JPEG],
      [`files/${docB}/1-ktp.jpg`, JPEG],
    ])
    for (const [path, wanted] of expectedBytes) {
      const entry = entries.get(path)
      if (!entry) throw new Error(`missing archive entry ${path}`)
      expect(entry.size).toBe(wanted.byteLength)
      expect([...entry.bytes]).toEqual([...wanted])
    }
    for (const row of fileRows.slice(1)) {
      const [id, , path, , , size, label, sort, sha256] = row
      void id
      const entry = entries.get(path)
      expect(entry).toBeTruthy()
      expect(entry!.size).toBe(Number(size))
      expect(crc32(entry!.bytes)).toBe(entry!.crc)
      const { sha256HexBytes } = await import('../lib/crypto.js')
      expect(await sha256HexBytes(entry!.bytes)).toBe(sha256)
      // The label: quoted-field CSV round-trip (the name row above pins the
      // quoting; the label pins it too).
      if (path === `files/${docA}/1-akta.pdf`) expect(label).toBe('Asli')
      expect(sort).toBe(path.split('/')[2].split('-')[0])
    }

    // ONE plugin_exported receipt per archive, actor = the owner (0036).
    const receipts = sqlite
      .prepare(
        `SELECT household_id, plugin_id, actor_user_id, action FROM household_plugin_audit
          WHERE action = 'plugin_exported'`
      )
      .all()
    expect(receipts).toEqual([
      {
        household_id: 'h1',
        plugin_id: 'documents',
        actor_user_id: 'u-h1',
        action: 'plugin_exported',
      },
    ])
  })

  it('exports an empty vault: a valid archive with header-only CSVs and no cursor', async () => {
    const { sqlite } = createDb()
    seedHousehold(sqlite, 'h1')
    const bucket = createDocumentsStub()
    const env = createRouteEnv(sqlite, bucket, { userId: 'u-h1', householdId: 'h1' })

    const res = await pluginsApp.request('/api/plugins/documents/export', {}, env)
    expect(res.status).toBe(200)
    const entries = await readArchive(res)
    expect([...entries.keys()].sort()).toEqual(
      ['documents.csv', 'files.csv', 'manifest.json'].sort()
    )
    expect(csvRecords(entries.get('documents.csv'))).toHaveLength(1)
    expect(csvRecords(entries.get('files.csv'))).toHaveLength(1)
    expect(manifestOf(entries).archive).toEqual({
      documents: 0,
      files: 0,
      missing_files: 0,
      bytes: 0,
    })
    expect(manifestOf(entries).next_cursor).toBeNull()

    // Even the empty export records its receipt — an export happened.
    const receipts = sqlite
      .prepare(
        `SELECT actor_user_id, action FROM household_plugin_audit WHERE action = 'plugin_exported'`
      )
      .all()
    expect(receipts).toEqual([{ actor_user_id: 'u-h1', action: 'plugin_exported' }])
  })

  it('never leaks another household: zero rows, names, or bytes of h2 in h1’s archive', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1')
    seedHousehold(sqlite, 'h2')
    const bucket = createDocumentsStub()
    const storage = await createStorage(bucket)

    await seedDoc(d1, storage, {
      householdId: 'h1',
      name: 'Dokumen sendiri',
      files: [{ fileName: 'ours.pdf', bytes: PDF, mime: 'application/pdf' }],
    })
    const foreignDoc = await seedDoc(d1, storage, {
      householdId: 'h2',
      name: 'Dokumen tetangga',
      files: [{ fileName: 'theirs.pdf', bytes: JPEG, mime: 'image/jpeg' }],
    })

    const env = createRouteEnv(sqlite, bucket, { userId: 'u-h1', householdId: 'h1' })
    const res = await pluginsApp.request('/api/plugins/documents/export', {}, env)
    expect(res.status).toBe(200)
    const entries = await readArchive(res)
    const manifest = manifestOf(entries)
    expect(manifest.archive).toEqual({
      documents: 1,
      files: 1,
      missing_files: 0,
      bytes: PDF.byteLength,
    })

    // No h2 artifact anywhere in the archive: not in the entry names, not
    // in any CSV row, not in any bytes.
    for (const name of entries.keys()) {
      expect(name).not.toContain(foreignDoc)
    }
    for (const key of ['documents.csv', 'files.csv']) {
      const text = new TextDecoder().decode(entries.get(key)!.bytes)
      expect(text).not.toContain(foreignDoc)
      expect(text).not.toContain('theirs.pdf')
      expect(text).not.toContain('Dokumen tetangga')
    }
    const theirs = [...entries.values()].find((e) => e.name.endsWith('theirs.pdf'))
    expect(theirs).toBeUndefined()

    // The other household's rows and bytes are untouched by the read.
    const h2Count = sqlite
      .prepare('SELECT COUNT(*) AS cnt FROM documents WHERE household_id = ?')
      .get('h2') as { cnt: number }
    expect(h2Count.cnt).toBe(1)
    expect(bucket.objects.size).toBe(2)
  })

  it('non-ASCII file names survive the archive (UTF-8 entry names)', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1')
    const bucket = createDocumentsStub()
    const storage = await createStorage(bucket)
    const doc = await seedDoc(d1, storage, {
      householdId: 'h1',
      name: 'Surat Warisan',
      files: [{ fileName: 'akta bayi₂ “resmi”.pdf', bytes: PDF, mime: 'application/pdf' }],
    })
    const env = createRouteEnv(sqlite, bucket, { userId: 'u-h1', householdId: 'h1' })
    const res = await pluginsApp.request('/api/plugins/documents/export', {}, env)
    const entries = await readArchive(res)
    expect([...entries.keys()]).toContain(`files/${doc}/1-akta bayi₂ “resmi”.pdf`)
    expect([...entries.get(`files/${doc}/1-akta bayi₂ “resmi”.pdf`)!.bytes]).toEqual([...PDF])
  })
})

describe('plugin export — chunked archives over the subrequest budget (#440)', () => {
  it('chains whole-document archives: 3×20-file vault → 40 + 20, union complete, no split document', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1')
    const bucket = createDocumentsStub()
    const storage = await createStorage(bucket)
    expect(EXPORT_ARCHIVE_FILE_BUDGET).toBe(40)
    expect(EXPORT_ARCHIVE_FILE_BUDGET).toBeGreaterThanOrEqual(DOCUMENT_MAX_FILES)

    const payloads: Map<string, Uint8Array> = new Map()
    const docIds: string[] = []
    for (let d = 0; d < 3; d++) {
      const docId = await seedDoc(d1, storage, {
        householdId: 'h1',
        name: `Dokumen ${d}`,
        files: Array.from({ length: 20 }, (_, i) => {
          // Distinct bytes per file — the byte-integrity claim must cover
          // every entry, not a shared fixture.
          const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, d, i])
          return { fileName: `f${d}-${i}.pdf`, bytes, mime: 'application/pdf' }
        }),
      })
      docIds.push(docId)
      for (let i = 0; i < 20; i++) {
        payloads.set(
          `files/${docId}/${i + 1}-f${d}-${i}.pdf`,
          new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, d, i])
        )
      }
    }

    const env = createRouteEnv(sqlite, bucket, { userId: 'u-h1', householdId: 'h1' })

    // Archive 1: the first TWO documents in the export's keyset order
    // (created_at ASC, id ASC — same-second creations tie-break by uuid, so
    // the expected split is DERIVED from the shipped ordering, never
    // assumed from creation order), whole — the third document rides the
    // cursor, never split across archives.
    const keysetOrder = (
      sqlite
        .prepare('SELECT id FROM documents WHERE household_id = ? ORDER BY created_at ASC, id ASC')
        .all('h1') as Array<{ id: string }>
    ).map((r) => r.id)
    const firstTwo = keysetOrder.slice(0, 2)
    const third = keysetOrder[2]
    const res1 = await pluginsApp.request('/api/plugins/documents/export', {}, env)
    expect(res1.status).toBe(200)
    const entries1 = await readArchive(res1)
    const cursor = res1.headers.get('X-Export-Next-Cursor')
    expect(cursor).toBeTruthy()
    expect(manifestOf(entries1).archive).toEqual({
      documents: 2,
      files: 40,
      missing_files: 0,
      bytes: 7 * 40,
    })
    const docRows1 = csvRecords(entries1.get('documents.csv')).slice(1)
    expect(docRows1.map((r) => r[0]).sort()).toEqual([...firstTwo].sort())
    for (const path of payloads.keys()) {
      const belongs = firstTwo.some((id) => path.startsWith(`files/${id}/`))
      expect(entries1.has(path)).toBe(belongs)
    }

    // Archive 2: the cursor continues exactly where archive 1 stopped.
    const res2 = await pluginsApp.request(
      `/api/plugins/documents/export?cursor=${encodeURIComponent(cursor!)}`,
      {},
      env
    )
    expect(res2.status).toBe(200)
    const entries2 = await readArchive(res2)
    expect(res2.headers.get('X-Export-Next-Cursor')).toBeNull()
    expect(manifestOf(entries2).archive).toEqual({
      documents: 1,
      files: 20,
      missing_files: 0,
      bytes: 7 * 20,
    })
    const docRows2 = csvRecords(entries2.get('documents.csv')).slice(1)
    expect(docRows2.map((r) => r[0])).toEqual([third])

    // THE UNION: all 60 files, each with its exact stored bytes — the export
    // covers the household's data (the acceptance criterion), platform
    // budget included.
    const allPaths = new Set([...entries1.keys(), ...entries2.keys()])
    // 60 file paths + 3 metadata names (documents.csv / files.csv /
    // manifest.json repeat in every archive of the sequence).
    expect(allPaths.size).toBe(60 + 3)
    for (const [path, wanted] of payloads) {
      const entry = entries1.get(path) ?? entries2.get(path)
      if (!entry) throw new Error(`missing archive entry ${path}`)
      expect([...entry.bytes]).toEqual([...wanted])
    }

    // One receipt per archive — the trail shows the true access shape (2
    // downloads, not 1 phantom full-vault export).
    const receipts = sqlite
      .prepare(
        `SELECT COUNT(*) AS cnt FROM household_plugin_audit WHERE action = 'plugin_exported'`
      )
      .get() as { cnt: number }
    expect(receipts.cnt).toBe(2)
  })

  it('refuses a cursor that is not ours: garbage and foreign-household cursors are 400s', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1')
    seedHousehold(sqlite, 'h2')
    const bucket = createDocumentsStub()
    const storage = await createStorage(bucket)
    // 3 documents × 20 files — over the 40-file budget, so the FIRST h1
    // archive carries a continuation cursor to replay against h2.
    for (let d = 0; d < 3; d++) {
      await seedDoc(d1, storage, {
        householdId: 'h1',
        name: `Dokumen h1-${d}`,
        files: Array.from({ length: 20 }, (_, i) => ({
          fileName: `h1-${d}-${i}.pdf`,
          bytes: PDF,
          mime: 'application/pdf',
        })),
      })
    }
    await seedDoc(d1, storage, {
      householdId: 'h2',
      name: 'Dokumen h2',
      files: Array.from({ length: 20 }, (_, i) => ({
        fileName: `h2-${i}.pdf`,
        bytes: PDF,
        mime: 'application/pdf',
      })),
    })

    // A garbage cursor — the endpoint issued nothing like this.
    const env1 = createRouteEnv(sqlite, bucket, { userId: 'u-h1', householdId: 'h1' })
    const res1 = await pluginsApp.request(
      '/api/plugins/documents/export?cursor=!!!not-a-cursor',
      {},
      env1
    )
    expect(res1.status).toBe(400)
    expect(((await res1.json()) as { error: string }).error).toBe('Unknown export cursor')

    // A foreign-household cursor: h1's first archive cursor replayed against
    // h2 must never silently export a wrong slice of h2.
    const res2 = await pluginsApp.request('/api/plugins/documents/export', {}, env1)
    const h1Cursor = res2.headers.get('X-Export-Next-Cursor')
    expect(h1Cursor).toBeTruthy()
    const env2 = createRouteEnv(sqlite, bucket, { userId: 'u-h2', householdId: 'h2' })
    const res3 = await pluginsApp.request(
      `/api/plugins/documents/export?cursor=${encodeURIComponent(h1Cursor!)}`,
      {},
      env2
    )
    expect(res3.status).toBe(400)
    expect(((await res3.json()) as { error: string }).error).toBe(
      'Export cursor belongs to another household'
    )
    // ...and the job-level contract (the error the route maps) is the one
    // shared class — core cannot import plugin-owned errors, so the cursor
    // error lives in the contract module.
    expect(new PluginExportCursorError().name).toBe('PluginExportCursorError')
  })

  it('skips-with-note the half-dead states: missing object and namespace-guarded key', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1')
    const bucket = createDocumentsStub()
    const storage = await createStorage(bucket)

    const healthy = await seedDoc(d1, storage, {
      householdId: 'h1',
      name: 'Sehat',
      files: [{ fileName: 'ok.pdf', bytes: PDF, mime: 'application/pdf' }],
    })
    // A dead file: the row exists, the object never did (the failed-delete
    // crash state; the content endpoint 404s it too).
    sqlite
      .prepare(
        `INSERT INTO documents (id, household_id, name, uploaded_by)
         VALUES ('d-dead', 'h1', 'Mati', 'u-h1')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO document_files
           (id, document_id, r2_key, file_name, size_bytes, content_type, sort_order, sha256, uploaded_by)
         VALUES ('f-dead', 'd-dead', 'documents/h1/d-dead/gone.pdf', 'gone.pdf', 5, 'application/pdf', 1, 'a', 'u-h1')`
      )
      .run()
    // A poisoned key: outside the vault namespace — the guard must never
    // let the export READ a sibling namespace's object (review B1 of #388).
    sqlite
      .prepare(
        `INSERT INTO documents (id, household_id, name, uploaded_by)
         VALUES ('d-poison', 'h1', 'Racun', 'u-h1')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO document_files
           (id, document_id, r2_key, file_name, size_bytes, content_type, sort_order, sha256, uploaded_by)
         VALUES ('f-poison', 'd-poison', 'receipts/not-ours/x.pdf', 'x.pdf', 5, 'application/pdf', 1, 'b', 'u-h1')`
      )
      .run()

    const env = createRouteEnv(sqlite, bucket, { userId: 'u-h1', householdId: 'h1' })
    const res = await pluginsApp.request('/api/plugins/documents/export', {}, env)
    expect(res.status).toBe(200)

    const entries = await readArchive(res)
    const manifest = manifestOf(entries)
    expect(manifest.archive.documents).toBe(3)
    expect(manifest.archive.files).toBe(1)
    expect(manifest.archive.missing_files).toBe(2)

    // The dead rows still appear in files.csv (the metadata is the
    // household's), but their archive entries carry ZERO bytes — and since
    // uploads reject empty files, 0 bytes where size_bytes > 0 is the
    // unambiguous "unavailable at export time" marker (manifest's note).
    const fileRows = csvRecords(entries.get('files.csv')).slice(1)
    expect(fileRows).toHaveLength(3)
    const deadRow = fileRows.find((r) => r[1] === 'd-dead')!
    const poisonRow = fileRows.find((r) => r[1] === 'd-poison')!
    for (const row of [deadRow, poisonRow]) {
      const entry = entries.get(row[2])
      expect(entry).toBeTruthy()
      expect(entry!.size).toBe(0)
    }
    // The healthy file is intact — one poisoned row must not sink the
    // export of a vault that mostly works.
    expect([...entries.get(`files/${healthy}/1-ok.pdf`)!.bytes]).toEqual([...PDF])

    // The poisoned key NEVER reached storage: the bucket only ever served
    // the one healthy key.
    expect(bucket.objects.has('receipts/not-ours/x.pdf')).toBe(false)
  })

  it('refuses a sub-floor budget at the job (wiring error, not a runtime state)', async () => {
    const { sqlite } = createDb()
    seedHousehold(sqlite, 'h1')
    const bucket = createDocumentsStub()
    const d1 = createD1Adapter(sqlite)
    const job = createDocumentsExportJob(await createStorage(bucket))
    await expect(
      job({
        db: d1,
        householdId: 'h1',
        actorUserId: 'u-h1',
        cursor: null,
        maxFiles: DOCUMENT_MAX_FILES - 1,
      })
    ).rejects.toThrow(/below the per-document maximum/)
  })
})
