import { describe, it, expect, vi } from 'vite-plus/test'
// Real-SQL coverage for the plugin purge lifecycle (ahaqqu/RumaQ#439 —
// plugin architecture ticket 5, plan §3.4), following the
// documents-sql.test.ts pattern: the route tests route a fake D1 on SQL
// fragments — blind to actual storage behavior — while the purge job's
// data-safety claims are SQL + storage semantics, so they are pinned here
// against a real SQLite engine (node:sqlite — D1 is SQLite) and a REAL R2
// adapter over an in-memory bucket:
//
//   - THE BYTES-BEFORE-ROWS INVARIANT (the rev-2 data-safety fix): the
//     recording detector wrapper around the real adapter THROWS if any
//     storage.delete ever fires for a key whose document_files row is
//     already gone — so an edit that ever reorders the chunk (rows first)
//     or lets a cascade erase keys first fails THIS suite, loudly,
//   - the dissolution ordering contract: drain-then-cascade leaves zero
//     orphans and the plugin_purged receipt survives the household;
//     cascade-first (the bug §3.4 forbids) orphans every object,
//   - resumability: the cursor chunks a drain across invocations and every
//     replay is idempotent (no double receipt, no error),
//   - the subrequest-cap math: a 200-document vault at the 40-object tick
//     budget drains in 5 nightly invocations, each within budget.
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

import { createDocumentsPurgeJob, documentPageSql } from '../plugins/documents/purge.js'
import { addDocumentFile, createDocument } from '../plugins/documents/lib.js'
import { PURGE_INITIATE_SQL } from '../lib/plugins.js'
import {
  PURGE_TICK_OBJECT_BUDGET,
  drainPluginPurgesForHousehold,
  runPluginPurgeTick,
} from '../lib/plugin-purge.js'
import { cancelPluginPurge } from '../lib/plugins.js'
import { createR2StorageAdapter } from '../ports/storage/r2.js'
import { pluginRegistrations } from '../plugins/registry.js'
import { createDocumentsStub, type MockEnv } from './support/env.js'

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

// A D1-shaped adapter over node:sqlite — only the surface the purge job and
// the driver use — with batch() wrapped in a transaction so the row+cursor
// batch's atomicity claim is exercised, not assumed.
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

/**
 * The BYTES-BEFORE-ROWS detector: the real R2 adapter over the stub bucket,
 * wrapped so every delete() first asserts the key's document_files row is
 * STILL THERE. This is the pin the acceptance criterion asks for — "a test
 * that fails if cascade could ever erase key records before bytes": any
 * future edit that reorders the chunk (rows before bytes) or that lets a
 * cascade run mid-drain makes the very next delete throw here. (A key whose
 * row is legitimately already gone never reaches delete(): the keys are
 * READ from document_files — the port has no list by design.)
 */
function createDetectorStorage(sqlite: Db) {
  const bucket = createDocumentsStub()
  const real = createR2StorageAdapter(bucket as unknown as R2Bucket)
  const deleted: string[] = []
  return {
    bucket,
    deleted,
    storage: {
      put: real.put.bind(real),
      get: real.get.bind(real),
      delete: async (key: string) => {
        const row = sqlite
          .prepare('SELECT COUNT(*) AS cnt FROM document_files WHERE r2_key = ?')
          .get(key) as { cnt: number }
        if (row.cnt === 0) {
          throw new Error(
            `BYTES-BEFORE-ROWS VIOLATION: storage.delete('${key}') ran with no document_files row — rows were erased before the bytes (the rev-2 data-safety bug)`
          )
        }
        deleted.push(key)
        return real.delete(key)
      },
    },
  }
}

function seedHousehold(sqlite: Db, id: string, name: string): void {
  sqlite.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(`u-${id}`, `${id}@b.com`)
  sqlite
    .prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)')
    .run(id, name, `u-${id}`)
  sqlite
    .prepare(
      `INSERT INTO household_members (id, household_id, user_id, role)
       VALUES (?, ?, ?, 'owner')`
    )
    .run(`m-${id}`, id, `u-${id}`)
}

// Seeds a document + one file row directly (the bulk-seeding path the
// chunk-math test needs; the happy-path tests go through the real
// createDocument instead, so both shapes of row creation are exercised).
function seedDocument(
  sqlite: Db,
  args: {
    householdId: string
    documentId: string
    fileId: string
    createdAt: string
    fileCount?: number
    /** Override the first file's key (the poison-key fixture). */
    firstKey?: string
  }
): string {
  sqlite
    .prepare(
      `INSERT INTO documents (id, household_id, name, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      args.documentId,
      args.householdId,
      `Dok ${args.documentId}`,
      `u-${args.householdId}`,
      args.createdAt
    )
  const count = args.fileCount ?? 1
  let firstKey = ''
  for (let i = 0; i < count; i++) {
    // Single-file rows keep the pre-fixtures key shape (documents/<h>/<d>/<f>)
    // — the existing assertions pin it; multi-file rows get per-index keys.
    const key =
      i === 0 && args.firstKey
        ? args.firstKey
        : count === 1
          ? `documents/${args.householdId}/${args.documentId}/${args.fileId}`
          : `documents/${args.householdId}/${args.documentId}/${args.fileId}-${i}`
    if (i === 0) firstKey = key
    sqlite
      .prepare(
        `INSERT INTO document_files
           (id, document_id, r2_key, file_name, size_bytes, content_type, sort_order, sha256, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `${args.fileId}-${i}`,
        args.documentId,
        key,
        'f.pdf',
        8,
        'application/pdf',
        i + 1,
        'a'.repeat(64),
        `u-${args.householdId}`
      )
  }
  return firstKey
}

// Marks a household's documents plugin purge 'pending' through the EXACT
// statement the owner-only initiation endpoint runs (upsert first — the row
// must exist — then the initiation UPDATE).
function requestPurge(sqlite: Db, householdId: string, requestedBy: string): void {
  sqlite
    .prepare(
      `INSERT INTO household_plugins (household_id, plugin_id, status)
       VALUES (?, 'documents', 'enabled')
       ON CONFLICT (household_id, plugin_id) DO NOTHING`
    )
    .run(householdId)
  sqlite.prepare(PURGE_INITIATE_SQL).run(requestedBy, householdId, 'documents')
}

const receiptRows = (sqlite: Db) =>
  sqlite
    .prepare(
      `SELECT household_id, plugin_id, actor_user_id, action FROM household_plugin_audit
        WHERE action = 'plugin_purged' ORDER BY created_at, id`
    )
    .all()

const docCount = (sqlite: Db, householdId: string) =>
  (
    sqlite
      .prepare('SELECT COUNT(*) AS cnt FROM documents WHERE household_id = ?')
      .get(householdId) as { cnt: number }
  ).cnt

const purgeRow = (sqlite: Db, householdId: string) =>
  sqlite
    .prepare(
      `SELECT purge_state, purge_cursor, purge_requested_by, purge_requested_at,
         purge_completed_at
         FROM household_plugins WHERE household_id = ? AND plugin_id = 'documents'`
    )
    .get(householdId)

describe('documents purge job — bytes-before-rows (real SQL, #439)', () => {
  it('purges a household bytes-before-rows, leaves other households untouched, and writes the receipt once', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    seedHousehold(sqlite, 'h2', 'Rumah Lain')
    const { storage, deleted } = createDetectorStorage(sqlite)
    const job = createDocumentsPurgeJob(storage)

    // h1: two documents, the first with a second file (added through the
    // real lib so the multi-file key shape is the production one).
    const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const docA = await createDocument(d1, storage, {
      householdId: 'h1',
      memberId: null,
      name: 'Akta Lahir',
      file: { fileName: 'a.pdf', bytes: PDF, mime: 'application/pdf', label: null },
      uploadedBy: 'u-h1',
    })
    await addDocumentFile(d1, storage, {
      householdId: 'h1',
      documentId: docA.id,
      file: { fileName: 'a2.pdf', bytes: PDF, mime: 'application/pdf', label: null },
      uploadedBy: 'u-h1',
    })
    await createDocument(d1, storage, {
      householdId: 'h1',
      memberId: null,
      name: 'KTP',
      file: { fileName: 'k.jpg', bytes: JPEG, mime: 'image/jpeg', label: null },
      uploadedBy: 'u-h1',
    })
    // h2: a document that must survive h1's purge untouched.
    await createDocument(d1, storage, {
      householdId: 'h2',
      memberId: null,
      name: 'Dokumen tetangga',
      file: { fileName: 'b.pdf', bytes: PDF, mime: 'application/pdf', label: null },
      uploadedBy: 'u-h2',
    })

    requestPurge(sqlite, 'h1', 'u-h1')

    // One carrying chunk (budget above the household's object count) plus
    // the empty completion chunk — the driver's loop shape.
    const carrying = await job({ db: d1, householdId: 'h1', maxObjects: PURGE_TICK_OBJECT_BUDGET })
    expect(carrying).toEqual({ objects: 3, drained: false })
    const completion = await job({
      db: d1,
      householdId: 'h1',
      maxObjects: PURGE_TICK_OBJECT_BUDGET,
    })
    expect(completion).toEqual({ objects: 0, drained: true })

    // Every h1 key went through storage BEFORE its row vanished (the
    // detector enforces the order — reaching this line at all is half the
    // invariant), h2's bytes and rows are untouched, and h1's rows are gone.
    expect(deleted).toHaveLength(3)
    expect(docCount(sqlite, 'h1')).toBe(0)
    expect(docCount(sqlite, 'h2')).toBe(1)

    // The state machine landed on 'done' with the cursor cleared, and the
    // receipt is the ONE completion record — actor = the owner who typed
    // the confirmation (copied from purge_requested_by onto the record
    // that outlives the household).
    expect(purgeRow(sqlite, 'h1')).toMatchObject({
      purge_state: 'done',
      purge_cursor: null,
      purge_requested_by: 'u-h1',
    })
    expect(receiptRows(sqlite)).toEqual([
      {
        household_id: 'h1',
        plugin_id: 'documents',
        actor_user_id: 'u-h1',
        action: 'plugin_purged',
      },
    ])
  })

  it('is idempotent: replaying a finished drain errors nothing and writes no second receipt', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    const { storage } = createDetectorStorage(sqlite)
    const job = createDocumentsPurgeJob(storage)
    seedDocument(sqlite, {
      householdId: 'h1',
      documentId: 'd1',
      fileId: 'f1',
      createdAt: '2026-11-01 10:00:00',
    })
    requestPurge(sqlite, 'h1', 'u-h1')

    await job({ db: d1, householdId: 'h1', maxObjects: PURGE_TICK_OBJECT_BUDGET })
    // The nightly tick comes back every night; a done purge is a no-op.
    const replay = await job({ db: d1, householdId: 'h1', maxObjects: PURGE_TICK_OBJECT_BUDGET })
    expect(replay).toEqual({ objects: 0, drained: true })
    expect(receiptRows(sqlite)).toHaveLength(1)
    expect(purgeRow(sqlite, 'h1')?.purge_state).toBe('done')
  })

  it('resumes from the cursor across invocations, exactly once per document', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    const { storage, deleted } = createDetectorStorage(sqlite)
    const job = createDocumentsPurgeJob(storage)

    // 25 documents, 1 file each; the chunk budget is the per-document
    // floor (20 — the smallest legal budget): chunk 1 carries 20 objects,
    // chunk 2 the remaining 5, chunk 3 completes.
    const total = 25
    for (let i = 0; i < total; i++) {
      seedDocument(sqlite, {
        householdId: 'h1',
        documentId: `d${String(i).padStart(2, '0')}`,
        fileId: `f${i}`,
        // Distinct seconds: the keyset order is (created_at, id) and the
        // test asserts the drain walks it oldest-first without skips.
        createdAt: `2026-11-01 10:00:${String(i).padStart(2, '0')}`,
      })
    }
    requestPurge(sqlite, 'h1', 'u-h1')

    const chunks = []
    for (let i = 0; i < 4; i++) {
      chunks.push(await job({ db: d1, householdId: 'h1', maxObjects: 20 }))
    }
    expect(chunks).toEqual([
      { objects: 20, drained: false },
      { objects: 5, drained: false },
      { objects: 0, drained: true },
      { objects: 0, drained: true }, // the nightly replay: done is a no-op
    ])
    expect(deleted).toHaveLength(total)
    expect(docCount(sqlite, 'h1')).toBe(0)
    expect(receiptRows(sqlite)).toHaveLength(1)
    expect(purgeRow(sqlite, 'h1')?.purge_cursor).toBeNull()

    // Cursor ordering was oldest-first, no gaps: the deletes replayed the
    // seed order exactly (detector ordering + one delete per file).
    expect(deleted).toEqual(
      Array.from({ length: total }, (_, i) => `documents/h1/d${String(i).padStart(2, '0')}/f${i}`)
    )
  })

  it('drains a 200-document vault within the tick budget: 5 nightly chunks of ≤ 40 objects', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    const { storage, deleted } = createDetectorStorage(sqlite)
    const job = createDocumentsPurgeJob(storage)

    // The acceptance criterion's shape: 200 documents (one file each),
    // distinct seconds so the keyset order is total.
    for (let i = 0; i < 200; i++) {
      const hh = 10 + Math.floor(i / 3600)
      const mm = Math.floor(i / 60) % 60
      const ss = i % 60
      seedDocument(sqlite, {
        householdId: 'h1',
        documentId: `d${String(i).padStart(3, '0')}`,
        fileId: `f${i}`,
        createdAt: `2026-11-01 ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`,
      })
    }
    requestPurge(sqlite, 'h1', 'u-h1')

    // Nightly ticks: each gets the production budget. Every chunk must stay
    // within it (the free plan's 50-subrequest cap) and the drain must
    // finish in 200/40 = 5 ticks + the empty completion tick.
    let chunks = 0
    let objects = 0
    for (;;) {
      const chunk = await job({ db: d1, householdId: 'h1', maxObjects: PURGE_TICK_OBJECT_BUDGET })
      chunks += 1
      objects += chunk.objects
      expect(chunk.objects).toBeLessThanOrEqual(PURGE_TICK_OBJECT_BUDGET)
      if (chunk.drained) break
      expect(chunks).toBeLessThan(10) // runaway guard — the drain must progress
    }
    expect(objects).toBe(200)
    expect(chunks).toBe(6) // 5 carrying chunks + the completion chunk
    expect(deleted).toHaveLength(200)
    expect(docCount(sqlite, 'h1')).toBe(0)
    expect(receiptRows(sqlite)).toHaveLength(1)
  })

  it('refuses a budget below the per-document file cap (a whole document could never fit)', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    const { storage } = createDetectorStorage(sqlite)
    const job = createDocumentsPurgeJob(storage)
    requestPurge(sqlite, 'h1', 'u-h1')
    await expect(job({ db: d1, householdId: 'h1', maxObjects: 19 })).rejects.toThrow(
      /below the per-document maximum/
    )
  })
})

describe('plugin purge — household dissolution ordering (the §3.4 contract, #439)', () => {
  function drainEnv(sqlite: Db, bucket: unknown): MockEnv {
    return {
      DB: createD1Adapter(sqlite),
      DOCUMENTS: bucket,
      BROCHURES: {},
      RECEIPTS: {},
      GOOGLE_CLIENT_ID: 'x',
      GOOGLE_CLIENT_SECRET: 'x',
      WORKER_JWT_SECRET: 'x',
      WORKER_ENCRYPTION_KEY: 'x',
      PAGES_ORIGIN: 'http://localhost:5173',
      EMAIL_AUTH_ENABLED: 'false',
      props: { userId: 'u-h1', householdId: 'h1' },
      TEST_MODE: 'true',
    } as unknown as MockEnv
  }

  it('drain-then-cascade leaves zero orphans and the receipt outlives the household', async () => {
    const { sqlite } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    const { bucket } = createDetectorStorage(sqlite)
    const env = drainEnv(sqlite, bucket)

    seedDocument(sqlite, {
      householdId: 'h1',
      documentId: 'd1',
      fileId: 'f1',
      createdAt: '2026-11-01 10:00:00',
    })
    requestPurge(sqlite, 'h1', 'u-h1')

    // THE ORDER: the purge drains to completion FIRST…
    const drained = await drainPluginPurgesForHousehold(
      env as unknown as Parameters<typeof drainPluginPurgesForHousehold>[0],
      'h1'
    )
    expect(drained).toEqual({ complete: true, objects: 1 })
    expect(docCount(sqlite, 'h1')).toBe(0)
    const keysBeforeCascade = (
      sqlite.prepare('SELECT COUNT(*) AS cnt FROM document_files').get() as { cnt: number }
    ).cnt
    expect(keysBeforeCascade).toBe(0)

    // …THEN the household cascade runs (what a dissolution endpoint does
    // after the drain). The cascade may erase documents, files, audit and
    // the enablement row — but NOT the bytes (already gone) and NOT the
    // plugin_purged receipt (0032's FK-less handles).
    sqlite.prepare('DELETE FROM households WHERE id = ?').run('h1')
    expect((bucket as { objects: Map<string, unknown> }).objects.size).toBe(0)
    expect(receiptRows(sqlite)).toEqual([
      {
        household_id: 'h1',
        plugin_id: 'documents',
        actor_user_id: 'u-h1',
        action: 'plugin_purged',
      },
    ])
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS cnt FROM household_plugins').get() as { cnt: number }).cnt
    ).toBe(0)
  })

  it('cascade-FIRST (the forbidden order) orphans the bytes — the failure mode the ordering exists to prevent', async () => {
    const { sqlite } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    const { bucket } = createDetectorStorage(sqlite)
    const key = seedDocument(sqlite, {
      householdId: 'h1',
      documentId: 'd1',
      fileId: 'f1',
      createdAt: '2026-11-01 10:00:00',
    })
    // The bytes exist (what an upload leaves behind) — only the rows know
    // where they live.
    await bucket.put(key, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))

    // The bug §3.4 forbids: the household row goes before any drain. The
    // cascade erases document_files — the ONLY record of the storage keys
    // (the port has no list by design) — leaving the object unreachable
    // forever. This test PINS the failure mode: if it ever stops holding
    // (rows surviving the cascade, or bytes vanishing with them), the
    // schema or the port contract changed and this document is wrong.
    sqlite.prepare('DELETE FROM households WHERE id = ?').run('h1')
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS cnt FROM document_files').get() as { cnt: number }).cnt
    ).toBe(0)
    expect((bucket as { objects: Map<string, unknown> }).objects.size).toBe(1)
    expect(receiptRows(sqlite)).toEqual([])
  })
})

describe('plugin purge — index plans pinned (no scan, no temp B-tree)', () => {
  // The nightly work-set EXPLAIN pin lives in migrations.test.ts (the exact
  // PURGING_HOUSEHOLDS_SQL constant, one pin — P1-B1); this file pins the
  // chunk keyset's plan.
  it('the chunk keyset rides idx_documents_household (reverse seek, no sort)', () => {
    const { sqlite } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    const plan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${documentPageSql()}`)
      .all('h1', null, null, null, null, 40)
    const detail = plan.map((r: Record<string, unknown>) => String(r.detail)).join(' | ')
    expect(detail).toContain('idx_documents_household')
    expect(detail).not.toMatch(/SCAN|TEMP B-TREE/i)
  })
})

describe('plugin purge — the nightly tick driver (runPluginPurgeTick, #439)', () => {
  it('routes one budgeted chunk per in-flight drain per tick and stops when nothing is pending', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    seedHousehold(sqlite, 'h2', 'Rumah Lain')
    const { bucket } = createDetectorStorage(sqlite)
    const env = {
      DB: d1,
      DOCUMENTS: bucket,
      BROCHURES: {},
      RECEIPTS: {},
      GOOGLE_CLIENT_ID: 'x',
      GOOGLE_CLIENT_SECRET: 'x',
      WORKER_JWT_SECRET: 'x',
      WORKER_ENCRYPTION_KEY: 'x',
      PAGES_ORIGIN: 'http://localhost:5173',
      EMAIL_AUTH_ENABLED: 'false',
      props: { userId: 'u-h1', householdId: 'h1' },
      TEST_MODE: 'true',
    } as unknown as Parameters<typeof runPluginPurgeTick>[0]

    // Two households with drains; 3 objects each (the tick budget 40 covers
    // both in one night).
    for (const householdId of ['h1', 'h2']) {
      for (let i = 0; i < 3; i++) {
        seedDocument(sqlite, {
          householdId,
          documentId: `d-${householdId}-${i}`,
          fileId: `f-${householdId}-${i}`,
          createdAt: `2026-11-01 10:0${i}:00`,
        })
      }
      requestPurge(sqlite, householdId, `u-${householdId}`)
    }

    // Night 1: both drains carry a chunk (3 objects each), neither done.
    const night1 = await runPluginPurgeTick(env, PURGE_TICK_OBJECT_BUDGET)
    expect(night1).toEqual({ objects: 6, chunks: 2, failed: 0 })
    expect(docCount(sqlite, 'h1')).toBe(0)
    expect(docCount(sqlite, 'h2')).toBe(0)
    // The rows are gone; the completion receipts only land on the NEXT
    // tick's empty read (the driver's chunk shape — never both in one call).
    expect(receiptRows(sqlite)).toHaveLength(0)

    // Night 2: the two empty completion chunks write the receipts.
    const night2 = await runPluginPurgeTick(env, PURGE_TICK_OBJECT_BUDGET)
    expect(night2).toEqual({ objects: 0, chunks: 2, failed: 0 })
    expect(receiptRows(sqlite)).toHaveLength(2)

    // Night 3: nothing pending — the work-set query answers zero rows.
    const night3 = await runPluginPurgeTick(env, PURGE_TICK_OBJECT_BUDGET)
    expect(night3).toEqual({ objects: 0, chunks: 0, failed: 0 })
  })
})

describe('plugin purge — registry seam', () => {
  it('the composed documents registration carries the purge job the driver routes to', () => {
    const env = {
      DOCUMENTS: createDocumentsStub(),
    } as unknown as Parameters<typeof pluginRegistrations>[0]
    const registration = pluginRegistrations(env).find((r) => r.manifest.id === 'documents')
    expect(registration?.purge).toBeTypeOf('function')
    // The manifest declares the capability the catalog surfaces (§4.5).
    expect(registration?.manifest.capabilities).toContain('purge')
  })
})

// P1-A1 (PR #474 review): the completion guard is the data-safety crux — the
// empty doc page is a keyset read (post-cursor rows only) while the batch's
// zeroDocsLeft counts the WHOLE household. When they disagree, the job must
// refuse the drain and re-seek, never report drained with documents alive.
describe('documents purge job — the completion guard decides drained (P1-A1)', () => {
  it('a document the cursor skipped past defeats the completion: drained=false, cursor re-seek, drain still finishes', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    const { storage, deleted } = createDetectorStorage(sqlite)
    const job = createDocumentsPurgeJob(storage)

    // The late commit that lands with the SAME wall-clock second as the
    // already-processed document but a SMALLER random-UUID id: the keyset
    // (created_at, id) > (T, d-zzz) can never match it — the exact
    // permanent-skip shape the reviewer called out.
    seedDocument(sqlite, {
      householdId: 'h1',
      documentId: 'd-zzz',
      fileId: 'f-zzz',
      createdAt: '2026-11-01 10:00:00',
    })
    requestPurge(sqlite, 'h1', 'u-h1')

    // Chunk 1 processes the only document it can see; the cursor lands on
    // (T, d-zzz). The "in-flight" document commits AFTER that chunk.
    const chunk1 = await job({ db: d1, householdId: 'h1', maxObjects: 20 })
    expect(chunk1).toEqual({ objects: 1, drained: false })
    seedDocument(sqlite, {
      householdId: 'h1',
      documentId: 'd-aaa',
      fileId: 'f-aaa',
      createdAt: '2026-11-01 10:00:00', // same second, smaller id
    })

    // Chunk 2: the keyset reads ZERO rows — but d-aaa exists. The batch's
    // whole-household guard defeats every statement, and the job MUST NOT
    // report drained (the old code did — that was the blocking finding).
    const chunk2 = await job({ db: d1, householdId: 'h1', maxObjects: 20 })
    expect(chunk2).toEqual({ objects: 0, drained: false })
    expect(purgeRow(sqlite, 'h1')?.purge_cursor).toBeNull() // re-seek cleared
    expect(receiptRows(sqlite)).toEqual([]) // no receipt with bytes alive
    expect(docCount(sqlite, 'h1')).toBe(1)

    // The re-seek finds the escaped document; the drain then completes with
    // its ONE receipt, every byte gone before any row.
    const chunk3 = await job({ db: d1, householdId: 'h1', maxObjects: 20 })
    expect(chunk3).toEqual({ objects: 1, drained: false })
    const chunk4 = await job({ db: d1, householdId: 'h1', maxObjects: 20 })
    expect(chunk4).toEqual({ objects: 0, drained: true })
    expect(deleted).toHaveLength(2)
    expect(docCount(sqlite, 'h1')).toBe(0)
    expect(receiptRows(sqlite)).toHaveLength(1)
    expect(purgeRow(sqlite, 'h1')).toMatchObject({ purge_state: 'done' })
  })

  it('the write gate is enforced IN the INSERT statements: an in-flight body lands nothing mid-drain', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    const { bucket, storage } = createDetectorStorage(sqlite)
    const { DocumentPurgeActiveError } = await import('../plugins/documents/lib.js')
    seedDocument(sqlite, {
      householdId: 'h1',
      documentId: 'd-live',
      fileId: 'f-live',
      createdAt: '2026-11-01 10:00:00',
    })
    requestPurge(sqlite, 'h1', 'u-h1')

    // Simulate the exact race: the upload's pre-gate read the state as NULL
    // (row absent — the row is materialized here, mid-body) and the body
    // commits while the drain is pending. The in-statement guard refuses
    // the whole batch.
    await expect(
      createDocument(d1, storage, {
        householdId: 'h1',
        memberId: null,
        name: 'Telat',
        file: {
          fileName: 'x.pdf',
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
          mime: 'application/pdf',
          label: null,
        },
        uploadedBy: 'u-h1',
      })
    ).rejects.toBeInstanceOf(DocumentPurgeActiveError)
    expect(docCount(sqlite, 'h1')).toBe(1) // only the pre-existing doc
    expect(
      (
        sqlite
          .prepare('SELECT COUNT(*) AS cnt FROM document_files WHERE document_id = ?')
          .all('d-live') as unknown[]
      ).length
    ).toBe(1)
    // The put orphan (bytes without rows) is the documented put-first trade;
    // the ROWS — the key records — never landed.
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS cnt FROM document_audit').get() as { cnt: number }).cnt
    ).toBe(0)

    void bucket
  })

  it('addFile refuses mid-drain with the purge 409 (not the cap 409), via the in-statement guard', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    const { storage } = createDetectorStorage(sqlite)
    const { DocumentPurgeActiveError, DocumentTooManyFilesError } =
      await import('../plugins/documents/lib.js')
    const doc = await createDocument(d1, storage, {
      householdId: 'h1',
      memberId: null,
      name: 'Sebelum drain',
      file: {
        fileName: 'a.pdf',
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
        mime: 'application/pdf',
        label: null,
      },
      uploadedBy: 'u-h1',
    })
    requestPurge(sqlite, 'h1', 'u-h1')

    await expect(
      addDocumentFile(d1, storage, {
        householdId: 'h1',
        documentId: doc.id,
        file: {
          fileName: 'b.pdf',
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
          mime: 'application/pdf',
          label: null,
        },
        uploadedBy: 'u-h1',
      })
    ).rejects.toBeInstanceOf(DocumentPurgeActiveError)
    // The cap's own 409 still fires when NO drain is active (unchanged
    // path): a document already AT the 20-file cap.
    const h2 = createDb()
    seedHousehold(h2.sqlite, 'h2', 'Rumah Lain')
    const { storage: storage2 } = createDetectorStorage(h2.sqlite)
    const doc2 = await createDocument(h2.d1, storage2, {
      householdId: 'h2',
      memberId: null,
      name: 'Penuh',
      file: {
        fileName: 'a.pdf',
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
        mime: 'application/pdf',
        label: null,
      },
      uploadedBy: 'u-h2',
    })
    for (let i = 1; i < 20; i++) {
      await addDocumentFile(h2.d1, storage2, {
        householdId: 'h2',
        documentId: doc2.id,
        file: {
          fileName: `f${i}.pdf`,
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
          mime: 'application/pdf',
          label: null,
        },
        uploadedBy: 'u-h2',
      })
    }
    await expect(
      addDocumentFile(h2.d1, storage2, {
        householdId: 'h2',
        documentId: doc2.id,
        file: {
          fileName: 'b.pdf',
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
          mime: 'application/pdf',
          label: null,
        },
        uploadedBy: 'u-h2',
      })
    ).rejects.toBeInstanceOf(DocumentTooManyFilesError)
  })
})

// P1-A2 (PR #474 review): the driver stops on `remaining < purgeBudgetFloor`
// instead of handing out a sub-floor chunk the job refuses — a multi-file
// vault must never abort the tick or starve the households behind it.
describe('plugin purge — budget floor across the remainder boundary (P1-A2)', () => {
  it('the tick absorbs a 15-file remainder: no throw, later households still drain', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    seedHousehold(sqlite, 'h2', 'Rumah Lain')
    const { bucket } = createDetectorStorage(sqlite)
    const env = {
      DB: d1,
      DOCUMENTS: bucket,
      BROCHURES: {},
      RECEIPTS: {},
      GOOGLE_CLIENT_ID: 'x',
      GOOGLE_CLIENT_SECRET: 'x',
      WORKER_JWT_SECRET: 'x',
      WORKER_ENCRYPTION_KEY: 'x',
      PAGES_ORIGIN: 'http://localhost:5173',
      EMAIL_AUTH_ENABLED: 'false',
      props: { userId: 'u-h1', householdId: 'h1' },
      TEST_MODE: 'true',
    } as unknown as Parameters<typeof runPluginPurgeTick>[0]

    // h1: three 15-file documents — the exact shape that used to leave a
    // 1–19 remainder (2 docs = 30, the third would hit 45 > 40). h2 waits
    // behind it with one 1-file document.
    for (let i = 0; i < 3; i++) {
      seedDocument(sqlite, {
        householdId: 'h1',
        documentId: `d${i}`,
        fileId: `f${i}`,
        createdAt: `2026-11-01 10:0${i}:00`,
        fileCount: 15,
      })
    }
    seedDocument(sqlite, {
      householdId: 'h2',
      documentId: 'd-h2',
      fileId: 'f-h2',
      createdAt: '2026-11-02 10:00:00',
    })
    requestPurge(sqlite, 'h1', 'u-h1')
    requestPurge(sqlite, 'h2', 'u-h2')

    // Night 1: h1 carries 2 docs (30 objects); remaining 10 < floor 20 →
    // the tick STOPS cleanly — h2 is not handed a chunk it cannot run…
    const night1 = await runPluginPurgeTick(env)
    expect(night1).toEqual({ objects: 30, chunks: 1, failed: 0 })
    expect(docCount(sqlite, 'h2')).toBe(1)

    // …and h2 is not STARVED either: night 2 finishes h1's third document
    // and drains h2 behind it.
    const night2 = await runPluginPurgeTick(env)
    expect(night2).toEqual({ objects: 16, chunks: 2, failed: 0 })
    expect(docCount(sqlite, 'h1')).toBe(0)
    expect(docCount(sqlite, 'h2')).toBe(0)

    // Night 3: both completion chunks write their receipts; night 4 is idle.
    const night3 = await runPluginPurgeTick(env)
    expect(night3).toEqual({ objects: 0, chunks: 2, failed: 0 })
    expect(receiptRows(sqlite)).toHaveLength(2)
    const night4 = await runPluginPurgeTick(env)
    expect(night4).toEqual({ objects: 0, chunks: 0, failed: 0 })
  })

  it('the dissolution drain resumes across sub-floor exhaustion without resetting the cursor', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    const { bucket } = createDetectorStorage(sqlite)
    const env = {
      DB: d1,
      DOCUMENTS: bucket,
      BROCHURES: {},
      RECEIPTS: {},
      GOOGLE_CLIENT_ID: 'x',
      GOOGLE_CLIENT_SECRET: 'x',
      WORKER_JWT_SECRET: 'x',
      WORKER_ENCRYPTION_KEY: 'x',
      PAGES_ORIGIN: 'http://localhost:5173',
      EMAIL_AUTH_ENABLED: 'false',
      props: { userId: 'u-h1', householdId: 'h1' },
      TEST_MODE: 'true',
    } as unknown as Parameters<typeof drainPluginPurgesForHousehold>[0]

    for (let i = 0; i < 3; i++) {
      seedDocument(sqlite, {
        householdId: 'h1',
        documentId: `d${i}`,
        fileId: `f${i}`,
        createdAt: `2026-11-01 10:0${i}:00`,
        fileCount: 15,
      })
    }

    // Attempt 1: the drain REQUESTS the purge itself (no owner initiation —
    // `complete` must never mean "nothing was pending"), carries 2 docs,
    // then hits the floor: complete=false, resumable.
    const attempt1 = await drainPluginPurgesForHousehold(env, 'h1', {
      actorUserId: 'u-h1',
      budget: 40,
    })
    expect(attempt1).toEqual({ complete: false, objects: 30 })
    const midCursor = purgeRow(sqlite, 'h1')?.purge_cursor
    expect(midCursor).not.toBeNull()

    // Attempt 2 (the caller re-calls): the request is NOT re-initiated from
    // scratch — the cursor survived, the third document drains, completion
    // confirms with one receipt.
    const attempt2 = await drainPluginPurgesForHousehold(env, 'h1', {
      actorUserId: 'u-h1',
      budget: 40,
    })
    expect(attempt2).toEqual({ complete: true, objects: 15 })
    expect(docCount(sqlite, 'h1')).toBe(0)
    expect(receiptRows(sqlite)).toEqual([
      {
        household_id: 'h1',
        plugin_id: 'documents',
        actor_user_id: 'u-h1',
        action: 'plugin_purged',
      },
    ])
    void midCursor
  })
})

// P1-A3 (PR #474 review): the owner's cancel lever — the only way out of a
// drain that can never complete (one poisoned r2_key throws on every chunk
// that reaches its document, and the same guard throws in the user-facing
// delete paths, so the owner cannot remove the poison document either).
describe('plugin purge — the owner cancel lever (P1-A3)', () => {
  function cancelEnv(sqlite: Db, bucket: unknown) {
    return {
      DB: createD1Adapter(sqlite),
      DOCUMENTS: bucket,
      BROCHURES: {},
      RECEIPTS: {},
      GOOGLE_CLIENT_ID: 'x',
      GOOGLE_CLIENT_SECRET: 'x',
      WORKER_JWT_SECRET: 'x',
      WORKER_ENCRYPTION_KEY: 'x',
      PAGES_ORIGIN: 'http://localhost:5173',
      EMAIL_AUTH_ENABLED: 'false',
      props: { userId: 'u-h1', householdId: 'h1' },
      TEST_MODE: 'true',
    } as unknown as Parameters<typeof cancelPluginPurge>[0]
  }

  it('cancels an in-flight drain back to the resting state and releases the write gate', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    const { bucket, storage } = createDetectorStorage(sqlite)
    const { resolvePluginPurgeActive } = await import('../plugins/enablement.js')
    // Three 15-file documents: one 20-budget chunk carries only the FIRST
    // (a second would hit 30 > 20 — the P1-A2 floor), so the drain is
    // genuinely PART-WAY when cancelled.
    for (let i = 0; i < 3; i++) {
      seedDocument(sqlite, {
        householdId: 'h1',
        documentId: `d${i}`,
        fileId: `f${i}`,
        createdAt: `2026-11-01 10:0${i}:00`,
        fileCount: 15,
      })
    }
    requestPurge(sqlite, 'h1', 'u-h1')
    await createDocumentsPurgeJob(storage)({ db: d1, householdId: 'h1', maxObjects: 20 })
    expect(await resolvePluginPurgeActive(d1, 'h1', 'documents')).toBe(true)
    expect(docCount(sqlite, 'h1')).toBe(2) // one chunk drained one document

    const entry = await cancelPluginPurge(cancelEnv(sqlite, bucket), {
      householdId: 'h1',
      userId: 'u-h1',
      pluginId: 'documents',
    })
    expect(entry.purge).toBeNull()
    expect(purgeRow(sqlite, 'h1')).toMatchObject({
      purge_state: null,
      purge_cursor: null,
      purge_requested_by: null,
      purge_requested_at: null,
      purge_completed_at: null,
    })
    expect(await resolvePluginPurgeActive(d1, 'h1', 'documents')).toBe(false)
    // The already-processed document stays gone (bytes-before-rows held for
    // it); the rest is untouched — cancel deletes and restores NOTHING; NO
    // receipt — nothing completed.
    expect(docCount(sqlite, 'h1')).toBe(2)
    expect(receiptRows(sqlite)).toEqual([])
  })

  it('answers the typed 409 when nothing is in flight (state NULL or done)', async () => {
    const { sqlite } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    const { bucket } = createDetectorStorage(sqlite)
    const { PluginPurgeNotActiveError } = await import('../lib/plugins.js')
    // Never requested: nothing to cancel.
    await expect(
      cancelPluginPurge(cancelEnv(sqlite, bucket), {
        householdId: 'h1',
        userId: 'u-h1',
        pluginId: 'documents',
      })
    ).rejects.toBeInstanceOf(PluginPurgeNotActiveError)
  })

  it('a poisoned r2_key fails its household in ISOLATION — the tick logs it and the healthy household still drains', async () => {
    const { sqlite, d1 } = createDb()
    seedHousehold(sqlite, 'h1', 'Keluarga Putri')
    seedHousehold(sqlite, 'h2', 'Rumah Lain')
    const { bucket } = createDetectorStorage(sqlite)
    const env = {
      DB: d1,
      DOCUMENTS: bucket,
      BROCHURES: {},
      RECEIPTS: {},
      GOOGLE_CLIENT_ID: 'x',
      GOOGLE_CLIENT_SECRET: 'x',
      WORKER_JWT_SECRET: 'x',
      WORKER_ENCRYPTION_KEY: 'x',
      PAGES_ORIGIN: 'http://localhost:5173',
      EMAIL_AUTH_ENABLED: 'false',
      props: { userId: 'u-h1', householdId: 'h1' },
      TEST_MODE: 'true',
    } as unknown as Parameters<typeof runPluginPurgeTick>[0]

    // h1's first file key escaped the documents/ namespace — ensureVaultKey
    // throws on every chunk that reaches its document, forever.
    seedDocument(sqlite, {
      householdId: 'h1',
      documentId: 'd-poison',
      fileId: 'f-poison',
      createdAt: '2026-11-01 10:00:00',
      firstKey: 'receipts/h1/not-ours',
    })
    seedDocument(sqlite, {
      householdId: 'h2',
      documentId: 'd-ok',
      fileId: 'f-ok',
      createdAt: '2026-11-01 10:00:00',
    })
    requestPurge(sqlite, 'h1', 'u-h1')
    requestPurge(sqlite, 'h2', 'u-h2')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const night1 = await runPluginPurgeTick(env)
    // No throw out of the tick: h1 failed (logged, retried next night —
    // the cancel lever is the owner's way out), h2 drained cleanly.
    expect(night1).toEqual({ objects: 1, chunks: 1, failed: 1 })
    expect(docCount(sqlite, 'h2')).toBe(0)
    expect(docCount(sqlite, 'h1')).toBe(1) // the poison document survives
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('chunk failed'),
      expect.anything()
    )
    errorSpy.mockRestore()
  })
})
