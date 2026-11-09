import { describe, it, expect, vi } from 'vite-plus/test'
import {
  createScrapeCommand,
  ScrapeConflictError,
  STALE_PENDING_AFTER_MS,
  STALE_RUNNING_AFTER_MS,
} from '../lib/scrape.js'
import { createDb } from './support/d1-sqlite.js'

// Real-SQL coverage for the scrape-commands stale reaper (ahaqqu/RumaQ#540):
// scrape.test.ts routes a fake D1 on SQL fragments — good for HTTP shapes,
// blind to whether the guarded `INSERT … SELECT … WHERE NOT EXISTS` and the
// COALESCE fallback actually behave. This file runs the same statements
// against real SQLite (D1 is SQLite) through the full migration chain.

const RUNNING_REAP_ERROR = 'reaped: no finish report after 150 min (run deadline exceeded)'
const PENDING_REAP_ERROR = 'reaped: never picked up after 60 min'

type Sqlite = ReturnType<typeof createDb>['sqlite']

type CommandRow = {
  id: string
  status: string
  exit_code: number | null
  error: string | null
  created_at: string
  picked_up_at: string | null
  finished_at: string | null
}

function seed(
  sqlite: Sqlite,
  row: {
    id: string
    status: 'pending' | 'running' | 'success' | 'failed'
    createdAt: string
    pickedUpAt?: string | null
    finishedAt?: string | null
    exitCode?: number | null
    error?: string | null
  }
): void {
  sqlite
    .prepare(
      `INSERT INTO scrape_commands
         (id, stores, status, created_by, created_at, picked_up_at, finished_at, exit_code, error)
       VALUES (?, ?, ?, 'user-1', ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      '["superindo"]',
      row.status,
      row.createdAt,
      row.pickedUpAt ?? null,
      row.finishedAt ?? null,
      row.exitCode ?? null,
      row.error ?? null
    )
}

function getCommand(sqlite: Sqlite, id: string): CommandRow {
  return sqlite
    .prepare(
      `SELECT id, status, exit_code, error, created_at, picked_up_at, finished_at
       FROM scrape_commands WHERE id = ?`
    )
    .get(id) as CommandRow
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

describe('createScrapeCommand stale reaper (real SQL)', () => {
  it('reaps a stale running command, then inserts the new pending one', async () => {
    const { sqlite, d1 } = createDb()
    const pickedUpAt = new Date(Date.now() - STALE_RUNNING_AFTER_MS - 60_000).toISOString()
    seed(sqlite, {
      id: 'stale-running',
      status: 'running',
      createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      pickedUpAt,
    })

    const { id } = await createScrapeCommand(d1, { stores: ['astro'], createdBy: 'user-1' })

    expect(getCommand(sqlite, 'stale-running')).toMatchObject({
      status: 'failed',
      exit_code: 1,
      error: RUNNING_REAP_ERROR,
      picked_up_at: pickedUpAt,
    })
    expect(getCommand(sqlite, 'stale-running').finished_at).not.toBeNull()
    expect(getCommand(sqlite, id)).toMatchObject({ status: 'pending', exit_code: null })
  })

  it('reaps a running row with no picked_up_at via its created_at', async () => {
    const { sqlite, d1 } = createDb()
    seed(sqlite, {
      id: 'null-pickup',
      status: 'running',
      createdAt: new Date(Date.now() - STALE_RUNNING_AFTER_MS - 60_000).toISOString(),
    })

    await createScrapeCommand(d1, { stores: ['astro'], createdBy: 'user-1' })

    expect(getCommand(sqlite, 'null-pickup')).toMatchObject({
      status: 'failed',
      exit_code: 1,
      error: RUNNING_REAP_ERROR,
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
      status: 'failed',
      exit_code: 1,
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
    // this finished success to failed and erase the run's real outcome.
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

  it('treats a command exactly at its ceiling as still live (strict comparison)', async () => {
    // Fake time pins the equality case: `age > ceiling` reaps, so a row whose
    // age IS the ceiling is live. `<=` would reap it and this fails.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const now = new Date('2026-11-09T12:00:00.000Z')
      vi.setSystemTime(now)
      const atRunningCeiling = new Date(now.getTime() - STALE_RUNNING_AFTER_MS).toISOString()
      const atPendingCeiling = new Date(now.getTime() - STALE_PENDING_AFTER_MS).toISOString()

      const running = createDb()
      seed(running.sqlite, {
        id: 'at-running-ceiling',
        status: 'running',
        createdAt: atRunningCeiling,
        pickedUpAt: atRunningCeiling,
      })
      await expect(
        createScrapeCommand(running.d1, { stores: ['astro'], createdBy: 'user-1' })
      ).rejects.toBeInstanceOf(ScrapeConflictError)
      expect(getCommand(running.sqlite, 'at-running-ceiling')).toMatchObject({
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
