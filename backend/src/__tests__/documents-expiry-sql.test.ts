import { describe, it, expect } from 'vite-plus/test'
// Real-SQL coverage for the #426 expiry subdomain on a FIXED clock — split
// from documents-sql.test.ts (V2-B3) the same way the route tests split into
// documents-expiry.test.ts: the date math lives here because `now` is an
// argument, so the exact boundaries (what counts as "within N days", the
// computed days_until_expiry, the due-set windows) are pinned against real
// SQLite (node:sqlite — D1 is SQLite) through the full migration chain,
// immune to midnight races. Same contained Node-type suppressions as the
// sibling files (the backend tsconfig pins workers-types).
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
  updateDocumentExpiry,
  DocumentNotFoundError,
} from '../plugins/documents/lib.js'
import {
  daysUntil,
  householdIsoDate,
  resolveExpiryUpdate,
  listDueDocumentReminders,
  DEFAULT_REMIND_DAYS_BEFORE,
} from '../lib/document-expiry.js'
import { createR2StorageAdapter } from '../ports/storage/r2.js'
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

// A D1-shaped adapter over node:sqlite — the same minimal surface the vault
// lib uses (prepare().bind().first/all/run + batch in a transaction), keeping
// this file self-contained like its sibling real-SQL suites.
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

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])

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

  it('guarded update: a concurrent delete wins the race into a typed 404 and NO spurious audit record (V2-A1)', async () => {
    // The route pre-checks the document, but between that read and the batch
    // a deleteDocument can commit. The batch is guarded (the #422 A2
    // precedent): the UPDATE carries the household predicate and the audit
    // record rides INSERT..SELECT gated on the touched row — so the lost
    // race leaves zero rows and answers 404, not a 500 from the read-back.
    const { sqlite, d1, storage } = seedHousehold()
    // The deleter is a linked owner-member (deleteDocument's authorization
    // reads the membership).
    sqlite
      .prepare(
        `INSERT INTO household_members (id, household_id, user_id, role)
         VALUES ('m-owner', 'h1', 'u1', 'owner')`
      )
      .run()
    const created = await createDocument(d1, storage, {
      householdId: 'h1',
      memberId: null,
      name: 'Paspor',
      file: { fileName: 'paspor.pdf', bytes: PDF_BYTES, mime: 'application/pdf', label: null },
      uploadedBy: 'u1',
    })
    const row = await getDocumentRow(d1, 'h1', created.id)
    expect(row).not.toBeNull()

    // The concurrent delete commits first.
    await deleteDocument(d1, storage, { householdId: 'h1', userId: 'u1', document: row! })
    expect(await getDocumentRow(d1, 'h1', created.id)).toBeNull()

    await expect(
      updateDocumentExpiry(d1, {
        householdId: 'h1',
        documentId: created.id,
        actorUserId: 'u1',
        expiresOn: '2027-01-01',
        remindDaysBefore: 30,
      })
    ).rejects.toBeInstanceOf(DocumentNotFoundError)

    // The lost race wrote NOTHING: no phantom expiry columns, no 'update'
    // audit record (the audit trail has no FK by design — the guard is what
    // keeps it honest).
    expect(sqlite.prepare('SELECT COUNT(*) AS cnt FROM documents').get()).toEqual({ cnt: 0 })
    expect(
      sqlite.prepare("SELECT COUNT(*) AS cnt FROM document_audit WHERE action = 'update'").get()
    ).toEqual({ cnt: 0 })
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

  it('the skew window (01:00 WIB): the household calendar answers, not the UTC one (V2-A2)', async () => {
    // 2026-11-07T18:00Z = 01:00 WIB on Nov 8 — the exact window where a UTC
    // calendar would run one day behind the household's. The projections,
    // the expiring_within horizon and the due set all derive from ONE
    // household-calendar helper, so the whole chain answers on the 8th.
    const SKEW = new Date('2026-11-07T18:00:00.000Z')
    expect(householdIsoDate(SKEW)).toBe('2026-11-08')

    const { sqlite, d1 } = createDb()
    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.com')").run()
    sqlite
      .prepare(
        `INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`
      )
      .run()
    seedDocument(sqlite, {
      id: 'doc-today',
      name: 'BPJS',
      expiresOn: '2026-11-08',
      remindDaysBefore: 1,
    }) // WIB-today → 0 days, NOT 1
    seedDocument(sqlite, {
      id: 'doc-yesterday',
      name: 'SIM',
      expiresOn: '2026-11-07',
      remindDaysBefore: 1,
    }) // WIB-yesterday → expired, NOT "today"
    seedDocument(sqlite, {
      id: 'doc-tomorrow',
      name: 'Paspor',
      expiresOn: '2026-11-09',
      remindDaysBefore: 1,
    }) // WIB-tomorrow → 1 day (window boundary)
    seedDocument(sqlite, {
      id: 'doc-beyond',
      name: 'STNK',
      expiresOn: '2026-11-10',
      remindDaysBefore: 1,
    }) // 2 days out — outside the 1-day window

    const all = await listDocuments(d1, 'h1', {}, SKEW)
    const days = Object.fromEntries(all.map((d) => [d.id, d.days_until_expiry]))
    expect(days).toEqual({
      'doc-today': 0,
      'doc-yesterday': -1,
      'doc-tomorrow': 1,
      'doc-beyond': 2,
    })

    // The horizon inherits the same calendar: expiring_within=1 from 01:00
    // WIB Nov 8 covers through 2026-11-09 (inclusive), not the UTC-derived day.
    const within = await listDocuments(d1, 'h1', { expiringWithin: 1 }, SKEW)
    expect(within.map((d) => d.id)).toEqual(['doc-yesterday', 'doc-today', 'doc-tomorrow'])

    // And the sweep agrees: a 1-day window catches the WIB-tomorrow document.
    const due = await listDueDocumentReminders(d1, SKEW)
    expect(due.filter((d) => d.household_id === 'h1').map((d) => d.id)).toEqual([
      'doc-yesterday',
      'doc-today',
      'doc-tomorrow',
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
