import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import { lineTotalOf, purchaseTotalOf } from '../lib/purchases.js'
import { createDb } from './support/d1-sqlite.js'
import { encryptAiKey } from '../lib/crypto.js'
import type { Env } from '../types.js'

// #518 — purchase price semantics (Option B, owner decisions 2026-11-10):
// purchase_items.price is the UNIT price (the receipt's per-piece HARGA);
// line_total is the line's payable amount — the printed line total when the
// receipt shows one, else the server-computed qty × price; purchases.total is
// ALWAYS server-computed at both INSERT paths (Q3), plan check-off stores
// estimate × qty (Q5), a no-estimate check-off writes NULL price/line_total —
// never the old `?? 0` (Q6) — and grounding no longer overwrites the estimate
// (Q5). Legacy rows are not backfilled (Q4): reads tolerate NULLs and never
// fabricate totals.
//
// These run against REAL SQLite (node:sqlite — D1 is SQLite) through the real
// Hono routes: the pinned property is "which numbers are written", which a
// statement-matching mock cannot express.

const OWNER = { userId: 'u1', householdId: 'h1' } as const
const ENCRYPTION_KEY = 'test-encryption-key-32-bytes-long!!'

const { sqlite, d1 } = createDb()
// D1 enforces foreign keys; node:sqlite defaults them OFF. Every seeded row
// below is FK-legal, so these tests pin semantics, not a constraint.
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

function appEnv(
  identity: { userId: string; householdId: string },
  extra: Record<string, unknown> = {}
): Env {
  return {
    DB: d1,
    WORKER_ENCRYPTION_KEY: ENCRYPTION_KEY,
    TEST_MODE: 'false',
    props: identity,
    ...extra,
  } as unknown as Env
}

async function postPurchase(
  items: unknown[],
  body: Record<string, unknown> = {}
): Promise<Response> {
  return await apiApp.request(
    '/api/purchases',
    {
      method: 'POST',
      body: JSON.stringify({ date: new Date().toISOString().slice(0, 10), items, ...body }),
      headers: { 'Content-Type': 'application/json' },
    },
    appEnv(OWNER)
  )
}

async function getHome(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await apiApp.request('/api/home', { method: 'GET' }, appEnv(OWNER))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function patchPlanItem(planItemId: string, status: 'bought' | 'skipped'): Promise<Response> {
  return await apiApp.request(
    `/api/plans/p1/items/${planItemId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status }),
      headers: { 'Content-Type': 'application/json' },
    },
    appEnv(OWNER)
  )
}

async function generatePlan(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await apiApp.request(
    '/api/plans/generate',
    { method: 'POST' },
    appEnv(OWNER, { TEST_MODE: 'true' })
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
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

async function listPlans(): Promise<{ plans: Array<Record<string, unknown>> }> {
  const res = await apiApp.request('/api/plans', { method: 'GET' }, appEnv(OWNER))
  return (await res.json()) as { plans: Array<Record<string, unknown>> }
}

function count(table: string, where = '1 = 1', ...params: unknown[]): number {
  const row = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .get(...params) as { n: number }
  return row.n
}

function one<T = Record<string, unknown>>(sql: string): T {
  return sqlite.prepare(sql).get() as T
}

beforeEach(async () => {
  // Children first: the same order an FK-enforcing delete needs (D1 semantics).
  for (const table of [
    'ai_usage_events',
    'plan_items',
    'plans',
    'purchase_items',
    'stock',
    'purchases',
    'items',
    'price_observations',
    'price_products',
    'price_sources',
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
})

describe('lib/purchases — the COALESCE definition (#518 Q1)', () => {
  it('lineTotalOf: the printed line total wins', () => {
    expect(lineTotalOf({ qty: 2, price: 20000, line_total: 30000 })).toBe(30000)
  })

  it('lineTotalOf: computes qty × unit price when nothing was printed', () => {
    expect(lineTotalOf({ qty: 10, price: 2800, line_total: null })).toBe(28000)
    expect(lineTotalOf({ qty: 0.5, price: 13000 })).toBe(6500)
  })

  it('lineTotalOf: a NULL price (no-estimate check-off) has no amount', () => {
    expect(lineTotalOf({ qty: 10, price: null })).toBeNull()
  })

  it('purchaseTotalOf: Σ COALESCE(line_total, price × qty), NULL lines skipped', () => {
    expect(
      purchaseTotalOf([
        { qty: 2, price: 20000, line_total: 30000 },
        { qty: 10, price: 2800 },
      ])
    ).toBe(58000)
    expect(purchaseTotalOf([{ qty: 1, price: null }])).toBeNull()
    expect(purchaseTotalOf([])).toBeNull()
  })
})

describe('POST /api/purchases — totals written, server-computed (#518 Q1/Q2/Q3)', () => {
  it('writes total = price × qty and persists the computed line_total', async () => {
    const res = await postPurchase([{ name: 'Telur', qty: 10, unit: 'pcs', price: 2800 }])

    expect(res.status).toBe(201)
    const body = (await res.json()) as { purchase: { total: number | null } }
    // The old code left this NULL — Home read "Rp 0 · 3 struk".
    expect(body.purchase.total).toBe(28000)
    expect(one<{ total: number }>('SELECT total FROM purchases').total).toBe(28000)
    expect(one<{ line_total: number }>('SELECT line_total FROM purchase_items').line_total).toBe(
      28000
    )
  })

  it('persists the printed line total verbatim and uses it over price × qty', async () => {
    // A discounted line: printed 30.000, unit price 20.000 × 2 would say 40.000.
    const res = await postPurchase([
      { name: 'Susu', qty: 2, unit: 'L', price: 20000, line_total: 30000 },
    ])

    expect(res.status).toBe(201)
    const body = (await res.json()) as { purchase: { total: number | null } }
    expect(body.purchase.total).toBe(30000)
    expect(one<{ line_total: number }>('SELECT line_total FROM purchase_items').line_total).toBe(
      30000
    )
  })

  it('sums a multi-item receipt: printed + computed lines', async () => {
    const res = await postPurchase([
      { name: 'Susu', qty: 2, unit: 'L', price: 20000, line_total: 30000 },
      { name: 'Telur', qty: 10, unit: 'pcs', price: 2800 },
      { name: 'Beras', qty: 0.5, unit: 'kg', price: 13000 },
    ])

    expect(res.status).toBe(201)
    const body = (await res.json()) as { purchase: { total: number | null } }
    // 30000 + 28000 + 6500
    expect(body.purchase.total).toBe(64500)
  })

  it('response items carry the line amounts', async () => {
    const res = await postPurchase([
      { name: 'Susu', qty: 2, unit: 'L', price: 20000, line_total: 30000 },
    ])
    const body = (await res.json()) as {
      items: Array<{ price: number; line_total: number | null }>
    }
    expect(body.items[0].price).toBe(20000)
    expect(body.items[0].line_total).toBe(30000)
  })

  it('the client cannot dictate the grand total — no such field in the strict schema', async () => {
    // purchaseCreateSchema is strictObject: a smuggled top-level total is a
    // 400, not a trusted write (Q3 — never client-trusted).
    const res = await postPurchase([{ name: 'Susu', qty: 1, unit: 'L', price: 20000 }], {
      total: 1,
    })
    expect(res.status).toBe(400)
    expect(count('purchases')).toBe(0)
  })
})

describe('GET /api/home — current_month_spend reads written totals', () => {
  it('is non-zero after a purchase insert and counts its receipt', async () => {
    await postPurchase([{ name: 'Telur', qty: 10, unit: 'pcs', price: 2800 }])
    const { status, body } = await getHome()

    expect(status).toBe(200)
    expect(body.current_month_spend).toBe(28000)
    expect(body.current_month_receipts).toBe(1)
  })
})

describe('PATCH plan check-off — estimate × qty and the NULL rule (#518 Q5/Q6)', () => {
  function seedPlanItem(id: string, opts: { qty: number; price_estimate: number | null }): void {
    sqlite
      .prepare(`INSERT INTO plans (id, household_id, status) VALUES ('p1', 'h1', 'active')`)
      .run()
    sqlite
      .prepare('INSERT INTO items (id, household_id, name) VALUES (?, ?, ?)')
      .run(`i-${id}`, 'h1', `Item ${id}`)
    sqlite
      .prepare(
        `INSERT INTO plan_items (id, plan_id, item_id, qty, unit, price_estimate, status)
         VALUES (?, 'p1', 'i-${id}', ?, 'pcs', ?, 'pending')`
      )
      .run(id, opts.qty, opts.price_estimate)
  }

  it('stores the estimate as unit price and estimate × qty as the line/total', async () => {
    seedPlanItem('pi-est', { qty: 10, price_estimate: 3500 })
    const res = await patchPlanItem('pi-est', 'bought')

    expect(res.status).toBe(200)
    const purchase = one<{ id: string; total: number | null }>('SELECT id, total FROM purchases')
    expect(purchase.total).toBe(35000)
    const line = one<{ price: number | null; line_total: number | null }>(
      'SELECT price, line_total FROM purchase_items'
    )
    expect(line.price).toBe(3500)
    expect(line.line_total).toBe(35000)
  })

  it('a no-estimate check-off writes NULL price, NULL line_total, NULL total — never 0', async () => {
    seedPlanItem('pi-noest', { qty: 10, price_estimate: null })
    const res = await patchPlanItem('pi-noest', 'bought')

    expect(res.status).toBe(200)
    expect(one<{ total: number | null }>('SELECT total FROM purchases').total).toBeNull()
    const line = one<{ price: number | null; line_total: number | null }>(
      'SELECT price, line_total FROM purchase_items'
    )
    expect(line.price).toBeNull()
    expect(line.line_total).toBeNull()
    // Home's SUM(total) skips the NULL — no fabricated 0-rupiah trip.
    const { body } = await getHome()
    expect(body.current_month_spend).toBe(0)
    expect(body.current_month_receipts).toBe(1)
  })

  it('fractional qty rounds to the integer currency unit', async () => {
    seedPlanItem('pi-frac', { qty: 1.5, price_estimate: 21000 })
    await patchPlanItem('pi-frac', 'bought')
    expect(one<{ total: number | null }>('SELECT total FROM purchases').total).toBe(31500)
  })

  it('skipping writes no purchase at all', async () => {
    seedPlanItem('pi-skip', { qty: 1, price_estimate: 5000 })
    await patchPlanItem('pi-skip', 'skipped')
    expect(count('purchases')).toBe(0)
    expect(count('purchase_items')).toBe(0)
  })
})

describe('plan draft — Σ estimate × qty, observation not summed (#518 Q5)', () => {
  beforeEach(seedReasoning)

  function seedGroundedSusu(): void {
    sqlite
      .prepare(`INSERT INTO price_sources (id, slug, name) VALUES ('ps-1', 'toko-uji', 'Toko Uji')`)
      .run()
    sqlite
      .prepare(
        `INSERT INTO price_products (id, product_key, name) VALUES ('pp-1', 'susu-cair-1l', 'Susu Cair 1L')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO price_observations
           (id, product_id, source_id, observed_date, price, effective_unit_price, match_confidence, scraped_at, valid_until)
         VALUES ('po-1', 'pp-1', 'ps-1', '2026-11-01', 20000, 18000, 1, '2026-11-01 00:00:00', '2026-11-30')`
      )
      .run()
  }

  it('draft totals multiply the estimate by qty (Telur ×10 @ 2800 = 28.000)', async () => {
    const { status, body } = await generatePlan()

    expect(status).toBe(200)
    // Stub: 18500×1 + 15000×1 + 2800×10 — the old code summed 18500+15000+2800.
    expect(body.total_estimate).toBe(61500)
  })

  it('the grounded observation rides its own field; the estimate is not overwritten', async () => {
    seedGroundedSusu()
    const { status, body } = await generatePlan()

    expect(status).toBe(200)
    const items = body.items as Array<Record<string, unknown>>
    const susu = items.find((it) => it.name === 'Susu cair 1L')
    expect(susu).toBeTruthy()
    // Both bases present, distinguishable…
    expect(susu?.price_estimate).toBe(18500)
    expect(susu?.price_grounded).toBe(18000)
    expect(susu?.price_source_name).toBe('Toko Uji')
    expect(susu?.price_observation_id).toBe('po-1')
    // …and the grand total still sums the ESTIMATE × qty, never the observation.
    expect(body.total_estimate).toBe(61500)
  })

  it('saving a plan persists Σ estimate × qty; the saved read carries both prices', async () => {
    const saved = await savePlan([
      { name: 'Telur', qty: 10, unit: 'pcs', store_id: null, price_estimate: 2800, why: '' },
      { name: 'Susu', qty: 2, unit: 'L', store_id: null, price_estimate: 18500, why: '' },
    ])
    expect(saved.status).toBe(201)
    // 2800×10 + 18500×2 — the old code stored 2800+18500.
    expect(one<{ total_estimate: number }>('SELECT total_estimate FROM plans').total_estimate).toBe(
      65000
    )

    // Saved plans keep estimate and observation distinguishable: the read join
    // derives price_grounded from the stored observation on the same effective
    // basis groundPlanItem returned.
    sqlite
      .prepare(`INSERT INTO price_sources (id, slug, name) VALUES ('ps-1', 'toko-uji', 'Toko Uji')`)
      .run()
    sqlite
      .prepare(
        `INSERT INTO price_products (id, product_key, name) VALUES ('pp-1', 'susu-cair-1l', 'Susu Cair 1L')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO price_observations
           (id, product_id, source_id, observed_date, price, effective_unit_price, match_confidence, scraped_at, valid_until)
         VALUES ('po-1', 'pp-1', 'ps-1', '2026-11-01', 20000, 18000, 1, '2026-11-01 00:00:00', '2026-11-30')`
      )
      .run()
    sqlite
      .prepare(
        `UPDATE plan_items SET price_observation_id = 'po-1'
         WHERE item_id IN (SELECT id FROM items WHERE name = 'Susu')`
      )
      .run()

    const plans = await listPlans()
    const plan = plans.plans[0]
    const items = plan.items as Array<Record<string, unknown>>
    const susu = items.find((it) => it.item_name === 'Susu')
    expect(susu?.price_estimate).toBe(18500)
    expect(susu?.price_grounded).toBe(18000)
  })
})

describe('no backfill — legacy-shaped rows stay as written (#518 Q4)', () => {
  it('legacy rows keep NULL totals/line_totals and are not rewritten by reads or new writes', async () => {
    // A pre-fix row: ambiguous price meaning, total born NULL, no line_total.
    sqlite
      .prepare(
        `INSERT INTO purchases (id, household_id, store_id, date, total, created_at)
         VALUES ('p-legacy', 'h1', NULL, '2026-11-01', NULL, datetime('now'))`
      )
      .run()
    sqlite
      .prepare(`INSERT INTO items (id, household_id, name) VALUES ('i-legacy', 'h1', 'Legacy')`)
      .run()
    sqlite
      .prepare(
        `INSERT INTO purchase_items (id, purchase_id, item_id, qty, unit, price, created_at)
         VALUES ('pi-legacy', 'p-legacy', 'i-legacy', 12, 'pcs', 36000, datetime('now'))`
      )
      .run()

    // The list read surfaces the NULLs verbatim…
    const listRes = await apiApp.request('/api/purchases', { method: 'GET' }, appEnv(OWNER))
    const list = (await listRes.json()) as {
      purchases: Array<{ total: number | null; items: Array<{ line_total: number | null }> }>
    }
    expect(list.purchases[0].total).toBeNull()
    expect(list.purchases[0].items[0].line_total).toBeNull()

    // …and Home's month spend does not fabricate a total from the row.
    const { body } = await getHome()
    expect(body.current_month_spend).toBe(0)
    expect(body.current_month_receipts).toBe(1)

    // A new purchase computes and writes ONLY its own row.
    await postPurchase([{ name: 'Telur', qty: 10, unit: 'pcs', price: 2800 }])
    expect(
      one<{ total: number | null }>("SELECT total FROM purchases WHERE id = 'p-legacy'").total
    ).toBeNull()
    expect(
      one<{ line_total: number | null }>(
        "SELECT line_total FROM purchase_items WHERE id = 'pi-legacy'"
      ).line_total
    ).toBeNull()
    expect(
      one<{ total: number }>('SELECT total FROM purchases WHERE total IS NOT NULL').total
    ).toBe(28000)
  })
})
