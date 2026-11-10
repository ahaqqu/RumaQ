import { describe, it, expect, beforeEach, vi } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import { createDb } from './support/d1-sqlite.js'
import { openAiChatAnswer } from './support/ai-door.js'
import { encryptAiKey } from '../lib/crypto.js'
import type { Env } from '../types.js'

// #548: #547 scoped the read paths the ticket enumerated, but the reviewer's
// sweep of every `items` join found 7 more leak-capable sites of the same
// class — a poisoned row (an h1 row whose item_id points at an h2 item,
// FK-legal) leaks the foreign name through:
//
//   POST /api/ai/chat — 4 prompt-input joins (a foreign name reaches the
//   model prompt), PATCH /api/stock/:id — the 200-response echo (+ the
//   existence read above it), and GET /api/purchases/patterns via
//   computePatterns [R547-A1].
//
// These run against REAL SQLite (node:sqlite — D1 is SQLite) through the real
// Hono route, mirroring read-path-item-scope.test.ts: the bug is a
// household-scope predicate in SQL, so the pinned property is "which rows
// resolve and who can see them", which a statement-matching mock cannot
// express. Pre-fix, every site below surfaces 'Foreign Coffee' — these tests
// fail there.
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

function names(rows: Array<Record<string, unknown>>): Array<string | null> {
  return rows.map((r) => (r.name ?? null) as string | null)
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
    'ai_usage_events',
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

describe('POST /api/ai/chat — the prompt inputs exclude foreign items (#548)', () => {
  // The 4 prompt-input reads run inside the non-TEST_MODE branch and feed
  // buildChatSystemPrompt, so the route-observable of "what the prompt would
  // contain" is the rows those reads returned. The capture wrapper records
  // exactly those rows while the queries still run against the real, poisoned
  // SQLite data — the same data buildChatSystemPrompt would render into the
  // prompt text. The provider transport is the mocked global fetch (ai-door
  // fixture — no suite may reach a real AI endpoint).
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
    // A purchase with one legit and one poisoned line, dated inside the route's
    // recent-purchases window (the last 30 household days, #560 — the seed
    // date is not this test's subject; it only makes the read return rows so
    // the join's scoping is exercised). The UTC today is never ahead of the
    // WIB household today, so it always lands inside the window.
    const today = new Date().toISOString().slice(0, 10)
    seedPurchase('p-h1', 'h1', today, [
      { id: 'pi-own', itemId: 'i-h1' },
      { id: 'pi-foreign', itemId: 'i-h2' },
    ])
    // The active plan the route reads, with one legit and one poisoned line.
    seedPlan('pl-h1', 'h1', 'active', [
      { id: 'pli-own', itemId: 'i-h1' },
      { id: 'pli-foreign', itemId: 'i-h2' },
    ])
    // The reasoning capability the route resolves before reading its inputs
    // (same seeding shape as read-path-item-scope.test.ts's generate test).
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

  it('reads only household items for low-stock, expiring, recent purchases and the active plan', async () => {
    await seedPromptInputs()
    globalThis.fetch = vi.fn().mockResolvedValue(openAiChatAnswer('Reply'))
    const captured: Captured[] = []
    // No TEST_MODE: the stub branch would skip all four reads. The mocked
    // fetch answers the provider call, so the route still returns 200.
    const env = {
      DB: withRowCapture(d1, captured),
      WORKER_ENCRYPTION_KEY: ENCRYPTION_KEY,
      props: OWNER,
    } as unknown as Env

    const res = await apiApp.request(
      '/api/ai/chat',
      {
        method: 'POST',
        body: JSON.stringify({ message: 'hi' }),
        headers: { 'Content-Type': 'application/json' },
      },
      env
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { reply: string }
    expect(body.reply).toBe('Reply')
    expect(JSON.stringify(body)).not.toContain('Foreign Coffee')

    // The four prompt-input reads, picked out of the captured rows by their
    // SQL shape (the route is the only caller in this test).
    const lowStock = captured.filter(
      (c) => c.sql.includes('FROM stock s') && c.sql.includes('run_out_days')
    )
    const expiring = captured.filter(
      (c) => c.sql.includes('FROM stock s') && !c.sql.includes('run_out_days')
    )
    const recentPurchases = captured.filter((c) => c.sql.includes('FROM purchase_items pi'))
    const activePlan = captured.filter((c) => c.sql.includes('FROM plan_items pi'))
    expect(lowStock).toHaveLength(1)
    expect(expiring).toHaveLength(1)
    expect(recentPurchases).toHaveLength(1)
    expect(activePlan).toHaveLength(1)

    // Pre-fix every one of these read both names; post-fix only the
    // household's own item resolves.
    expect(names(lowStock[0].rows)).toEqual(['Milk'])
    expect(names(expiring[0].rows)).toEqual(['Milk'])
    expect(names(recentPurchases[0].rows)).toEqual(['Milk'])
    expect(names(activePlan[0].rows)).toEqual(['Milk'])
  })
})

describe('PATCH /api/stock/:id — the echo never resolves a foreign name (#548)', () => {
  it('answers 404 for a poisoned stock row; the foreign name never echoes', async () => {
    // The poisoned row: h1 stock pointing at h2's item. FK-legal. The scoped
    // existence read no longer resolves it — 404, no partial update, no echo.
    seedStock('s-foreign', 'h1', 'i-h2', { qty: 1, runOutDays: 3 })

    const res = await apiApp.request(
      '/api/stock/s-foreign',
      {
        method: 'PATCH',
        body: JSON.stringify({ qty: 5 }),
        headers: { 'Content-Type': 'application/json' },
      },
      appEnv(OWNER)
    )

    expect(res.status).toBe(404)
    const body = (await res.json()) as unknown
    expect(body).toEqual({ error: 'Stock item not found' })
    expect(JSON.stringify(body)).not.toContain('Foreign Coffee')
    // Nothing was written behind the 404.
    const qty = sqlite.prepare('SELECT qty FROM stock WHERE id = ?').get('s-foreign') as {
      qty: number
    }
    expect(qty.qty).toBe(1)
  })

  it('still patches and echoes a household-owned row (legit-row parity)', async () => {
    seedStock('s-own', 'h1', 'i-h1', { qty: 2, runOutDays: 2 })

    const res = await apiApp.request(
      '/api/stock/s-own',
      {
        method: 'PATCH',
        body: JSON.stringify({ qty: 5 }),
        headers: { 'Content-Type': 'application/json' },
      },
      appEnv(OWNER)
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { stock: { name: string; qty: number } }
    expect(body.stock.name).toBe('Milk')
    expect(body.stock.qty).toBe(5)
  })
})

describe('GET /api/purchases/patterns — patterns never surface a foreign name (#548, R547-A1)', () => {
  it('renders the legit item only; the poisoned line de-references to Unknown', async () => {
    seedPurchase('p-h1', 'h1', '2026-11-01', [
      { id: 'pi-own', itemId: 'i-h1' },
      { id: 'pi-foreign', itemId: 'i-h2' },
    ])

    const res = await apiApp.request('/api/purchases/patterns', {}, appEnv(OWNER))

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      patterns: Array<{ item_id: string; name: string }>
    }
    expect(body.patterns.map((p) => p.name)).toContain('Milk')
    expect(JSON.stringify(body)).not.toContain('Foreign Coffee')

    // [R547-B1] The de-reference contract pinned: the poisoned line still
    // renders — as an 'Unknown' pattern, not dropped. A refactor that moves
    // the predicate from the ON clause into the WHERE clause (dropping the
    // line instead of de-referencing it) fails here.
    const poisoned = body.patterns.find((p) => p.item_id === 'i-h2')
    expect(poisoned).toBeDefined()
    expect(poisoned?.name).toBe('Unknown')
  })
})
