import { describe, it, expect, vi } from 'vite-plus/test'
import {
  appendScrapeEvents,
  claimNextScrapeCommand,
  createScrapeCommand,
  finishScrapeCommand,
  ScrapeConflictError,
  STALE_PENDING_AFTER_MS,
  STALE_SILENCE_AFTER_MS,
} from '../lib/scrape.js'
import { createDb } from './support/d1-sqlite.js'

// Real-SQL coverage for the scrape-commands lease (ahaqqu/RumaQ#540, then
// audit 2026-11-16 M1): scrape.test.ts routes a fake D1 on SQL fragments —
// good for HTTP shapes, blind to whether the guarded `INSERT … SELECT …
// WHERE NOT EXISTS` and the COALESCE silence predicate actually behave. This
// file runs the same statements against real SQLite (D1 is SQLite) through
// the full migration chain.

const RUNNING_REAP_ERROR = 'reaped: silent for 45 min (no heartbeat, events, or finish report)'
const PENDING_REAP_ERROR = 'reaped: never picked up after 60 min'

type Sqlite = ReturnType<typeof createDb>['sqlite']

type CommandRow = {
  id: string
  status: string
  exit_code: number | null
  error: string | null
  created_at: string
  picked_up_at: string | null
  heartbeat_at: string | null
  finished_at: string | null
}

function seed(
  sqlite: Sqlite,
  row: {
    id: string
    status: 'pending' | 'running' | 'success' | 'failed' | 'reaped'
    createdAt: string
    pickedUpAt?: string | null
    heartbeatAt?: string | null
    finishedAt?: string | null
    exitCode?: number | null
    error?: string | null
  }
): void {
  sqlite
    .prepare(
      `INSERT INTO scrape_commands
         (id, stores, status, created_by, created_at, picked_up_at, heartbeat_at, finished_at, exit_code, error)
       VALUES (?, ?, ?, 'user-1', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      '["superindo"]',
      row.status,
      row.createdAt,
      row.pickedUpAt ?? null,
      row.heartbeatAt ?? null,
      row.finishedAt ?? null,
      row.exitCode ?? null,
      row.error ?? null
    )
}

function getCommand(sqlite: Sqlite, id: string): CommandRow {
  return sqlite
    .prepare(
      `SELECT id, status, exit_code, error, created_at, picked_up_at, heartbeat_at, finished_at
       FROM scrape_commands WHERE id = ?`
    )
    .get(id) as CommandRow
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

describe('createScrapeCommand reaper (real SQL, silence semantics)', () => {
  it('reaps a silent running command, then inserts the new pending one', async () => {
    const { sqlite, d1 } = createDb()
    // Pre-lease row: no heartbeat, silence measured from picked_up_at.
    const pickedUpAt = new Date(Date.now() - STALE_SILENCE_AFTER_MS - 60_000).toISOString()
    seed(sqlite, {
      id: 'stale-running',
      status: 'running',
      createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      pickedUpAt,
    })

    const { id } = await createScrapeCommand(d1, { stores: ['astro'], createdBy: 'user-1' })

    expect(getCommand(sqlite, 'stale-running')).toMatchObject({
      status: 'reaped',
      exit_code: null,
      error: RUNNING_REAP_ERROR,
      picked_up_at: pickedUpAt,
    })
    expect(getCommand(sqlite, 'stale-running').finished_at).not.toBeNull()
    expect(getCommand(sqlite, id)).toMatchObject({ status: 'pending', exit_code: null })
  })

  it('reaps a running row with no picked_up_at via its created_at', async () => {
    const { sqlite, d1 } = createDb()
    // Hand-written row: neither heartbeat nor pickup — the created_at
    // fallback keeps it from wedging the one-at-a-time queue forever.
    seed(sqlite, {
      id: 'null-pickup',
      status: 'running',
      createdAt: new Date(Date.now() - STALE_SILENCE_AFTER_MS - 60_000).toISOString(),
    })

    await createScrapeCommand(d1, { stores: ['astro'], createdBy: 'user-1' })

    expect(getCommand(sqlite, 'null-pickup')).toMatchObject({
      status: 'reaped',
      exit_code: null,
      error: RUNNING_REAP_ERROR,
    })
  })

  it('never reaps a running row that reported within the silence window, however old', async () => {
    const { sqlite, d1 } = createDb()
    // Queued four hours ago and claimed 90 minutes ago, but the events POST
    // renewed the heartbeat one minute ago: the old age-since-claim ceiling
    // would have reaped this run (the L1 coupling the lease removes).
    seed(sqlite, {
      id: 'live-old-run',
      status: 'running',
      createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      pickedUpAt: minutesAgo(90),
      heartbeatAt: minutesAgo(1),
    })

    const error = await createScrapeCommand(d1, {
      stores: ['astro'],
      createdBy: 'user-1',
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ScrapeConflictError)
    expect(getCommand(sqlite, 'live-old-run')).toMatchObject({
      status: 'running',
      exit_code: null,
      error: null,
      finished_at: null,
    })
  })

  it('reaps a stale pending command but not a fresh one', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite, {
      id: 'stale-pending',
      status: 'pending',
      createdAt: minutesAgo(STALE_PENDING_AFTER_MS / 60000 + 1),
    })
    await createScrapeCommand(d1, { stores: ['astro'], createdBy: 'user-1' })
    expect(getCommand(sqlite, 'stale-pending')).toMatchObject({
      status: 'reaped',
      exit_code: null,
      error: PENDING_REAP_ERROR,
    })

    // A fresh pending row is live: the guarded INSERT refuses, and the reaper
    // leaves the row alone.
    const fresh = createDb()
    const freshCreatedAt = minutesAgo(5)
    seed(fresh.sqlite, {
      id: 'fresh-pending',
      status: 'pending',
      createdAt: freshCreatedAt,
    })
    const error = await createScrapeCommand(fresh.d1, {
      stores: ['astro'],
      createdBy: 'user-1',
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ScrapeConflictError)
    expect((error as ScrapeConflictError).activeCommand).toEqual({
      id: 'fresh-pending',
      status: 'pending',
      createdAt: freshCreatedAt,
      pickedUpAt: null,
    })
    expect(getCommand(fresh.sqlite, 'fresh-pending')).toMatchObject({
      status: 'pending',
      exit_code: null,
      error: null,
      finished_at: null,
    })
  })

  it('never reaps a fresh running command; reports it as the conflict', async () => {
    const { sqlite, d1 } = createDb()
    const createdAt = minutesAgo(8)
    const pickedUpAt = minutesAgo(5)
    seed(sqlite, { id: 'live', status: 'running', createdAt, pickedUpAt })

    const error = await createScrapeCommand(d1, {
      stores: ['astro'],
      createdBy: 'user-1',
    }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ScrapeConflictError)
    expect((error as ScrapeConflictError).activeCommand).toEqual({
      id: 'live',
      status: 'running',
      createdAt,
      pickedUpAt,
    })
    expect(getCommand(sqlite, 'live')).toMatchObject({
      status: 'running',
      exit_code: null,
      error: null,
      finished_at: null,
    })
  })

  it('measures a running command from its pickup, not its queue time', async () => {
    const { sqlite, d1 } = createDb()
    // Queued four hours ago (agent down), claimed five minutes ago: created_at
    // alone would reap a live run, so the reaper must read picked_up_at.
    const createdAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
    const pickedUpAt = minutesAgo(5)
    seed(sqlite, { id: 'slow-claim', status: 'running', createdAt, pickedUpAt })

    const error = await createScrapeCommand(d1, {
      stores: ['astro'],
      createdBy: 'user-1',
    }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ScrapeConflictError)
    expect((error as ScrapeConflictError).activeCommand).toEqual({
      id: 'slow-claim',
      status: 'running',
      createdAt,
      pickedUpAt,
    })
    expect(getCommand(sqlite, 'slow-claim')).toMatchObject({
      status: 'running',
      exit_code: null,
      error: null,
      finished_at: null,
    })
  })

  it('never reaps a terminal command, however old', async () => {
    const { sqlite, d1 } = createDb()
    // The status guard is the audit trail: an age-only predicate would flip
    // this finished success and erase the run's real outcome.
    const finishedAt = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
    seed(sqlite, {
      id: 'old-success',
      status: 'success',
      createdAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
      pickedUpAt: new Date(Date.now() - 6.5 * 60 * 60 * 1000).toISOString(),
      finishedAt,
      exitCode: 0,
    })

    await createScrapeCommand(d1, { stores: ['astro'], createdBy: 'user-1' })

    expect(getCommand(sqlite, 'old-success')).toMatchObject({
      status: 'success',
      exit_code: 0,
      error: null,
      finished_at: finishedAt,
    })
  })

  it('treats a command exactly at its silence/age ceiling as still live (strict comparison)', async () => {
    // Fake time pins the equality case: `silence > ceiling` reaps, so a row
    // whose silence IS the ceiling is live. `<=` would reap it and this fails.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const now = new Date('2026-11-09T12:00:00.000Z')
      vi.setSystemTime(now)
      const atSilenceCeiling = new Date(now.getTime() - STALE_SILENCE_AFTER_MS).toISOString()
      const atPendingCeiling = new Date(now.getTime() - STALE_PENDING_AFTER_MS).toISOString()

      const running = createDb()
      seed(running.sqlite, {
        id: 'at-silence-ceiling',
        status: 'running',
        createdAt: atSilenceCeiling,
        pickedUpAt: atSilenceCeiling,
      })
      await expect(
        createScrapeCommand(running.d1, { stores: ['astro'], createdBy: 'user-1' })
      ).rejects.toBeInstanceOf(ScrapeConflictError)
      expect(getCommand(running.sqlite, 'at-silence-ceiling')).toMatchObject({
        status: 'running',
        finished_at: null,
      })

      const pending = createDb()
      seed(pending.sqlite, {
        id: 'at-pending-ceiling',
        status: 'pending',
        createdAt: atPendingCeiling,
      })
      await expect(
        createScrapeCommand(pending.d1, { stores: ['astro'], createdBy: 'user-1' })
      ).rejects.toBeInstanceOf(ScrapeConflictError)
      expect(getCommand(pending.sqlite, 'at-pending-ceiling')).toMatchObject({
        status: 'pending',
        finished_at: null,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes exactly one command across sequential creates (guarded INSERT)', async () => {
    const { sqlite, d1 } = createDb()
    const first = await createScrapeCommand(d1, { stores: ['astro'], createdBy: 'user-1' })
    await expect(
      createScrapeCommand(d1, { stores: ['superindo'], createdBy: 'user-1' })
    ).rejects.toBeInstanceOf(ScrapeConflictError)

    const rows = sqlite.prepare(`SELECT id, status FROM scrape_commands`).all() as Array<{
      id: string
      status: string
    }>
    expect(rows).toEqual([{ id: first.id, status: 'pending' }])
  })
})

describe('the lease (real SQL): claim, events renewal, finish-after-reap', () => {
  it('claim stamps heartbeat_at alongside picked_up_at', async () => {
    const { sqlite, d1 } = createDb()
    const before = new Date().toISOString()
    await createScrapeCommand(d1, { stores: ['astro'], createdBy: 'user-1' })
    const claimed = await claimNextScrapeCommand(d1)
    expect(claimed).not.toBeNull()

    const row = getCommand(sqlite, claimed!.id)
    expect(row.status).toBe('running')
    expect(row.picked_up_at).not.toBeNull()
    expect(row.heartbeat_at).not.toBeNull()
    expect(row.heartbeat_at!).toBe(row.picked_up_at)
    expect(row.heartbeat_at! >= before).toBe(true)
  })

  it('events renew the lease: silence extends past the ceiling while the run reports', async () => {
    const { sqlite, d1 } = createDb()
    await createScrapeCommand(d1, { stores: ['astro'], createdBy: 'user-1' })
    const claimed = (await claimNextScrapeCommand(d1))!
    // Backdate the claim past the silence ceiling.
    const stalePickup = new Date(Date.now() - STALE_SILENCE_AFTER_MS - 30 * 60_000).toISOString()
    sqlite
      .prepare(`UPDATE scrape_commands SET picked_up_at = ?, heartbeat_at = ? WHERE id = ?`)
      .run(stalePickup, stalePickup, claimed.id)

    // The run posts an event NOW — the renewal stamps a fresh heartbeat.
    await appendScrapeEvents(d1, claimed.id, [
      { seq: 0, ts: new Date().toISOString(), level: 'info', message: 'still scraping' },
    ])
    const row = getCommand(sqlite, claimed.id)
    expect(row.heartbeat_at).not.toBeNull()
    expect(row.heartbeat_at! > stalePickup).toBe(true)

    // The create path's reaper runs the same statements as the claim sweep:
    // the renewed row survives.
    await expect(
      createScrapeCommand(d1, { stores: ['astro'], createdBy: 'user-1' })
    ).rejects.toBeInstanceOf(ScrapeConflictError)
    expect(getCommand(sqlite, claimed.id).status).toBe('running')
  })

  it('a finish after the reap answers 409 and the row stays reaped', async () => {
    const { sqlite, d1 } = createDb()
    await createScrapeCommand(d1, { stores: ['astro'], createdBy: 'user-1' })
    const claimed = (await claimNextScrapeCommand(d1))!
    // The agent goes silent past the ceiling; the next claim sweep reaps.
    sqlite
      .prepare(`UPDATE scrape_commands SET picked_up_at = ?, heartbeat_at = ? WHERE id = ?`)
      .run(minutesAgo(STALE_SILENCE_AFTER_MS / 60000 + 5), null, claimed.id)
    await claimNextScrapeCommand(d1) // runs the silence reap in its sweep
    const reaped = getCommand(sqlite, claimed.id)
    expect(reaped.status).toBe('reaped')
    expect(reaped.exit_code).toBeNull()

    // The finish arriving after the reap is REFUSED, not silently ok'd —
    // the pipeline agent reads any non-2xx as "this report never landed".
    await expect(
      finishScrapeCommand(d1, claimed.id, { status: 'success', exitCode: 0 })
    ).rejects.toBeInstanceOf(ScrapeConflictError)
    expect(getCommand(sqlite, claimed.id)).toMatchObject({
      status: 'reaped',
      exit_code: null,
      finished_at: reaped.finished_at,
    })
  })

  it('a finish on a running row still lands (the lease does not block real reports)', async () => {
    const { sqlite, d1 } = createDb()
    await createScrapeCommand(d1, { stores: ['astro'], createdBy: 'user-1' })
    const claimed = (await claimNextScrapeCommand(d1))!
    await appendScrapeEvents(d1, claimed.id, [
      { seq: 0, ts: new Date().toISOString(), level: 'info', message: 'x' },
    ])
    await finishScrapeCommand(d1, claimed.id, { status: 'success', exitCode: 0 })
    expect(getCommand(sqlite, claimed.id)).toMatchObject({
      status: 'success',
      exit_code: 0,
      finished_at: expect.any(String),
    })
  })

  it('events for a reaped command answer 409 (the terminal set grew)', async () => {
    const { sqlite, d1 } = createDb()
    await createScrapeCommand(d1, { stores: ['astro'], createdBy: 'user-1' })
    const claimed = (await claimNextScrapeCommand(d1))!
    // The agent goes silent: heartbeat and pickup both past the ceiling.
    const stale = minutesAgo(STALE_SILENCE_AFTER_MS / 60000 + 5)
    sqlite
      .prepare(`UPDATE scrape_commands SET picked_up_at = ?, heartbeat_at = ? WHERE id = ?`)
      .run(stale, stale, claimed.id)
    await claimNextScrapeCommand(d1)
    expect(getCommand(sqlite, claimed.id).status).toBe('reaped')

    await expect(
      appendScrapeEvents(d1, claimed.id, [
        { seq: 1, ts: new Date().toISOString(), level: 'info', message: 'late' },
      ])
    ).rejects.toBeInstanceOf(ScrapeConflictError)
    const count = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM scrape_run_events WHERE command_id = ?`)
      .get(claimed.id) as { n: number }
    expect(count.n).toBe(0)
  })

  it('the events renewal does not resurrect a command reaped mid-batch', async () => {
    // The renewal UPDATE is guarded on status='running' inside the same
    // batch: a reap that committed between the events SELECT and the batch
    // leaves the row reaped, heartbeat untouched.
    const { sqlite, d1 } = createDb()
    await createScrapeCommand(d1, { stores: ['astro'], createdBy: 'user-1' })
    const claimed = (await claimNextScrapeCommand(d1))!
    await appendScrapeEvents(d1, claimed.id, [
      { seq: 0, ts: new Date().toISOString(), level: 'info', message: 'x' },
    ])
    expect(getCommand(sqlite, claimed.id).heartbeat_at).not.toBeNull()
    // Reap it (silence sweep), then replay an events batch: the SELECT
    // refuses before the renewal can run.
    const stale = minutesAgo(STALE_SILENCE_AFTER_MS / 60000 + 5)
    sqlite
      .prepare(`UPDATE scrape_commands SET picked_up_at = ?, heartbeat_at = ? WHERE id = ?`)
      .run(stale, stale, claimed.id)
    await claimNextScrapeCommand(d1)
    expect(getCommand(sqlite, claimed.id).status).toBe('reaped')
    const heartbeatAtReap = getCommand(sqlite, claimed.id).heartbeat_at

    await expect(
      appendScrapeEvents(d1, claimed.id, [
        { seq: 1, ts: new Date().toISOString(), level: 'info', message: 'late' },
      ])
    ).rejects.toBeInstanceOf(ScrapeConflictError)
    // The refusal left the reap's terminal state untouched.
    expect(getCommand(sqlite, claimed.id)).toMatchObject({
      status: 'reaped',
      heartbeat_at: heartbeatAtReap,
    })
  })
})
