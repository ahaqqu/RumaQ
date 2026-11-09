import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import { createDb } from './support/d1-sqlite.js'
import { encryptAiKey } from '../lib/crypto.js'
import type { Env } from '../types.js'

// #524: the write paths are household-scoped (#517/#522), but five READ paths
// still joined items without a household predicate. A pre-fix poisoned row
// (an h1 stock/purchase_items/plan_items row whose item_id points at an h2
// item — FK-legal, the item EXISTS) kept leaking the foreign name through:
//
//   GET /api/stock, GET /api/home (low_stock), GET /api/purchases list+detail,
//   GET /api/plans (this payload IS the plan detail — there is no separate
//   /api/plans/:id route), and the POST /api/plans/generate prompt inputs
//   (a foreign name would be fed to the AI plan prompt).
//
// These run against REAL SQLite (node:sqlite — D1 is SQLite) through the real
// Hono route: the bug is a household-scope predicate in SQL, so the pinned
// property is "which rows resolve and who can see them", which a
// statement-matching mock cannot express. Pre-fix, every route below echoes
// 'Foreign Coffee' — these tests fail there.
const OWNER = { userId: 'u1', householdId: 'h1' } as const

const ENCRYPTION_KEY = 'test-encryption-key-32-bytes-long!!'

const { sqlite, d1 } = createDb()
// D1 enforces foreign keys; node:sqlite defaults them OFF. The poisoned rows
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

function seedStock(
  id: string,
  householdId: string,
  itemId: string,
  opts: { qty?: number; runOutDays?: number; expiryDate?: string } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO stock (id, household_id, item_id, qty, run_out_days, expiry_date)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, householdId, itemId, opts.qty ?? 1, opts.runOutDays ?? null, opts.expiryDate ?? null)
}

function seedPurchase(
  id: string,
  householdId: string,
  date: string,
  lines: Array<{ id: string; itemId: string }>
): void {
  sqlite
    .prepare('INSERT INTO purchases (id, household_id, date, total) VALUES (?, ?, ?, 1000)')
    .run(id, householdId, date)
  for (const line of lines) {
    sqlite
      .prepare(
        `INSERT INTO purchase_items (id, purchase_id, item_id, qty)
         VALUES (?, ?, ?, 1)`
      )
      .run(line.id, id, line.itemId)
  }
}

function seedPlan(
  id: string,
  householdId: string,
  status: string,
  lines: Array<{ id: string; itemId: string }>
): void {
  sqlite
    .prepare(`INSERT INTO plans (id, household_id, status) VALUES (?, ?, ?)`)
    .run(id, householdId, status)
  for (const line of lines) {
    sqlite
      .prepare(
        `INSERT INTO plan_items (id, plan_id, item_id, qty, unit, status)
         VALUES (?, ?, ?, 1, 'pcs', 'pending')`
      )
      .run(line.id, id, line.itemId)
  }
}

function appEnv(identity: { userId: string; householdId: string }, db: D1Database = d1): Env {
  return { DB: db, props: identity } as unknown as Env
}

function names(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((r) => r.name as string)
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
    'ai_capabilities',
    'ai_providers',
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

describe('GET /api/stock — a poisoned stock row never resolves a foreign name (#524)', () => {
  it('lists the legit row only; the foreign item is invisible', async () => {
    seedStock('s-own', 'h1', 'i-h1', { qty: 2, runOutDays: 2 })
    // The poisoned row: h1 stock pointing at h2's item. FK-legal.
    seedStock('s-foreign', 'h1', 'i-h2', { qty: 1, runOutDays: 3 })

    const res = await apiApp.request('/api/stock', {}, appEnv(OWNER))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { stock: Array<{ id: string; name: string }> }
    expect(body.stock.map((s) => s.name)).toEqual(['Milk'])
    expect(JSON.stringify(body)).not.toContain('Foreign Coffee')
  })
})

describe('GET /api/home — low_stock never echoes a foreign name (#524)', () => {
  it('reports the legit row only; the foreign item is invisible', async () => {
    // Both rows qualify for low_stock (run_out_days <= 7), so pre-fix the
    // dashboard returned both names.
    seedStock('s-own', 'h1', 'i-h1', { qty: 2, runOutDays: 2 })
    seedStock('s-foreign', 'h1', 'i-h2', { qty: 1, runOutDays: 3 })

    const res = await apiApp.request('/api/home', {}, appEnv(OWNER))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { low_stock: Array<{ id: string; name: string }> }
    expect(body.low_stock.map((s) => s.name)).toEqual(['Milk'])
    expect(JSON.stringify(body)).not.toContain('Foreign Coffee')
  })
})

describe('GET /api/purchases — list never resolves a foreign name (#524)', () => {
  beforeEach(() => {
    seedPurchase('p-h1', 'h1', '2026-11-08', [
      { id: 'pi-own', itemId: 'i-h1' },
      { id: 'pi-foreign', itemId: 'i-h2' },
    ])
  })

  it('hydrates the legit line only; the foreign line de-references', async () => {
    const res = await apiApp.request('/api/purchases', {}, appEnv(OWNER))

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      purchases: Array<{ id: string; items: Array<{ item_id: string; name: string | null }> }>
    }
    expect(body.purchases).toHaveLength(1)
    const names = body.purchases[0].items.map((it) => it.name)
    expect(names).toContain('Milk')
    // The poisoned line still renders (purchase rows are household-owned) but
    // its foreign name is unrecoverable.
    expect(names).not.toContain('Foreign Coffee')
    expect(JSON.stringify(body)).not.toContain('Foreign Coffee')
  })

  it('matches the name search only against household items', async () => {
    const foreign = await apiApp.request('/api/purchases?q=Coffee', {}, appEnv(OWNER))
    expect(foreign.status).toBe(200)
    const foreignBody = (await foreign.json()) as {
      purchases: unknown[]
      month_totals: unknown[]
    }
    // Pre-fix the poisoned line's name matched and surfaced this purchase.
    expect(foreignBody.purchases).toEqual([])
    expect(foreignBody.month_totals).toEqual([])

    const own = await apiApp.request('/api/purchases?q=Milk', {}, appEnv(OWNER))
    expect(own.status).toBe(200)
    const ownBody = (await own.json()) as {
      purchases: Array<{ id: string; items: Array<{ name: string | null }> }>
    }
    expect(ownBody.purchases.map((p) => p.id)).toEqual(['p-h1'])
    expect(ownBody.purchases[0].items.map((it) => it.name)).toContain('Milk')
  })
})

describe('GET /api/purchases/:id — detail never resolves a foreign name (#524)', () => {
  it('returns the legit line only; the foreign line de-references', async () => {
    seedPurchase('p-h1', 'h1', '2026-11-08', [
      { id: 'pi-own', itemId: 'i-h1' },
      { id: 'pi-foreign', itemId: 'i-h2' },
    ])

    const res = await apiApp.request('/api/purchases/p-h1', {}, appEnv(OWNER))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ item_id: string; name: string | null }> }
    const names = body.items.map((it) => it.name)
    expect(names).toContain('Milk')
    expect(names).not.toContain('Foreign Coffee')
    expect(JSON.stringify(body)).not.toContain('Foreign Coffee')
  })
})

describe('GET /api/plans — the plan payload never resolves a foreign name (#524)', () => {
  it('hydrates the legit line only; the foreign line de-references', async () => {
    seedPlan('p1', 'h1', 'active', [
      { id: 'pi-own', itemId: 'i-h1' },
      { id: 'pi-foreign', itemId: 'i-h2' },
    ])

    const res = await apiApp.request('/api/plans', {}, appEnv(OWNER))

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      plans: Array<{ id: string; items: Array<{ item_id: string; item_name: string | null }> }>
    }
    expect(body.plans).toHaveLength(1)
    const names = body.plans[0].items.map((it) => it.item_name)
    expect(names).toContain('Milk')
    expect(names).not.toContain('Foreign Coffee')
    expect(JSON.stringify(body)).not.toContain('Foreign Coffee')
  })
})

describe('POST /api/plans/generate — the prompt inputs exclude foreign items (#524)', () => {
  // The prompt inputs are built inside the handler (low-stock, expiring,
  // recent purchases) and handed to generateAiPlan; in TEST_MODE the model is
  // stubbed, so the route-observable of "what the prompt would contain" is the
  // rows those three reads returned. The capture wrapper records exactly those
  // rows while the queries still run against the real, poisoned SQLite data —
  // the same data buildPlanPrompt would render into the prompt text.
  type Captured = { sql: string; rows: Array<Record<string, unknown>> }

  function withRowCapture(db: D1Database, captured: Captured[]): D1Database {
    const wrapped = {
      prepare: (sql: string) => {
        const inner = db.prepare(sql) as unknown as {
          bind: (...params: unknown[]) => {
            first: () => Promise<unknown>
            all: () => Promise<{ results: Array<Record<string, unknown>> }>
            run: () => Promise<unknown>
            batchResult: () => Promise<unknown>
          }
        }
        return {
          bind: (...params: unknown[]) => {
            const bound = inner.bind(...params)
            return {
              first: () => bound.first(),
              all: async () => {
                const res = await bound.all()
                captured.push({ sql, rows: res.results })
                return res
              },
              run: () => bound.run(),
              batchResult: () => bound.batchResult(),
            }
          },
        }
      },
      batch: (stmts: unknown[]) => (db.batch as (s: unknown[]) => Promise<unknown>)(stmts),
    }
    return wrapped as unknown as D1Database
  }

  async function seedPromptInputs(): Promise<void> {
    // One stock row per name, both qualifying for low-stock AND expiring, so
    // pre-fix BOTH input reads carried the foreign name.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    seedStock('s-own', 'h1', 'i-h1', { qty: 2, runOutDays: 2, expiryDate: tomorrow })
    seedStock('s-foreign', 'h1', 'i-h2', { qty: 1, runOutDays: 3, expiryDate: tomorrow })
    // A purchase in the last 30 days with one legit and one poisoned line.
    const boughtAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    seedPurchase('p-h1', 'h1', boughtAt, [
      { id: 'pi-own', itemId: 'i-h1' },
      { id: 'pi-foreign', itemId: 'i-h2' },
    ])
    // The reasoning capability the route resolves before reading its inputs
    // (same seeding shape as ai-access.test.ts).
    const encrypted = await encryptAiKey('sk-household', ENCRYPTION_KEY)
    sqlite
      .prepare(
        `INSERT INTO ai_providers
           (id, household_id, label, kind, preset, base_url, default_model, encrypted_key)
         VALUES ('p-1', 'h1', 'OpenAI', 'openai-compatible', 'openai', NULL, 'gpt-4o-mini', ?)`
      )
      .run(encrypted)
    sqlite
      .prepare(
        `INSERT INTO ai_capabilities (household_id, capability, provider_id, model, thinking_level)
         VALUES ('h1', 'reasoning', 'p-1', NULL, NULL)`
      )
      .run()
  }

  it('reads only household items for low-stock, expiring and recent purchases', async () => {
    await seedPromptInputs()
    const captured: Captured[] = []
    const env = {
      DB: withRowCapture(d1, captured),
      WORKER_ENCRYPTION_KEY: ENCRYPTION_KEY,
      TEST_MODE: 'true',
      props: OWNER,
    } as unknown as Env

    const res = await apiApp.request('/api/plans/generate', { method: 'POST' }, env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ name: string }> }
    // The TEST_MODE stub path ran (the route got past resolveAccess and its
    // input reads), and its answer carries no foreign name either.
    expect(body.items.length).toBeGreaterThan(0)
    expect(JSON.stringify(body)).not.toContain('Foreign Coffee')

    // The three prompt-input reads, picked out of the captured rows by their
    // SQL shape (the route is the only caller in this test).
    const lowStock = captured.filter(
      (c) => c.sql.includes('FROM stock s') && c.sql.includes('run_out_days')
    )
    const expiring = captured.filter(
      (c) => c.sql.includes('FROM stock s') && !c.sql.includes('run_out_days')
    )
    const recentPurchases = captured.filter((c) => c.sql.includes('FROM purchase_items pi'))
    expect(lowStock).toHaveLength(1)
    expect(expiring).toHaveLength(1)
    expect(recentPurchases).toHaveLength(1)

    // Pre-fix every one of these read both names; post-fix only the
    // household's own item resolves.
    expect(names(lowStock[0].rows)).toEqual(['Milk'])
    expect(names(expiring[0].rows)).toEqual(['Milk'])
    expect(names(recentPurchases[0].rows)).toEqual(['Milk'])
  })
})
