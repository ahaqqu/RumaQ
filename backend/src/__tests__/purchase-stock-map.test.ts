import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import { createDb } from './support/d1-sqlite.js'
import type { Env } from '../types.js'

// #551 — per-receipt stock semantics:
//
// (a) The purchase loop's per-line stock SELECT ran before the batch, so it
// could not see writes the same receipt had already queued: a multi-line
// receipt naming one item wrote duplicate stock rows (each line took the
// INSERT branch) or recomputed each UPDATE from the same stale base qty, where
// last-write-wins dropped every earlier line's quantity. The loop now keeps a
// stockByItemId map and folds the receipt's deltas into ONE write per item id.
//
// (d) The stock-rename lookup bind was trim()-only — the last normalization
// divergence from the shared normalizeItemName (trim + lowercase + collapse
// inner whitespace) that both save paths resolve names by. Renaming to a
// spelling equal to an existing item only after collapsing inner whitespace
// forked a second items row instead of merging.
//
// These run against REAL SQLite (node:sqlite — D1 is SQLite) through the real
// Hono routes: the pinned property is "which rows exist after the request",
// which a statement-matching mock cannot express. The 0046 unique index backs
// the same guarantee at the schema level (the migration half of #551); these
// tests prove the map never needs it.
const OWNER = { userId: 'u1', householdId: 'h1' } as const

const { sqlite, d1 } = createDb()
// D1 enforces foreign keys; node:sqlite defaults them OFF.
sqlite.exec('PRAGMA foreign_keys = ON')

function seedHousehold(id: string, userId: string): void {
  sqlite.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(userId, `${userId}@b.com`)
  sqlite
    .prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)')
    .run(id, `House ${id}`, userId)
  sqlite
    .prepare(
      `INSERT INTO household_members (id, household_id, user_id, role)
       VALUES (?, ?, ?, 'owner')`
    )
    .run(`m-${id}`, id, userId)
}

function seedItem(id: string, householdId: string, name: string): void {
  sqlite
    .prepare('INSERT INTO items (id, household_id, name) VALUES (?, ?, ?)')
    .run(id, householdId, name)
}

function seedStock(id: string, householdId: string, itemId: string, qty: number): void {
  sqlite
    .prepare('INSERT INTO stock (id, household_id, item_id, qty) VALUES (?, ?, ?, ?)')
    .run(id, householdId, itemId, qty)
}

function count(table: string, where = '1 = 1', ...params: unknown[]): number {
  const row = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .get(...params) as {
    n: number
  }
  return row.n
}

function appEnv(identity: { userId: string; householdId: string }): Env {
  return { DB: d1, props: identity } as unknown as Env
}

async function postPurchase(items: unknown[]): Promise<Response> {
  return await apiApp.request(
    '/api/purchases',
    {
      method: 'POST',
      body: JSON.stringify({ date: '2026-11-10', items }),
      headers: { 'Content-Type': 'application/json' },
    },
    appEnv(OWNER)
  )
}

async function patchStockName(stockId: string, name: string): Promise<Response> {
  return await apiApp.request(
    `/api/stock/${stockId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ name }),
      headers: { 'Content-Type': 'application/json' },
    },
    appEnv(OWNER)
  )
}

function stockRows(): Array<{ id: string; item_id: string; qty: number; unit: string | null }> {
  return sqlite
    .prepare('SELECT id, item_id, qty, unit FROM stock ORDER BY item_id, id')
    .all() as Array<{ id: string; item_id: string; qty: number; unit: string | null }>
}

function itemNames(): string[] {
  return (
    sqlite.prepare('SELECT name FROM items ORDER BY created_at, id').all() as Array<{
      name: string
    }>
  ).map((r) => r.name)
}

beforeEach(() => {
  // Children first: the same order an FK-enforcing delete needs (D1 semantics).
  for (const table of [
    'purchase_items',
    'stock',
    'purchases',
    'plan_items',
    'plans',
    'items',
    'household_members',
    'households',
    'users',
  ]) {
    sqlite.exec(`DELETE FROM ${table}`)
  }
  seedHousehold('h1', 'u1')
})

describe('POST /api/purchases — one stock write per item id per receipt (#551 a)', () => {
  it('collapses two lines of one new name into a single summed stock row', async () => {
    // New-item variant: pre-fix both lines took the INSERT branch — two stock
    // rows, each carrying only its own line's qty.
    const res = await postPurchase([
      { name: 'Susu cair', qty: 1, unit: 'L', price: 18500 },
      { name: 'Susu Cair', qty: 2, unit: 'L', price: 18500 },
    ])

    expect(res.status).toBe(201)
    const rows = stockRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ qty: 3, unit: 'L' })

    // The response echoes the same single row.
    const body = (await res.json()) as { stock: Array<{ qty: number }> }
    expect(body.stock).toHaveLength(1)
    expect(body.stock[0]?.qty).toBe(3)
  })

  it('adds an existing item across same-receipt lines — no last-write-wins drop', async () => {
    // Existing-item variant: seed stock qty 5; lines add 2 and 3. Pre-fix both
    // UPDATEs computed from the stale base — final qty 5+3=8, line 1's qty
    // silently dropped.
    seedItem('i-susu', 'h1', 'Susu Cair')
    seedStock('s-susu', 'h1', 'i-susu', 5)
    const res = await postPurchase([
      { name: 'Susu Cair', qty: 2, unit: 'L', price: 18500 },
      { name: ' SUSU   CAIR ', qty: 3, unit: 'L', price: 18500 },
    ])

    expect(res.status).toBe(201)
    expect(stockRows()).toEqual([expect.objectContaining({ item_id: 'i-susu', qty: 10 })])
    // The UPDATE branch never touches the pre-existing row's unit.
    expect(stockRows()[0]?.unit).toBeNull()
  })

  it('sums two explicit item_id lines into one stock write (existing stock)', async () => {
    seedItem('i-milk', 'h1', 'Milk')
    seedStock('s-milk', 'h1', 'i-milk', 5)
    const res = await postPurchase([
      { name: 'Milk', qty: 2, unit: 'L', price: 20000, item_id: 'i-milk' },
      { name: 'Milk', qty: 3, unit: 'L', price: 20000, item_id: 'i-milk' },
    ])

    expect(res.status).toBe(201)
    // Pre-fix: qty 8 (the second UPDATE's stale-base recomputation won).
    expect(stockRows()).toEqual([expect.objectContaining({ item_id: 'i-milk', qty: 10 })])
  })

  it('sums two explicit item_id lines into one INSERT when no stock row exists', async () => {
    seedItem('i-milk', 'h1', 'Milk')
    const res = await postPurchase([
      { name: 'Milk', qty: 2, unit: 'L', price: 20000, item_id: 'i-milk' },
      { name: 'Milk', qty: 3, unit: 'L', price: 20000, item_id: 'i-milk' },
    ])

    expect(res.status).toBe(201)
    // Pre-fix: two INSERT branches — two duplicate stock rows (the exact bug
    // the reviewer's verification caught in #550).
    expect(stockRows()).toHaveLength(1)
    expect(stockRows()[0]).toMatchObject({ item_id: 'i-milk', qty: 5, unit: 'L' })
  })

  it('shares one stock row between an explicit item_id line and a same-name line', async () => {
    // The id line and the name line resolve to the SAME items row (' MILK '
    // normalizes onto the seeded 'Milk'), so both deltas land on one entry —
    // pre-fix each line SELECTed nothing and each queued its own INSERT.
    seedItem('i-milk', 'h1', 'Milk')
    const res = await postPurchase([
      { name: 'Milk', qty: 2, unit: 'L', price: 20000, item_id: 'i-milk' },
      { name: ' MILK ', qty: 3, unit: 'L', price: 20000 },
    ])

    expect(res.status).toBe(201)
    expect(count('items', 'household_id = ?', 'h1')).toBe(1)
    expect(stockRows()).toHaveLength(1)
    expect(stockRows()[0]).toMatchObject({ item_id: 'i-milk', qty: 5 })
  })

  it('keeps distinct items distinct — one summed stock row per item id', async () => {
    seedItem('i-susu', 'h1', 'Susu Cair')
    seedStock('s-susu', 'h1', 'i-susu', 1)
    const res = await postPurchase([
      { name: 'Susu Cair', qty: 2, unit: 'L', price: 18500 },
      { name: 'Telur', qty: 1, unit: 'pcs', price: 2800 },
      { name: 'susu cair', qty: 3, unit: 'L', price: 18500 },
    ])

    expect(res.status).toBe(201)
    const rows = stockRows()
    expect(rows).toHaveLength(2)
    // Order-independent: the new item's id is a random UUID.
    const susu = rows.find((r) => r.item_id === 'i-susu')
    expect(susu).toMatchObject({ qty: 6 })
    const telur = rows.find((r) => r.item_id !== 'i-susu')
    expect(telur).toMatchObject({ qty: 1, unit: 'pcs' })
    // The INSERT branch keeps the new item's first line's unit and the
    // 30-day default run-out (unchanged pre/post); the UPDATE branch leaves
    // the pre-existing row's unit alone.
    const runOut = sqlite.prepare('SELECT run_out_days, basis FROM stock WHERE unit = ?').get('pcs')
    expect(runOut).toMatchObject({ run_out_days: 30, basis: 'default' })
  })
})

describe('PATCH /api/stock/:id — rename resolves through the shared normalization (#551 d)', () => {
  it('merges into the existing items row when the spelling matches only after normalization', async () => {
    // Pre-fix the lookup key was trim()-only: 'black   tea' (doubled inner
    // space) missed the seeded 'Black Tea' row and forked a second items row.
    seedItem('i-tea', 'h1', 'Black Tea')
    seedItem('i-old', 'h1', 'Tea Old')
    seedStock('s1', 'h1', 'i-old', 2)

    const res = await patchStockName('s1', '  black   tea  ')
    expect(res.status).toBe(200)

    const row = sqlite.prepare('SELECT item_id FROM stock WHERE id = ?').get('s1') as {
      item_id: string
    }
    expect(row.item_id).toBe('i-tea')
    // No fork: still exactly the two seeded rows.
    expect(count('items', 'household_id = ?', 'h1')).toBe(2)
  })

  it('creates on a true miss and keeps the trimmed display name', async () => {
    // Display-name semantics match both save paths: trim only, inner
    // whitespace and case of the renaming spelling preserved.
    seedItem('i-old', 'h1', 'Tea Old')
    seedStock('s1', 'h1', 'i-old', 2)

    const res = await patchStockName('s1', '  Green  Tea  ')
    expect(res.status).toBe(200)

    expect(itemNames().sort()).toEqual(['Green  Tea', 'Tea Old'])
    const row = sqlite.prepare('SELECT item_id FROM stock WHERE id = ?').get('s1') as {
      item_id: string
    }
    const created = sqlite.prepare('SELECT id FROM items WHERE name = ?').get('Green  Tea') as {
      id: string
    }
    expect(row.item_id).toBe(created.id)
  })

  it('still merges a case/padding-only variant (trim + lowercase regression pin)', async () => {
    seedItem('i-milk', 'h1', 'Milk')
    seedItem('i-old', 'h1', 'Tea Old')
    seedStock('s1', 'h1', 'i-old', 2)

    const res = await patchStockName('s1', '  MILK ')
    expect(res.status).toBe(200)

    const row = sqlite.prepare('SELECT item_id FROM stock WHERE id = ?').get('s1') as {
      item_id: string
    }
    expect(row.item_id).toBe('i-milk')
    expect(count('items', 'household_id = ?', 'h1')).toBe(2)
  })
})
