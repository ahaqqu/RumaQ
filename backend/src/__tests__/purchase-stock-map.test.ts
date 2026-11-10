import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import { createDb, migrationFiles } from './support/d1-sqlite.js'
import type { Env } from '../types.js'
// The 0046-parity fold test runs the actual migration SQL against a pre-0046
// schema (node:sqlite — D1 is SQLite). The backend tsconfig pins `types` to
// @cloudflare/workers-types, so Node builtin imports carry no declarations —
// the suppressions stay contained to this block.
// @ts-expect-error — no node types in this tsconfig
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error — no node types in this tsconfig
import { readFileSync } from 'node:fs'
// @ts-expect-error — no node types in this tsconfig
import { join, dirname } from 'node:path'
// @ts-expect-error — no node types in this tsconfig
import { fileURLToPath } from 'node:url'

// #551 — per-receipt stock semantics:
//
// (a) The purchase loop's per-line stock SELECT ran before the batch, so it
// could not see writes the same receipt had already queued: a multi-line
// receipt naming one item wrote duplicate stock rows (each line took the
// INSERT branch) or recomputed each UPDATE from the same stale base qty, where
// last-write-wins dropped every earlier line's quantity. The loop now keeps a
// stockByItemId map and folds the receipt's deltas into ONE write per item id.
//
// (d) The stock-rename lookup bind was trim()-only, diverging from the shared
// normalizeItemName (trim + lowercase + collapse inner whitespace) that both
// save paths resolve names by. Renaming to a spelling equal to an existing
// item only after collapsing inner whitespace forked a second items row
// instead of merging. Display names still keep raw inner whitespace (first
// spelling wins), so a stored 'Green  Tea' stays invisible to a later
// 'Green Tea' lookup — that fork class is pre-existing and out of scope here;
// (d) closes the lookup-key divergence only.
//
// (R588-1) With 0046's UNIQUE (household_id, item_id) in place, the rename's
// plain item_id re-point onto a DIFFERENT item that already holds its own
// stock row throws a raw UNIQUE-constraint 500 (pre-fix it silently
// duplicated). The route now folds into the occupied row with 0046's own
// merge rule; the fold tests below pin the route against the actual 0046 SQL.
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

function seedStockRow(
  id: string,
  householdId: string,
  itemId: string,
  fields: {
    qty: number
    unit?: string | null
    locationId?: string | null
    expiryDate?: string | null
    runOutDays?: number | null
    basis?: string | null
    updatedAt: string
  }
): void {
  sqlite
    .prepare(
      `INSERT INTO stock (id, household_id, item_id, location_id, qty, unit, expiry_date, run_out_days, basis, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      householdId,
      itemId,
      fields.locationId ?? null,
      fields.qty,
      fields.unit ?? null,
      fields.expiryDate ?? null,
      fields.runOutDays ?? null,
      fields.basis ?? null,
      fields.updatedAt
    )
}

function seedLocation(id: string, householdId: string, label: string): void {
  sqlite
    .prepare('INSERT INTO locations (id, household_id, label, sort_order) VALUES (?, ?, ?, 0)')
    .run(id, householdId, label)
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

async function patchStock(stockId: string, payload: Record<string, unknown>): Promise<Response> {
  return await apiApp.request(
    `/api/stock/${stockId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
    },
    appEnv(OWNER)
  )
}

async function patchStockName(stockId: string, name: string): Promise<Response> {
  return await patchStock(stockId, { name })
}

function stockRows(): Array<{
  id: string
  item_id: string
  qty: number
  unit: string | null
  location_id: string | null
  expiry_date: string | null
  updated_at: string
}> {
  return sqlite
    .prepare(
      'SELECT id, item_id, qty, unit, location_id, expiry_date, updated_at FROM stock ORDER BY item_id, id'
    )
    .all() as Array<{
    id: string
    item_id: string
    qty: number
    unit: string | null
    location_id: string | null
    expiry_date: string | null
    updated_at: string
  }>
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

// #607: a blank (whitespace-only) PATCH name used to be a silent 200 no-op —
// the handler skipped the rename and the tail UPDATE re-set item_id to its own
// value — while the OpenAPI contract declares 400 for an invalid body. Silent
// no-ops hide client bugs: the handler now rejects, in this route's error
// shape ({ error: string }, what the frontend surfaces).
describe('PATCH /api/stock/:id — blank name is invalid input, not a no-op (#607)', () => {
  it('answers 400 for a whitespace-only name and writes nothing', async () => {
    seedItem('i-old', 'h1', 'Tea Old')
    seedStock('s1', 'h1', 'i-old', 2)

    const res = await patchStockName('s1', '   ')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)

    // Nothing renamed, nothing forked, nothing touched: still exactly the
    // seeded rows.
    expect(itemNames()).toEqual(['Tea Old'])
    expect(count('items', 'household_id = ?', 'h1')).toBe(1)
    expect(count('stock')).toBe(1)
    expect(sqlite.prepare('SELECT item_id FROM stock WHERE id = ?').get('s1')).toMatchObject({
      item_id: 'i-old',
    })
  })

  it('answers 400 for an empty-string name', async () => {
    seedItem('i-old', 'h1', 'Tea Old')
    seedStock('s1', 'h1', 'i-old', 2)

    const res = await patchStockName('s1', '')
    expect(res.status).toBe(400)
    expect(count('items', 'household_id = ?', 'h1')).toBe(1)
  })

  it('a valid rename still works (regression pin)', async () => {
    seedItem('i-old', 'h1', 'Tea Old')
    seedStock('s1', 'h1', 'i-old', 2)

    const res = await patchStockName('s1', '  Green  Tea  ')
    expect(res.status).toBe(200)
    expect(itemNames().sort()).toEqual(['Green  Tea', 'Tea Old'])
    expect(count('items', 'household_id = ?', 'h1')).toBe(2)
  })
})

describe('PATCH /api/stock/:id — rename onto an occupied item folds (#551, R588-1)', () => {
  // With 0046's UNIQUE (household_id, item_id) live, the rename's plain
  // item_id re-point onto an item that already holds its own stock row threw
  // `UNIQUE constraint failed: stock.household_id, stock.item_id` — a raw 500
  // (reviewer-verified through this route). Pre-fix the same flow silently
  // duplicated the row, the exact class #551 closes. The route folds instead,
  // with the migration's own merge rule: quantities SUM, every other field
  // keeps the (updated_at, id)-max row's value unless the body sets it, and
  // the renamed entry's row is deleted — merging into the occupied row, one
  // batched transaction, household-scoped.
  //
  // One deliberate divergence from running 0046 itself: 0046 keeps the
  // survivor row's id, while the route always keeps the OCCUPIED row's id
  // (the merge-into-the-occupied-row gesture) — when the donor IS the
  // occupied row the ids agree, when the renamed row is the donor they
  // deliberately differ (pinned below).

  function seedFoldFixture(): void {
    seedLocation('loc-pantry', 'h1', 'Pantry')
    seedLocation('loc-fridge', 'h1', 'Fridge')
    seedItem('i-tea', 'h1', 'Black Tea')
    seedItem('i-old', 'h1', 'Tea Old')
    // The occupied (target) row is the latest-updated one — the donor.
    seedStockRow('s-tea', 'h1', 'i-tea', {
      qty: 3,
      unit: 'pack',
      locationId: 'loc-fridge',
      runOutDays: 7,
      basis: 'history',
      updatedAt: '2026-02-01 00:00:00',
    })
    seedStockRow('s-old', 'h1', 'i-old', {
      qty: 2,
      unit: 'box',
      locationId: 'loc-pantry',
      expiryDate: '2027-01-01',
      runOutDays: 14,
      basis: 'default',
      updatedAt: '2026-01-01 00:00:00',
    })
  }

  it('folds into the occupied row: quantities sum, the later-updated row keeps the other fields, the renamed row is deleted', async () => {
    seedFoldFixture()

    const res = await patchStockName('s-old', 'Black Tea')
    expect(res.status).toBe(200)

    const rows = stockRows()
    // Exactly one row remains: the OCCUPIED row, carrying the summed
    // quantity and the donor's (latest-updated) unit/location/expiry.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 's-tea',
      item_id: 'i-tea',
      qty: 5,
      unit: 'pack',
      location_id: 'loc-fridge',
      expiry_date: null,
    })
    // The requested stock id is gone — the renamed entry merged away.
    expect(count('stock', 'id = ?', 's-old')).toBe(0)
    // Both items rows survive (history still references them); only stock folded.
    expect(count('items', 'household_id = ?', 'h1')).toBe(2)

    // The response echoes the surviving row — the requested stock id no
    // longer exists.
    const body = (await res.json()) as { stock: { id: string; qty: number; name: string } }
    expect(body.stock.id).toBe('s-tea')
    expect(body.stock.qty).toBe(5)
    expect(body.stock.name).toBe('Black Tea')
  })

  it('breaks same-receipt ties on the larger id — the donor is deterministic when both rows share one updated_at', async () => {
    // Rows written by one receipt's batch share updated_at (second
    // granularity): the same-receipt collision shape. 0046's tie rule — the
    // lexically larger id donates the fields — and the occupied row still
    // survives even though the renamed row is the donor.
    seedLocation('loc-pantry', 'h1', 'Pantry')
    seedItem('i-tea', 'h1', 'Black Tea')
    seedItem('i-old', 'h1', 'Tea Old')
    seedStockRow('s-aaa', 'h1', 'i-tea', {
      qty: 3,
      unit: 'pack',
      locationId: 'loc-pantry',
      updatedAt: '2026-01-01 00:00:00',
    })
    seedStockRow('s-zzz', 'h1', 'i-old', {
      qty: 2,
      unit: 'box',
      locationId: 'loc-pantry',
      updatedAt: '2026-01-01 00:00:00',
    })

    const res = await patchStockName('s-zzz', 'Black Tea')
    expect(res.status).toBe(200)

    const rows = stockRows()
    expect(rows).toHaveLength(1)
    // Occupied row survives; the larger-id (donor) row's unit wins the tie.
    expect(rows[0]).toMatchObject({ id: 's-aaa', item_id: 'i-tea', qty: 5, unit: 'box' })
  })

  it('an explicit body.qty replaces the renamed entry\u2019s own contribution before summing', async () => {
    seedFoldFixture()

    const res = await patchStock('s-old', { name: 'Black Tea', qty: 5 })
    expect(res.status).toBe(200)

    const rows = stockRows()
    expect(rows).toHaveLength(1)
    // The renamed entry said 5, the occupied row held 3 — 8, not 7 or 5.
    expect(rows[0]).toMatchObject({ id: 's-tea', item_id: 'i-tea', qty: 8, unit: 'pack' })
  })

  it('produces what 0046 would fold for the same pair (migration parity)', async () => {
    seedFoldFixture()

    const res = await patchStockName('s-old', 'Black Tea')
    expect(res.status).toBe(200)
    const routeRows = stockRows()

    // Migration side: a pre-0046 schema carrying the SAME pair, the source
    // row re-pointed to the target item (what the rename's re-point would
    // write), then the actual 0046 SQL run on top.
    const db = new DatabaseSync(':memory:') as unknown as {
      exec(sql: string): void
      prepare(sql: string): {
        run(...params: unknown[]): unknown
        get(...params: unknown[]): Record<string, unknown> | undefined
        all(...params: unknown[]): Array<Record<string, unknown>>
      }
    }
    db.exec('PRAGMA foreign_keys = ON')
    for (const file of migrationFiles().filter((f) => f < '0046')) {
      db.exec(
        readFileSync(
          join(dirname(fileURLToPath(import.meta.url)), '../../migrations', file),
          'utf8'
        )
      )
    }
    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'u1@b.com')").run()
    db.prepare(
      "INSERT INTO households (id, name, created_by) VALUES ('h1', 'House h1', 'u1')"
    ).run()
    db.prepare(
      `INSERT INTO locations (id, household_id, label, sort_order)
       VALUES ('loc-pantry', 'h1', 'Pantry', 0), ('loc-fridge', 'h1', 'Fridge', 1)`
    ).run()
    db.prepare(
      "INSERT INTO items (id, household_id, name) VALUES ('i-tea', 'h1', 'Black Tea')"
    ).run()
    db.prepare("INSERT INTO items (id, household_id, name) VALUES ('i-old', 'h1', 'Tea Old')").run()
    db.prepare(
      `INSERT INTO stock (id, household_id, item_id, location_id, qty, unit, expiry_date, run_out_days, basis, updated_at)
       VALUES ('s-tea', 'h1', 'i-tea', 'loc-fridge', 3, 'pack', NULL, 7, 'history', '2026-02-01 00:00:00'),
              ('s-old', 'h1', 'i-old', 'loc-pantry', 2, 'box', '2027-01-01', 14, 'default', '2026-01-01 00:00:00')`
    ).run()
    db.prepare("UPDATE stock SET item_id = 'i-tea' WHERE id = 's-old'").run()
    db.exec(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          '../../migrations',
          '0046_stock_unique_household_item.sql'
        ),
        'utf8'
      )
    )
    const migrated = db.prepare('SELECT * FROM stock').all() as Array<Record<string, unknown>>

    expect(migrated).toHaveLength(1)
    // The migration-governed fields agree exactly with the route's fold —
    // including the surviving id, because the donor IS the occupied row in
    // this fixture. run_out_days/basis/updated_at are the route's own
    // recompute (the PATCH contract: qty changed, so run-out re-derives), not
    // 0046's preserve, and are intentionally not compared.
    expect(migrated[0]).toMatchObject({
      id: routeRows[0]?.id,
      household_id: 'h1',
      item_id: 'i-tea',
      qty: routeRows[0]?.qty,
      unit: routeRows[0]?.unit,
      location_id: routeRows[0]?.location_id,
      expiry_date: routeRows[0]?.expiry_date,
    })
    expect(migrated[0]).toMatchObject({
      id: 's-tea',
      qty: 5,
      unit: 'pack',
      location_id: 'loc-fridge',
    })
  })
})
