import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import { createDb } from './support/d1-sqlite.js'
import { encryptAiKey } from '../lib/crypto.js'
import type { Env } from '../types.js'

// #519: buildPlanPrompt listed only store LABELS while asking the model for a
// store_id — the model could only invent one, and POST /api/plans 400s on an
// unknown id, so AI store assignment was unreliable end to end (and #339 trip
// optimization would inherit it). The contract now:
//
//   prompt      — each store as `id — label`, from the route's household-scoped
//                 stores query;
//   AI boundary — the answer's store_id is checked against that same set:
//                 unknown → null (the nullable column's existing "no store");
//   save route  — unchanged strict 400 gate, household-scoped, now unreachable
//                 from the AI flow.
//
// These run against REAL SQLite (node:sqlite — D1 is SQLite) through the real
// Hono routes: the subject is "which store_id survives the chain", which a
// statement-matching mock cannot express. The provider is a mocked global
// fetch that records the wire, so the prompt text itself is asserted. No test
// here reaches a real AI endpoint.

const OWNER = { userId: 'u1', householdId: 'h1' } as const
const OTHER = { userId: 'u2', householdId: 'h2' } as const

const ENCRYPTION_KEY = 'test-encryption-key-32-bytes-long!!'

const OWN_STORE_A = '11111111-1111-4111-8111-111111111111'
const OWN_STORE_B = '22222222-2222-4222-8222-222222222222'
const FOREIGN_STORE = '33333333-3333-4333-8333-333333333333'
const RANDOM_UUID = '99999999-9999-4999-8999-999999999999'

const { sqlite, d1 } = createDb()
// D1 enforces foreign keys; node:sqlite defaults them OFF. The foreign store
// below EXISTS (it belongs to h2), so the save-route cases pin the household
// scope, not a constraint.
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

function seedStore(id: string, householdId: string, label: string): void {
  sqlite
    .prepare('INSERT INTO stores (id, household_id, label) VALUES (?, ?, ?)')
    .run(id, householdId, label)
}

async function seedReasoning(): Promise<void> {
  const encrypted = await encryptAiKey('sk-household', ENCRYPTION_KEY)
  sqlite
    .prepare(
      `INSERT INTO ai_providers
         (id, household_id, label, kind, preset, base_url, default_model, encrypted_key)
       VALUES ('p-1', 'h1', 'Home key', 'openai-compatible', 'openai', NULL, NULL, ?)`
    )
    .run(encrypted)
  sqlite
    .prepare(
      `INSERT INTO ai_capabilities (household_id, capability, provider_id, model)
       VALUES ('h1', 'reasoning', 'p-1', 'test-model')`
    )
    .run()
}

function appEnv(identity: { userId: string; householdId: string }): Env {
  return {
    DB: d1,
    WORKER_ENCRYPTION_KEY: ENCRYPTION_KEY,
    TEST_MODE: 'false',
    props: identity,
  } as unknown as Env
}

type RecordedCall = { url: string; body: Record<string, unknown> }
let calls: RecordedCall[] = []

function openAiAnswer(content: string): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    }),
    text: async () => '',
  } as unknown as Response
}

/** Install the provider mock; `items` is the model's whole answer. */
function providerAnswering(items: unknown[]): void {
  calls = []
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    return openAiAnswer(JSON.stringify({ items }))
  }) as unknown as typeof fetch
}

function userMessage(): string {
  const messages = calls[0].body.messages as Array<{ role: string; content: string }>
  return messages.find((m) => m.role === 'user')!.content
}

async function generatePlan(): Promise<{
  status: number
  items: Array<Record<string, unknown>>
}> {
  const res = await apiApp.request('/api/plans/generate', { method: 'POST' }, appEnv(OWNER))
  const body = res.status === 200 ? ((await res.json()) as { items: unknown[] }) : { items: [] }
  return { status: res.status, items: body.items as Array<Record<string, unknown>> }
}

async function savePlan(
  items: unknown[]
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await apiApp.request(
    '/api/plans',
    {
      method: 'POST',
      body: JSON.stringify({ items }),
      headers: { 'Content-Type': 'application/json' },
    },
    appEnv(OWNER)
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

function planItemRows(): Array<{ store_id: string | null; qty: number }> {
  return sqlite
    .prepare('SELECT store_id, qty FROM plan_items ORDER BY created_at, id')
    .all() as Array<{ store_id: string | null; qty: number }>
}

function count(table: string, where = '1 = 1', ...params: unknown[]): number {
  const row = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .get(...params) as {
    n: number
  }
  return row.n
}

beforeEach(async () => {
  calls = []
  globalThis.fetch = vi.fn()
  // Children first: the same order an FK-enforcing delete needs (D1 semantics).
  for (const table of [
    'ai_usage_events',
    'plan_items',
    'plans',
    'stock',
    'purchase_items',
    'purchases',
    'items',
    'stores',
    'ai_capabilities',
    'ai_providers',
    'user_settings',
    'household_members',
    'households',
    'users',
  ]) {
    sqlite.exec(`DELETE FROM ${table}`)
  }
  seedHousehold('h1', 'u1')
  seedHousehold('h2', 'u2')
  seedStore(OWN_STORE_A, 'h1', 'Indomaret')
  seedStore(OWN_STORE_B, 'h1', 'Pasar')
  seedStore(FOREIGN_STORE, 'h2', 'Superindo')
  await seedReasoning()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /api/plans/generate — the prompt carries store id+label pairs (#519)', () => {
  it('lists every household store as `id — label` and nothing foreign', async () => {
    providerAnswering([])
    const { status } = await generatePlan()

    expect(status).toBe(200)
    const prompt = userMessage()
    expect(prompt).toContain(`${OWN_STORE_A} — Indomaret`)
    expect(prompt).toContain(`${OWN_STORE_B} — Pasar`)
    expect(prompt).toContain('exactly one of the listed ids')
    // Another household's store is not prompt material — not its id, not its label.
    expect(prompt).not.toContain(FOREIGN_STORE)
    expect(prompt).not.toContain('Superindo')
  })

  it("keeps a valid store_id and falls back to null for a random UUID and another household's id alike", async () => {
    // One valid id, one hallucinated UUID, one id that exists but belongs to
    // h2: the valid set is the household's own stores query, so the last two
    // miss it identically — no existence oracle, same response shape.
    providerAnswering([
      { name: 'Susu', qty: 1, unit: 'L', store_id: OWN_STORE_B, price_estimate: 18000, why: 'low' },
      {
        name: 'Roti',
        qty: 2,
        unit: 'pack',
        store_id: RANDOM_UUID,
        price_estimate: 15000,
        why: 'low',
      },
      {
        name: 'Tahu',
        qty: 1,
        unit: 'pcs',
        store_id: FOREIGN_STORE,
        price_estimate: 5000,
        why: 'low',
      },
    ])
    const { status, items } = await generatePlan()

    expect(status).toBe(200)
    expect(items.map((it) => it.store_id)).toEqual([OWN_STORE_B, null, null])
    // The echoed label follows the validated id: resolved for the survivor,
    // null for both fallbacks (shape unchanged, no foreign label leaks).
    expect(items.map((it) => it.store_label)).toEqual(['Pasar', null, null])
  })

  it('hands the model no id it would then reject: the generate → save chain persists', async () => {
    // The end-to-end repro of the ticket: the model answers with one valid id
    // and one invented one; the client saves exactly what generate returned
    // (Plan.jsx passes the fields through verbatim). Pre-fix this 400ed on the
    // invented id and the whole plan was unsavable.
    providerAnswering([
      { name: 'Susu', qty: 1, unit: 'L', store_id: OWN_STORE_A, price_estimate: 18000, why: 'low' },
      {
        name: 'Roti',
        qty: 2,
        unit: 'pack',
        store_id: RANDOM_UUID,
        price_estimate: 15000,
        why: 'low',
      },
    ])
    const generated = await generatePlan()
    expect(generated.status).toBe(200)

    const saved = await savePlan(
      generated.items.map((it) => ({
        name: it.name,
        qty: it.qty,
        unit: it.unit,
        store_id: it.store_id,
        price_estimate: it.price_estimate,
        why: it.why,
        price_observation_id: it.price_observation_id,
      }))
    )

    expect(saved.status).toBe(201)
    // Order-insensitive (R552-A1): the save route stamps every line with ONE
    // shared `now`, so the rows' created_at ties and their random UUID ids
    // decide any ORDER BY — assert the multiset, never the sequence.
    const rows = planItemRows()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.store_id))).toEqual(new Set([OWN_STORE_A, null]))
  })
})

describe('POST /api/plans — the save gate stays strict and household-scoped (#519)', () => {
  it('persists a store_id that belongs to the household', async () => {
    const { status } = await savePlan([
      { name: 'Susu', qty: 1, unit: 'L', store_id: OWN_STORE_A, price_estimate: 18000, why: 'low' },
    ])
    expect(status).toBe(201)
    expect(planItemRows()).toEqual([{ store_id: OWN_STORE_A, qty: 1 }])
  })

  it('400s a random UUID store_id without creating any plan row', async () => {
    const { status, body } = await savePlan([
      { name: 'Susu', qty: 1, unit: 'L', store_id: RANDOM_UUID },
    ])
    expect(status).toBe(400)
    expect(body).toEqual({ error: `Store ${RANDOM_UUID} not found in this household` })
    expect(count('plans')).toBe(0)
    expect(count('plan_items')).toBe(0)
  })

  it("answers another household's store id with the SAME 400 shape — no existence oracle", async () => {
    // The foreign store EXISTS (h2's row); the response must not distinguish
    // "exists elsewhere" from "does not exist" — same status, same body shape.
    const { status, body } = await savePlan([
      { name: 'Susu', qty: 1, unit: 'L', store_id: FOREIGN_STORE },
    ])
    expect(status).toBe(400)
    expect(body).toEqual({ error: `Store ${FOREIGN_STORE} not found in this household` })
    expect(count('plans')).toBe(0)
  })

  it("is symmetric: h2's owner cannot save a line with h1's store id either", async () => {
    const res = await apiApp.request(
      '/api/plans',
      {
        method: 'POST',
        body: JSON.stringify({
          items: [{ name: 'Susu', qty: 1, unit: 'L', store_id: OWN_STORE_A }],
        }),
        headers: { 'Content-Type': 'application/json' },
      },
      appEnv(OTHER)
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: `Store ${OWN_STORE_A} not found in this household` })
  })

  it('saves a line with no store as a null store_id (the fallback the AI path lands on)', async () => {
    const { status } = await savePlan([{ name: 'Susu', qty: 1, unit: 'L' }])
    expect(status).toBe(201)
    expect(planItemRows()).toEqual([{ store_id: null, qty: 1 }])
  })

  it('saves a line whose price_estimate is an explicit null — the generate response carries one when the model omits the estimate (#519)', async () => {
    // Same client-echoes-null shape as store_id: generateAiPlan maps an
    // omitted estimate to null and Plan.jsx forwards it verbatim.
    const { status } = await savePlan([
      { name: 'Susu', qty: 1, unit: 'L', price_estimate: null, why: 'low' },
    ])
    expect(status).toBe(201)
    const rows = sqlite.prepare('SELECT store_id, price_estimate FROM plan_items').all() as Array<{
      store_id: string | null
      price_estimate: number | null
    }>
    expect(rows).toEqual([{ store_id: null, price_estimate: null }])
  })
})
