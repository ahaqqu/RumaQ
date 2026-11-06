import { describe, it, expect } from 'vite-plus/test'
// Real-SQL coverage for the household calendar (ahaqqu/RumaQ#430), following
// the tasks-sql.test.ts pattern: the route tests route a fake D1 on SQL
// fragments — good for HTTP shapes, blind to actual storage behavior. This
// file runs the SAME statements the lib runs against a real SQLite engine
// (node:sqlite — D1 is SQLite) through the full migration chain, so the
// security-relevant semantics cannot drift from the schema:
//
//   - the household scope predicate: a foreign household's event is invisible
//     to every lookup (list, get) and unreachable through another household's
//     authorization; document deadlines derive household-scoped,
//   - the visibility model: 'all' is household-wide; 'members' only to the
//     listed members plus the creator (implicit), and member-row removal
//     degrades to creator-only (never deletes the event),
//   - the guarded mutations: the meta.changes answer (raced delete → typed
//     404), the gated audit INSERT..SELECT, the audience replacement riding
//     the same batch,
//   - the deadline derivation riding the real documents table: an expires_on
//     edit reflects on the next read (the derive-on-read decision), the
//     window filter, the due_soon window from remind_days_before,
//   - the audit trail: one row per mutation, written in the same batch, and
//     OUTLIVING the deleted event row (no FK on event_id).
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
  compareEntries,
  createEvent,
  deleteEvent,
  getCallerMember,
  getEventForActor,
  listCalendarEntries,
  updateEvent,
  CalendarForbiddenError,
  CalendarNotFoundError,
} from '../lib/calendar.js'

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

// A D1-shaped adapter over node:sqlite — only the surface the calendar lib
// uses: prepare().bind().first/all/run and batch(), wrapped in a transaction
// so the audit + write batches' atomicity claim is exercised, not assumed.
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

// The standard roster: ibu owns h1 (linked, u1), ayah is a linked member
// (u2), Adik is the profile-only kid (never a caller, an event audience), and
// om owns h2 — another household for the cross-household probes.
function seed(sqlite: Db): void {
  sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'ibu@b.com')").run()
  sqlite.prepare("INSERT INTO users (id, email) VALUES ('u2', 'ayah@b.com')").run()
  sqlite.prepare("INSERT INTO users (id, email) VALUES ('u3', 'om@b.com')").run()
  sqlite
    .prepare(`INSERT INTO households (id, name, created_by) VALUES ('h1', 'Keluarga Putri', 'u1')`)
    .run()
  sqlite
    .prepare(`INSERT INTO households (id, name, created_by) VALUES ('h2', 'Rumah Lain', 'u3')`)
    .run()
  const member = sqlite.prepare(
    `INSERT INTO household_members (id, household_id, user_id, role, display_name)
     VALUES (?, ?, ?, ?, ?)`
  )
  member.run('m-ibu', 'h1', 'u1', 'owner', 'Ibu')
  member.run('m-ayah', 'h1', 'u2', 'member', 'Ayah')
  member.run('m-anak', 'h1', null, 'member', 'Adik')
  member.run('m-om', 'h2', 'u3', 'owner', 'Om')
}

// A second linked member in h1 (the "unrelated neighbor" probe).
function seedNeighbor(sqlite: Db): void {
  sqlite.prepare("INSERT INTO users (id, email) VALUES ('u4', 'tetangga@b.com')").run()
  sqlite
    .prepare(
      `INSERT INTO household_members (id, household_id, user_id, role, display_name)
       VALUES ('m-tetangga', 'h1', 'u4', 'member', 'Tetangga')`
    )
    .run()
}

// 2026-11-06 00:00 UTC → the WIB household day (UTC+7) is the same date.
const NOW = new Date('2026-11-06T00:00:00.000Z')

const INSERT_EVENT = `INSERT INTO household_calendar_events
    (id, household_id, title, event_date, event_time, visibility, created_by_member_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)`

describe('calendar SQL: household scope + visibility (real SQLite)', () => {
  it('hides a foreign household and its events from every lookup', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    sqlite
      .prepare(INSERT_EVENT)
      .run('e-h1', 'h1', 'Kontrol dokter', '2026-11-15', null, 'all', 'm-ibu')
    sqlite.prepare(INSERT_EVENT).run('e-h2', 'h2', 'Acara lain', '2026-11-15', null, 'all', 'm-om')

    const ibu = (await getCallerMember(d1, 'h1', 'u1'))!
    const entries = await listCalendarEntries(d1, 'h1', ibu.memberId, {}, NOW)
    expect(entries.map((e) => e.id)).toEqual(['e-h1'])
    // The scoped mutation lookup answers the same no for h2's id as for a
    // missing one.
    expect(await getEventForActor(d1, 'h1', ibu.memberId, 'e-h2')).toBeNull()
    expect(await getEventForActor(d1, 'h1', ibu.memberId, 'missing')).toBeNull()
  })

  it("'members' visibility: audience + creator read it, an unrelated member does not", async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    seedNeighbor(sqlite)
    sqlite
      .prepare(INSERT_EVENT)
      .run('e1', 'h1', 'Surprise untuk ayah', '2026-11-15', null, 'members', 'm-ibu')
    sqlite
      .prepare(
        `INSERT INTO household_calendar_event_members (event_id, member_id)
         VALUES ('e1', 'm-anak'), ('e1', 'm-ayah')`
      )
      .run()

    const ibu = (await getCallerMember(d1, 'h1', 'u1'))!
    const ayah = (await getCallerMember(d1, 'h1', 'u2'))!
    const tetangga = (await getCallerMember(d1, 'h1', 'u4'))!
    const om = (await getCallerMember(d1, 'h2', 'u3'))!

    // The creator reads their own restricted event (implicit reader); the
    // listed ayah too (the listed kid, Adik, never authenticates — her read
    // happens through ayah's session). The unrelated h1 member and the
    // foreign owner do not.
    expect(await getEventForActor(d1, 'h1', ibu.memberId, 'e1')).not.toBeNull()
    expect(await getEventForActor(d1, 'h1', ayah.memberId, 'e1')).not.toBeNull()
    expect(await getEventForActor(d1, 'h1', tetangga.memberId, 'e1')).toBeNull()
    expect(await getEventForActor(d1, 'h1', om.memberId, 'e1')).toBeNull()

    const entries = await listCalendarEntries(d1, 'h1', tetangga.memberId, {}, NOW)
    expect(entries).toEqual([])

    // The household OWNER reads a restricted event they are neither creator
    // nor audience of — the manageability fallback (the 0031 SET NULL creator
    // rationale; the tasks-domain no-read-hiding trade). A second event
    // created by ayah for the kid only: ibu (owner) still reads it.
    sqlite
      .prepare(INSERT_EVENT)
      .run('e2', 'h1', 'Surprise untuk ibu', '2026-11-18', null, 'members', 'm-ayah')
    sqlite
      .prepare(`INSERT INTO household_calendar_event_members (event_id, member_id)
                VALUES ('e2', 'm-anak')`)
      .run()
    expect(await getEventForActor(d1, 'h1', ibu.memberId, 'e2')).not.toBeNull()
    // ...while ayah (a plain member) cannot read ibu's e1 despite being linked
    // in h1 (checked above via tetangga — same role).
  })

  it('member removal degrades a members-event to creator-only, never deletes it', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    sqlite
      .prepare(INSERT_EVENT)
      .run('e1', 'h1', 'Imunisasi Adik', '2026-11-15', null, 'members', 'm-ayah')
    sqlite
      .prepare(`INSERT INTO household_calendar_event_members (event_id, member_id)
                VALUES ('e1', 'm-anak')`)
      .run()

    // The kid's member row is removed: the audience row cascades away, the
    // event stays, and the creator (ayah) still reads it — with an empty
    // audience list (the honest read of the depleted state).
    sqlite.prepare('DELETE FROM household_members WHERE id = ?').run('m-anak')
    const ayah = (await getCallerMember(d1, 'h1', 'u2'))!
    const summary = await getEventForActor(d1, 'h1', ayah.memberId, 'e1')
    expect(summary).not.toBeNull()
    expect(summary?.memberIds).toEqual([])
    const count = sqlite
      .prepare('SELECT COUNT(*) AS cnt FROM household_calendar_event_members WHERE event_id = ?')
      .get('e1') as { cnt: number }
    expect(count.cnt).toBe(0)
  })

  it('creator removal keeps the event (SET NULL) and authorization falls back to the owners', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    seedNeighbor(sqlite)
    sqlite.prepare(INSERT_EVENT).run('e1', 'h1', 'Cek STNK', '2026-11-15', null, 'all', 'm-ayah')
    sqlite.prepare('DELETE FROM household_members WHERE id = ?').run('m-ayah')

    const row = sqlite.prepare('SELECT * FROM household_calendar_events WHERE id = ?').get('e1')
    expect(row).toMatchObject({ created_by_member_id: null })

    // The owner manages the orphaned event; a plain member sees it ('all') but
    // cannot edit it.
    const ibu = (await getCallerMember(d1, 'h1', 'u1'))!
    const tetangga = (await getCallerMember(d1, 'h1', 'u4'))!
    const updated = await updateEvent(d1, {
      householdId: 'h1',
      userId: 'u1',
      event: (await getEventForActor(d1, 'h1', ibu.memberId, 'e1'))!.event,
      memberIds: null,
      patch: { title: 'Cek STNK sebelum mudik' },
    })
    expect(updated.title).toBe('Cek STNK sebelum mudik')
    await expect(
      updateEvent(d1, {
        householdId: 'h1',
        userId: 'u4',
        event: (await getEventForActor(d1, 'h1', tetangga.memberId, 'e1'))!.event,
        memberIds: null,
        patch: { title: 'hijack' },
      })
    ).rejects.toThrow(CalendarForbiddenError)
  })
})

describe('calendar SQL: guarded mutations (real SQLite)', () => {
  it('writes the create batch atomically: event + audience + audit, readable back', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    const event = await createEvent(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'Mudik checklist',
      date: '2026-12-18',
      time: '08:00',
      visibility: 'members',
      memberIds: ['m-ayah', 'm-anak'],
    })
    expect(event).toMatchObject({
      kind: 'event',
      title: 'Mudik checklist',
      date: '2026-12-18',
      time: '08:00',
      visibility: 'members',
      created_by_member_id: 'm-ibu',
    })
    expect(event.member_ids).toEqual(['m-anak', 'm-ayah'])
    const rows = sqlite
      .prepare('SELECT member_id FROM household_calendar_event_members ORDER BY member_id')
      .all() as Array<{ member_id: string }>
    expect(rows.map((r) => r.member_id)).toEqual(['m-anak', 'm-ayah'])
    const audit = sqlite
      .prepare('SELECT action, actor_user_id FROM household_calendar_event_audit')
      .all() as Array<{ action: string; actor_user_id: string }>
    expect(audit).toEqual([{ action: 'create', actor_user_id: 'u1' }])
  })

  it('replaces the audience in one batch and flips visibility without stranding rows', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    // Ayah creates and then edits — the creator is the manager; the audience
    // replacements must keep the creator a reader throughout.
    const created = await createEvent(d1, {
      householdId: 'h1',
      userId: 'u2',
      title: 'Kontrol dokter',
      date: '2026-11-20',
      time: null,
      visibility: 'members',
      memberIds: ['m-anak'],
    })
    const ayah = (await getCallerMember(d1, 'h1', 'u2'))!

    // Creator replaces the audience: exactly the new rows survive.
    const updated = await updateEvent(d1, {
      householdId: 'h1',
      userId: 'u2',
      event: (await getEventForActor(d1, 'h1', ayah.memberId, created.id))!.event,
      memberIds: null,
      patch: { memberIds: ['m-ibu', 'm-anak'] },
    })
    expect(updated.member_ids).toEqual(['m-anak', 'm-ibu'])
    const rows = sqlite
      .prepare('SELECT member_id FROM household_calendar_event_members ORDER BY member_id')
      .all() as Array<{ member_id: string }>
    expect(rows.map((r) => r.member_id)).toEqual(['m-anak', 'm-ibu'])

    // Flipping to 'all' clears the rows entirely.
    const opened = await updateEvent(d1, {
      householdId: 'h1',
      userId: 'u2',
      event: (await getEventForActor(d1, 'h1', ayah.memberId, created.id))!.event,
      memberIds: null,
      patch: { visibility: 'all' },
    })
    expect(opened.member_ids).toBeNull()
    expect(
      (
        sqlite.prepare('SELECT COUNT(*) AS cnt FROM household_calendar_event_members').get() as {
          cnt: number
        }
      ).cnt
    ).toBe(0)
    // ...and the audit records exactly one create + two updates (counted per
    // action — same-second rows carry identical created_at, so ORDER BY alone
    // is not a deterministic total order for UUID ids).
    const audits = sqlite
      .prepare(
        'SELECT action, COUNT(*) AS cnt FROM household_calendar_event_audit GROUP BY action ORDER BY action'
      )
      .all() as Array<{ action: string; cnt: number }>
    expect(audits).toEqual([
      { action: 'create', cnt: 1 },
      { action: 'update', cnt: 2 },
    ])
  })

  it('a visibility flip to members preserves the existing audience rows', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    const created = await createEvent(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'Rahasia keluarga',
      date: '2026-11-20',
      time: null,
      visibility: 'all',
      memberIds: [],
    })
    // First an explicit replacement narrows the audience to ayah...
    await updateEvent(d1, {
      householdId: 'h1',
      userId: 'u1',
      event: (await getEventForActor(d1, 'h1', 'm-ibu', created.id))!.event,
      memberIds: null,
      patch: { visibility: 'members', memberIds: ['m-ayah'] },
    })
    // ...then a title edit rides the SAME visibility: the audience rows must
    // survive untouched (an edit that leaves the audience alone must not
    // delete/re-insert it).
    await updateEvent(d1, {
      householdId: 'h1',
      userId: 'u1',
      event: (await getEventForActor(d1, 'h1', 'm-ibu', created.id))!.event,
      memberIds: null,
      patch: { title: 'Rahasia keluarga — jangan lupa' },
    })
    const rows = sqlite
      .prepare('SELECT member_id FROM household_calendar_event_members ORDER BY member_id')
      .all() as Array<{ member_id: string }>
    expect(rows.map((r) => r.member_id)).toEqual(['m-ayah'])
  })

  it('a concurrent delete between the pre-check and the batch answers the typed 404', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    const created = await createEvent(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'To be raced',
      date: '2026-11-20',
      time: null,
      visibility: 'all',
      memberIds: [],
    })
    const snapshot = (await getEventForActor(d1, 'h1', 'm-ibu', created.id))!.event

    // The row disappears AFTER the caller's read (the race window).
    sqlite.prepare('DELETE FROM household_calendar_events WHERE id = ?').run(created.id)

    await expect(
      updateEvent(d1, {
        householdId: 'h1',
        userId: 'u1',
        event: snapshot,
        memberIds: null,
        patch: { title: 'phantom' },
      })
    ).rejects.toThrow(CalendarNotFoundError)
    await expect(
      deleteEvent(d1, { householdId: 'h1', userId: 'u1', event: snapshot })
    ).rejects.toThrow(CalendarNotFoundError)

    // Neither a phantom update, a spurious audit row, nor a stray audience row.
    expect(
      (
        sqlite.prepare('SELECT COUNT(*) AS cnt FROM household_calendar_events').get() as {
          cnt: number
        }
      ).cnt
    ).toBe(0)
    expect(
      (
        sqlite.prepare('SELECT COUNT(*) AS cnt FROM household_calendar_event_audit').get() as {
          cnt: number
        }
      ).cnt
    ).toBe(1) // only the create
  })

  it('the audit trail outlives the deleted event (no FK on event_id)', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    const created = await createEvent(d1, {
      householdId: 'h1',
      userId: 'u1',
      title: 'Riwayat',
      date: '2026-11-20',
      time: null,
      visibility: 'members',
      memberIds: ['m-ayah'],
    })
    await deleteEvent(d1, {
      householdId: 'h1',
      userId: 'u1',
      event: (await getEventForActor(d1, 'h1', 'm-ibu', created.id))!.event,
    })
    const audits = sqlite
      .prepare(
        'SELECT action, COUNT(*) AS cnt FROM household_calendar_event_audit GROUP BY action ORDER BY action'
      )
      .all() as Array<{ action: string; cnt: number }>
    expect(audits).toEqual([
      { action: 'create', cnt: 1 },
      { action: 'delete', cnt: 1 },
    ])
    // The audience rows cascaded with the event; the audit rows did not.
    expect(
      (
        sqlite.prepare('SELECT COUNT(*) AS cnt FROM household_calendar_event_members').get() as {
          cnt: number
        }
      ).cnt
    ).toBe(0)
    expect(
      (
        sqlite.prepare('SELECT COUNT(*) AS cnt FROM household_calendar_events').get() as {
          cnt: number
        }
      ).cnt
    ).toBe(0)
  })

  it('a household delete takes its events and audience with it (CASCADE)', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    const created = await createEvent(d1, {
      householdId: 'h2',
      userId: 'u3',
      title: 'Acara om',
      date: '2026-11-20',
      time: null,
      visibility: 'all',
      memberIds: [],
    })
    sqlite.prepare('DELETE FROM households WHERE id = ?').run('h2')
    expect(
      (
        sqlite.prepare('SELECT COUNT(*) AS cnt FROM household_calendar_events').get() as {
          cnt: number
        }
      ).cnt
    ).toBe(0)
    // The audit row cascades with the household (household_id FK) — the trail
    // never leaks past the household it belonged to.
    expect(
      (
        sqlite
          .prepare('SELECT COUNT(*) AS cnt FROM household_calendar_event_audit WHERE event_id = ?')
          .get(created.id) as { cnt: number }
      ).cnt
    ).toBe(0)
  })
})

describe('calendar SQL: the derived deadline union (real documents table)', () => {
  function seedDocs(sqlite: Db): void {
    // The #422 vault shape: free-text name, member link, expiry metadata
    // (#426). One expiry in-window, one far-future, one undated (never
    // projects), one expired.
    // The post-0025 documents shape: free-text name + the 0026 expiry metadata.
    const insertDoc = sqlite.prepare(
      `INSERT INTO documents
         (id, household_id, member_id, name, uploaded_by, expires_on, remind_days_before)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    insertDoc.run('doc-in', 'h1', 'm-ibu', 'STNK Bapak', 'u1', '2026-11-25', 30)
    insertDoc.run('doc-far', 'h1', 'm-ayah', 'Paspor Ayah', 'u2', '2028-03-10', null)
    insertDoc.run('doc-undated', 'h1', null, 'Kartu Keluarga', 'u1', null, null)
    insertDoc.run('doc-expired', 'h1', 'm-ibu', 'SIM Bapak', 'u1', '2026-11-01', null)
  }

  it('unions stored events and derived deadlines in day order, all-day first', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    seedDocs(sqlite)
    sqlite
      .prepare(INSERT_EVENT)
      .run('e1', 'h1', 'Kontrol dokter', '2026-11-25', '09:30', 'all', 'm-ibu')

    const ibu = (await getCallerMember(d1, 'h1', 'u1'))!
    const entries = await listCalendarEntries(d1, 'h1', ibu.memberId, {}, NOW)
    // Order: the expired deadline, then the 11-25 deadline (all-day sorts
    // before the timed event on the same day), the timed event, and the
    // far-future 2028 deadline last.
    expect(entries.map((e) => `${e.date}:${e.id}`)).toEqual([
      '2026-11-01:doc:doc-expired',
      '2026-11-25:doc:doc-in',
      '2026-11-25:e1',
      '2028-03-10:doc:doc-far',
    ])
    expect(entries[0]).toMatchObject({
      kind: 'deadline',
      document_id: 'doc-expired',
      title: 'SIM Bapak',
      days_until_expiry: -5,
      due_soon: true,
      member_id: 'm-ibu',
    })
    expect(entries[2]).toMatchObject({ kind: 'event', time: '09:30' })
    expect(entries[3]).toMatchObject({
      kind: 'deadline',
      document_id: 'doc-far',
      due_soon: false,
    })
    // The undated document (Kartu Keluarga) never projects.
    expect(entries.some((e) => e.id === 'doc:doc-undated')).toBe(false)
  })

  it('an expires_on edit reflects on the NEXT read (derive-on-read, no drift)', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    seedDocs(sqlite)
    const ibu = (await getCallerMember(d1, 'h1', 'u1'))!

    const before = await listCalendarEntries(d1, 'h1', ibu.memberId, {}, NOW)
    expect(before.some((e) => e.id === 'doc:doc-in')).toBe(true)

    // The #434 PATCH path edits expires_on — the calendar must follow without
    // any backfill or re-seed.
    sqlite
      .prepare('UPDATE documents SET expires_on = ?, remind_days_before = ? WHERE id = ?')
      .run('2026-12-15', 14, 'doc-in')
    const after = await listCalendarEntries(d1, 'h1', ibu.memberId, {}, NOW)
    const moved = after.find((e) => e.id === 'doc:doc-in')
    expect(moved).toMatchObject({ date: '2026-12-15', days_until_expiry: 39 })
    // 14-day window: 39 days out is NOT due soon.
    expect(moved?.kind === 'deadline' && moved.due_soon).toBe(false)

    // Deleting the document removes the deadline outright.
    sqlite.prepare('DELETE FROM documents WHERE id = ?').run('doc-in')
    const gone = await listCalendarEntries(d1, 'h1', ibu.memberId, {}, NOW)
    expect(gone.some((e) => e.id === 'doc:doc-in')).toBe(false)
  })

  it('the window filters both kinds and never leaks another household', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    seedDocs(sqlite)
    sqlite
      .prepare(INSERT_EVENT)
      .run('e-early', 'h1', 'Rapat RT', '2026-11-02', null, 'all', 'm-ibu')

    const ibu = (await getCallerMember(d1, 'h1', 'u1'))!
    const month = await listCalendarEntries(
      d1,
      'h1',
      ibu.memberId,
      { from: '2026-11-01', to: '2026-11-30' },
      NOW
    )
    // doc-far (2028) is outside the window; e-early (11-02) and doc-in (11-25)
    // inside.
    const ids = month.map((e) => e.id)
    expect(ids).toContain('e-early')
    expect(ids).toContain('doc:doc-in')
    expect(ids).not.toContain('doc:doc-far')

    const narrow = await listCalendarEntries(
      d1,
      'h1',
      ibu.memberId,
      { from: '2026-11-10', to: '2026-11-20' },
      NOW
    )
    expect(narrow).toEqual([])

    // The h2 household sees none of h1's rows.
    const om = (await getCallerMember(d1, 'h2', 'u3'))!
    expect(await listCalendarEntries(d1, 'h2', om.memberId, {}, NOW)).toEqual([])
  })

  it('the union order is total and stable (compareEntries over real rows)', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite)
    seedDocs(sqlite)
    const ibu = (await getCallerMember(d1, 'h1', 'u1'))!
    const entries = await listCalendarEntries(d1, 'h1', ibu.memberId, {}, NOW)
    const sorted = [...entries].sort(compareEntries)
    expect(entries.map((e) => e.id)).toEqual(sorted.map((e) => e.id))
  })
})
