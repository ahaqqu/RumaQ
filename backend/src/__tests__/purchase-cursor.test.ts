import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import { createDb } from './support/d1-sqlite.js'
import type { Env } from '../types.js'

// #596 — the purchases-list cursor must key on the sort's FULL order key.
// The sort is `date DESC, created_at DESC, id DESC` (#555's tiebreaker), but
// the cursor encoded only `date|created_at` and the keyset compared only
// `(date, created_at)` — so two purchases stamped in the same second
// (datetime('now') resolution) that straddled a page boundary deterministically
// SKIPPED the smaller-id row: the `created_at < ?` clause excludes the row the
// sort would have placed first on the next page.
//
// These run against REAL SQLite (node:sqlite — D1 is SQLite) through the real
// Hono route: the pinned property is "which rows come back across pages",
// which a statement-matching mock cannot express.

const OWNER = { userId: 'u1', householdId: 'h1' } as const

const { sqlite, d1 } = createDb()
sqlite.exec('PRAGMA foreign_keys = ON')

beforeEach(() => {
  sqlite.exec('DELETE FROM purchases')
  sqlite.exec('DELETE FROM household_members')
  sqlite.exec('DELETE FROM households')
  sqlite.exec('DELETE FROM users')
  sqlite.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(OWNER.userId, 'u1@b.com')
  sqlite
    .prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)')
    .run(OWNER.householdId, 'House h1', OWNER.userId)
  sqlite
    .prepare(
      `INSERT INTO household_members (id, household_id, user_id, role)
       VALUES (?, ?, ?, 'owner')`
    )
    .run('m-h1', OWNER.householdId, OWNER.userId)
})

function seedPurchase(id: string, date: string, createdAt: string, total = 10000): void {
  sqlite
    .prepare(
      `INSERT INTO purchases (id, household_id, date, total, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, OWNER.householdId, date, total, createdAt)
}

function appEnv(): Env {
  return { DB: d1, TEST_MODE: 'false', props: OWNER } as unknown as Env
}

async function listPurchases(query: string): Promise<{
  status: number
  purchases: Array<{ id: string; date: string; created_at: string }>
  next_cursor: string | null
}> {
  const res = await apiApp.request(`/api/purchases${query}`, {}, appEnv())
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    purchases: Array<{ id: string; date: string; created_at: string }>
    next_cursor: string | null
  }
  return { status: res.status, ...body }
}

describe('GET /api/purchases cursor (#596)', () => {
  it('surfaces both same-second purchases across size-1 pages in id-DESC order', async () => {
    // Same date, same created_at (the datetime('now') collision); 'p-b' >
    // 'p-a' lexicographically, so the tiebreaker must order p-b first.
    seedPurchase('p-a', '2026-06-20', '2026-06-20 03:00:00', 11000)
    seedPurchase('p-b', '2026-06-20', '2026-06-20 03:00:00', 22000)

    const page1 = await listPurchases('?limit=1')
    expect(page1.purchases.map((p) => p.id)).toEqual(['p-b'])
    expect(page1.next_cursor).toBe('2026-06-20|2026-06-20 03:00:00|p-b')

    // Pre-fix this page came back EMPTY: the cursor's `created_at < ?` clause
    // excluded p-a (same second), so the row was skipped deterministically.
    const page2 = await listPurchases(`?limit=1&cursor=${encodeURIComponent(page1.next_cursor!)}`)
    expect(page2.purchases.map((p) => p.id)).toEqual(['p-a'])
    expect(page2.next_cursor).toBeNull()
  })

  it('breaks the tie inside one page too: id-DESC is the total order', async () => {
    seedPurchase('p-a', '2026-06-20', '2026-06-20 03:00:00')
    seedPurchase('p-b', '2026-06-20', '2026-06-20 03:00:00')
    const page = await listPurchases('')
    expect(page.purchases.map((p) => p.id)).toEqual(['p-b', 'p-a'])
  })

  it('still honors a pre-#596 two-part cursor (in-flight session across the deploy)', async () => {
    // Distinct seconds here: the legacy keyset keeps its old same-second
    // window by design — the pin is that the old token still PAGES instead of
    // breaking the session.
    seedPurchase('p-a', '2026-06-20', '2026-06-20 02:59:59', 11000)
    seedPurchase('p-b', '2026-06-20', '2026-06-20 03:00:00', 22000)
    // An old client holds `date|created_at` with no id segment; it keeps the
    // legacy keyset instead of breaking its paging session mid-deploy.
    const page2 = await listPurchases('?limit=1&cursor=2026-06-20%7C2026-06-20%2003%3A00%3A00')
    expect(page2.purchases.map((p) => p.id)).toEqual(['p-a'])
    expect(page2.next_cursor).toBeNull()
  })
})
