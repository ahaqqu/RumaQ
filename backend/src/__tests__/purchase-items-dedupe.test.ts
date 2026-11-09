import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import { createDb } from './support/d1-sqlite.js'
import type { Env } from '../types.js'

// #526: the purchase loop resolved each line's name against the DB, but the
// items INSERTs it had pushed were still pending — the batch only runs after
// the loop — so two lines of one NEW name each pushed an INSERT and produced
// duplicate items rows in a single receipt. Plan-save already keeps an
// itemIdsByName map over normalizeItemName for exactly this; the purchase loop
// now keeps the same map over the same normalization, so a name dedupes to one
// items row per receipt no matter which feature saved it.
//
// These run against REAL SQLite (node:sqlite — D1 is SQLite) through the real
// Hono route: the bug is "which rows exist after one receipt", which a
// statement-matching mock cannot express. Pre-fix, every same-name case below
// answers 201 with two items rows — these tests fail there.
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

async function postPurchase(
  identity: { userId: string; householdId: string },
  items: unknown[]
): Promise<Response> {
  return await apiApp.request(
    '/api/purchases',
    {
      method: 'POST',
      body: JSON.stringify({ date: '2026-11-10', items }),
      headers: { 'Content-Type': 'application/json' },
    },
    appEnv(identity)
  )
}

function itemsRows(): Array<{ id: string; name: string }> {
  return sqlite.prepare('SELECT id, name FROM items').all() as Array<{ id: string; name: string }>
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

describe('POST /api/purchases — one items row per distinct normalized name (#526)', () => {
  it('collapses two lines of one new name into a single items row', async () => {
    const res = await postPurchase(OWNER, [
      { name: 'Susu cair', qty: 1, unit: 'L', price: 18500 },
      { name: 'Susu Cair', qty: 2, unit: 'L', price: 18500 },
    ])

    expect(res.status).toBe(201)
    // Exactly one items row for the one distinct name; both receipt lines
    // reference it. Pre-fix: two items rows, one per line.
    expect(count('items', 'household_id = ?', 'h1')).toBe(1)
    expect(count('purchases', 'household_id = ?', 'h1')).toBe(1)
    // purchase_items carries no household_id — scope through the receipt.
    expect(
      count(
        'purchase_items pi JOIN purchases p ON p.id = pi.purchase_id',
        'p.household_id = ?',
        'h1'
      )
    ).toBe(2)
    const lines = sqlite
      .prepare('SELECT COUNT(DISTINCT item_id) AS n FROM purchase_items')
      .get() as { n: number }
    expect(lines.n).toBe(1)
    // The stored display name is the FIRST line's trim, as plan-save keeps it.
    expect(itemsRows().map((i) => i.name)).toEqual(['Susu cair'])
  })

  it('normalizes like plan-save: case, padding and inner whitespace do not fork a row', async () => {
    // normalizeItemName = trim + lowercase + collapse inner whitespace, so
    // these three spellings are one name. Pre-fix the lookup key was only
    // trim+lowercase, so the middle spelling's doubled space forked a row.
    const res = await postPurchase(OWNER, [
      { name: 'susu cair', qty: 1, unit: 'L', price: 18500 },
      { name: '  SUSU   CAIR  ', qty: 1, unit: 'L', price: 18500 },
      { name: 'Susu Cair', qty: 1, unit: 'L', price: 18500 },
    ])

    expect(res.status).toBe(201)
    expect(count('items', 'household_id = ?', 'h1')).toBe(1)
    expect(
      count(
        'purchase_items pi JOIN purchases p ON p.id = pi.purchase_id',
        'p.household_id = ?',
        'h1'
      )
    ).toBe(3)
    // First line's trim wins for the display name (plan-save semantics —
    // inner whitespace of the winning line is kept, not collapsed).
    expect(itemsRows().map((i) => i.name)).toEqual(['susu cair'])
  })

  it('matches a pre-seeded row whose name is equal only after plan-save normalization', async () => {
    // Cross-feature dedupe: a plan saved "Susu Cair" earlier; a receipt line
    // typed with a doubled space must land on that row, not fork a second one.
    seedItem('i-susu', 'h1', 'Susu Cair')
    const res = await postPurchase(OWNER, [{ name: 'Susu  cair', qty: 1, unit: 'L', price: 18500 }])

    expect(res.status).toBe(201)
    expect(count('items', 'household_id = ?', 'h1')).toBe(1)
    const line = sqlite.prepare('SELECT item_id FROM purchase_items').get() as {
      item_id: string
    }
    expect(line.item_id).toBe('i-susu')
  })

  it('reuses a pre-existing item for both lines without creating a row', async () => {
    seedItem('i-milk', 'h1', 'Milk')
    const res = await postPurchase(OWNER, [
      { name: 'Milk', qty: 1, unit: 'L', price: 18500 },
      { name: ' MILK ', qty: 2, unit: 'L', price: 18500 },
    ])

    expect(res.status).toBe(201)
    expect(count('items', 'household_id = ?', 'h1')).toBe(1)
    expect(count('purchase_items', 'item_id = ?', 'i-milk')).toBe(2)
  })

  it('treats an explicit item_id line as authoritative — it does not seed the name map', async () => {
    // The item_id branch never creates rows, so it cannot cause the #526
    // duplicate; its display name is also not the item's stored name. A later
    // name-only line therefore resolves by its OWN name against the DB —
    // "milk" here matches nothing and is created, while "Full Cream Milk"
    // stays the id line's row. One row per distinct normalized name still holds.
    seedItem('i-fcm', 'h1', 'Full Cream Milk')
    const res = await postPurchase(OWNER, [
      { name: 'Milk', qty: 1, unit: 'L', price: 18500, item_id: 'i-fcm' },
      { name: 'milk', qty: 1, unit: 'L', price: 18500 },
    ])

    expect(res.status).toBe(201)
    expect(count('items', 'household_id = ?', 'h1')).toBe(2)
    expect(
      itemsRows()
        .map((i) => i.name)
        .sort()
    ).toEqual(['Full Cream Milk', 'milk'])
    const lines = sqlite
      .prepare('SELECT COUNT(DISTINCT item_id) AS n FROM purchase_items')
      .get() as { n: number }
    expect(lines.n).toBe(2)
  })
})
