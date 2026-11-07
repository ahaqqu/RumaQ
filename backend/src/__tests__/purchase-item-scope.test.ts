import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import { createDb } from './support/d1-sqlite.js'
import type { Env } from '../types.js'

// #517: POST /api/purchases trusted a client-supplied item_id, so a crafted
// receipt could attach another household's item — and its name — to this
// household's purchase history and stock. The same class was checked on the
// plan check-off path (PATCH /api/plans/:id/items/:itemId), which copies
// plan_items.item_id into purchase_items/stock.
//
// These run against REAL SQLite (node:sqlite — D1 is SQLite) through the real
// Hono route: the bug is a household-scope predicate in SQL, so the pinned
// property is "which rows exist afterwards and who can see them", which a
// statement-matching mock cannot express. Pre-fix, the foreign-id cases
// answer 201 and link the other household's item — these tests fail there.
const OWNER = { userId: 'u1', householdId: 'h1' } as const
const OTHER = { userId: 'u2', householdId: 'h2' } as const

const { sqlite, d1 } = createDb()
// D1 enforces foreign keys; node:sqlite defaults them OFF. The plan_items rows
// below are FK-legal (the item EXISTS — it belongs to someone else), so these
// tests pin the household scope, not a constraint.
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

function seedPlanItem(id: string, itemId: string, planId = 'p1'): void {
  sqlite
    .prepare(
      `INSERT INTO plan_items (id, plan_id, item_id, qty, unit, status)
       VALUES (?, ?, ?, 1, 'pcs', 'pending')`
    )
    .run(id, planId, itemId)
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
      body: JSON.stringify({ date: '2026-11-08', items }),
      headers: { 'Content-Type': 'application/json' },
    },
    appEnv(identity)
  )
}

async function patchPlanItem(
  identity: { userId: string; householdId: string },
  planItemId: string,
  status: 'bought' | 'skipped'
): Promise<Response> {
  return await apiApp.request(
    `/api/plans/p1/items/${planItemId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status }),
      headers: { 'Content-Type': 'application/json' },
    },
    appEnv(identity)
  )
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
  seedHousehold('h2', 'u2')
  seedItem('i-h1', 'h1', 'Milk')
  seedItem('i-h2', 'h2', 'Foreign Coffee')
})

describe('POST /api/purchases — item_id must belong to the household (#517)', () => {
  it('accepts an item_id owned by the household and writes the purchase + stock', async () => {
    const res = await postPurchase(OWNER, [
      { name: 'Milk', qty: 2, unit: 'L', price: 37000, item_id: 'i-h1' },
    ])

    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      items: Array<{ item_id: string; name: string; qty: number }>
      stock: Array<{ name: string; qty: number }>
    }
    // Response shape unchanged: the line carries the resolved item and name.
    expect(body.items).toHaveLength(1)
    expect(body.items[0].item_id).toBe('i-h1')
    expect(body.items[0].name).toBe('Milk')
    expect(body.items[0].qty).toBe(2)
    expect(body.stock.map((s) => s.name)).toEqual(['Milk'])

    expect(count('purchases', 'household_id = ?', 'h1')).toBe(1)
    expect(count('purchase_items', 'item_id = ?', 'i-h1')).toBe(1)
    expect(count('stock', 'household_id = ? AND item_id = ?', 'h1', 'i-h1')).toBe(1)
  })

  it('rejects a foreign item_id with 404 and writes nothing', async () => {
    const res = await postPurchase(OWNER, [
      { name: 'Foreign Coffee', qty: 1, unit: 'pcs', price: 5000, item_id: 'i-h2' },
    ])

    expect(res.status).toBe(404)
    // No existence disclosure: identical body to an unknown id.
    expect(await res.json()).toEqual({ error: 'Item not found' })
    // Pre-fix this answered 201 with an h1 purchase line linked to h2's item.
    expect(count('purchases')).toBe(0)
    expect(count('purchase_items')).toBe(0)
    expect(count('stock')).toBe(0)
  })

  it('rejects an unknown item_id with the same 404 and writes nothing', async () => {
    const res = await postPurchase(OWNER, [
      { name: 'Ghost', qty: 1, unit: 'pcs', price: 1000, item_id: 'i-not-a-real-id' },
    ])

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Item not found' })
    expect(count('purchases')).toBe(0)
    expect(count('purchase_items')).toBe(0)
    expect(count('stock')).toBe(0)
  })

  it('writes nothing from a mixed receipt when one line names a foreign item', async () => {
    // Every line resolves before the batch is issued, so the owned line cannot
    // leave a purchase header or a half-written stock row behind either.
    const res = await postPurchase(OWNER, [
      { name: 'Milk', qty: 1, unit: 'L', price: 18500, item_id: 'i-h1' },
      { name: 'Foreign Coffee', qty: 1, unit: 'pcs', price: 5000, item_id: 'i-h2' },
    ])

    expect(res.status).toBe(404)
    expect(count('purchases')).toBe(0)
    expect(count('purchase_items')).toBe(0)
    expect(count('stock')).toBe(0)
  })

  it('accepts the very same id from its owning household (scope, not existence)', async () => {
    const res = await postPurchase(OTHER, [
      { name: 'Foreign Coffee', qty: 1, unit: 'pcs', price: 5000, item_id: 'i-h2' },
    ])

    expect(res.status).toBe(201)
    expect(count('purchase_items', 'item_id = ?', 'i-h2')).toBe(1)
    expect(count('stock', 'household_id = ? AND item_id = ?', 'h2', 'i-h2')).toBe(1)
  })
})

describe('PATCH /api/plans/:id/items/:itemId — check-off never links a foreign item (#517)', () => {
  beforeEach(() => {
    sqlite
      .prepare(`INSERT INTO plans (id, household_id, status) VALUES ('p1', 'h1', 'active')`)
      .run()
    seedPlanItem('pi-own', 'i-h1')
    // FK-legal but foreign: exactly the row a past/future write path could
    // store. Checking it off must not copy h2's item into h1's stock.
    seedPlanItem('pi-foreign', 'i-h2')
  })

  it('checks off an owned item and writes the purchase + stock', async () => {
    const res = await patchPlanItem(OWNER, 'pi-own', 'bought')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { item: { status: string; item_id: string } }
    expect(body.item.status).toBe('bought')
    expect(body.item.item_id).toBe('i-h1')
    expect(count('purchases', 'household_id = ?', 'h1')).toBe(1)
    expect(count('purchase_items', 'item_id = ?', 'i-h1')).toBe(1)
    expect(count('stock', 'household_id = ? AND item_id = ?', 'h1', 'i-h1')).toBe(1)
  })

  it('refuses to check off a plan item that points at a foreign item', async () => {
    const res = await patchPlanItem(OWNER, 'pi-foreign', 'bought')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Plan item not found' })
    // Pre-fix this answered 200 and wrote an h1 purchase line for h2's item.
    expect(count('purchases')).toBe(0)
    expect(count('purchase_items')).toBe(0)
    expect(count('stock')).toBe(0)
    const stillPending = sqlite
      .prepare('SELECT status FROM plan_items WHERE id = ?')
      .get('pi-foreign')
    expect(stillPending).toEqual({ status: 'pending' })
  })
})
