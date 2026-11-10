import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import { createDb } from './support/d1-sqlite.js'
import { recordAiUsageEvent } from '../lib/ai/usage.js'
import { encryptAiKey } from '../lib/crypto.js'
import { householdIsoDate } from '../lib/household-day.js'
import type { Env } from '../types.js'

// Route-level boundary pins for the household calendar (#554, #516 C6): every
// assertion runs with the clock pinned INSIDE the 00:00–07:00 WIB skew
// window, where the UTC calendar is still the household's yesterday — the
// exact window the old toISOString().slice(0, 10) stamps got wrong. Real
// SQLite through the real routes (the purchase-totals harness): "which day is
// written/read" is a statement fact a mock cannot express.

const OWNER = { userId: 'u1', householdId: 'h1' } as const
const ENCRYPTION_KEY = 'test-encryption-key-32-bytes-long!!'

const { sqlite, d1 } = createDb()
sqlite.exec('PRAGMA foreign_keys = ON')

function appEnv(extra: Record<string, unknown> = {}): Env {
  return {
    DB: d1,
    TEST_MODE: 'false',
    WORKER_ENCRYPTION_KEY: ENCRYPTION_KEY,
    props: OWNER,
    ...extra,
  } as unknown as Env
}

async function getHome(): Promise<Record<string, unknown>> {
  const res = await apiApp.request('/api/home', { method: 'GET' }, appEnv())
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, unknown>
}

async function patchPlanItemBought(planItemId: string): Promise<Response> {
  return await apiApp.request(
    `/api/plans/p1/items/${planItemId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status: 'bought' }),
      headers: { 'Content-Type': 'application/json' },
    },
    appEnv()
  )
}

function seedActivePlanItem(): void {
  sqlite.prepare(`INSERT INTO plans (id, household_id, status) VALUES ('p1', 'h1', 'active')`).run()
  sqlite.prepare(`INSERT INTO items (id, household_id, name) VALUES ('i-1', 'h1', 'Susu')`).run()
  sqlite
    .prepare(
      `INSERT INTO plan_items (id, plan_id, item_id, qty, unit, price_estimate, status)
       VALUES ('pi-1', 'p1', 'i-1', 1, 'L', 18500, 'pending')`
    )
    .run()
}

function seedPurchase(date: string, total: number): void {
  sqlite
    .prepare(
      `INSERT INTO purchases (id, household_id, store_id, date, total, created_at)
       VALUES (?, 'h1', NULL, ?, ?, '2026-10-01T03:00:00.000Z')`
    )
    .run(`pur-${date}-${total}`, date, total)
}

function seedStockExpiry(expiryDate: string): void {
  sqlite.prepare(`INSERT INTO items (id, household_id, name) VALUES ('i-exp', 'h1', 'Telur')`).run()
  sqlite
    .prepare(
      `INSERT INTO stock (id, household_id, item_id, qty, unit, run_out_days, basis, updated_at)
       VALUES ('st-1', 'h1', 'i-exp', 5, 'pcs', 999, 'default', '2026-10-01T03:00:00.000Z')`
    )
    .run()
  sqlite.prepare('UPDATE stock SET expiry_date = ? WHERE id = ?').run(expiryDate, 'st-1')
}

beforeEach(() => {
  for (const table of [
    'ai_usage_events',
    'plan_items',
    'plans',
    'purchase_items',
    'stock',
    'purchases',
    'items',
    'ai_capabilities',
    'ai_providers',
    'household_members',
    'households',
    'users',
  ]) {
    sqlite.exec(`DELETE FROM ${table}`)
  }
  sqlite.prepare(`INSERT INTO users (id, email) VALUES ('u1', 'u1@b.com')`).run()
  sqlite.prepare(`INSERT INTO households (id, name, created_by) VALUES ('h1', 'Home', 'u1')`).run()
  sqlite
    .prepare(
      `INSERT INTO household_members (id, household_id, user_id, role)
       VALUES ('m-1', 'h1', 'u1', 'owner')`
    )
    .run()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('plan check-off stamps the household day on the purchase (#554)', () => {
  it('a trip bought at 00:30 WIB is dated today, not the UTC yesterday', async () => {
    seedActivePlanItem()
    // 2026-11-07T17:30Z = 2026-11-08 00:30 WIB. UTC-day stamping would write
    // 2026-11-07; the household's calendar says 2026-11-08.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-07T17:30:00.000Z'))
    expect(householdIsoDate(new Date())).toBe('2026-11-08')

    const res = await patchPlanItemBought('pi-1')
    expect(res.status).toBe(200)
    expect(sqlite.prepare('SELECT date FROM purchases').get()).toEqual({ date: '2026-11-08' })
  })

  it('a trip bought at 23:30 WIB stays on that day (no over-roll)', async () => {
    seedActivePlanItem()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-07T16:30:00.000Z'))

    const res = await patchPlanItemBought('pi-1')
    expect(res.status).toBe(200)
    expect(sqlite.prepare('SELECT date FROM purchases').get()).toEqual({ date: '2026-11-07' })
  })
})

describe('/api/home windows cut on the household day (#554)', () => {
  it('the month-spend window follows the WIB month across the month edge', async () => {
    // Pinned 00:30 WIB on November 1 (2026-10-31T17:30Z): the household month
    // is 2026-11. A purchase dated 2026-11-01 counts; the one dated 2026-10-31
    // (the UTC month here) does not. The old UTC stamp read today as
    // 2026-10-31 and answered the wrong month.
    seedPurchase('2026-11-01', 10000)
    seedPurchase('2026-10-31', 5000)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-31T17:30:00.000Z'))

    const body = await getHome()
    expect(body.current_month_spend).toBe(10000)
    expect(body.current_month_receipts).toBe(1)
  })

  it('the 7-day expiry window starts at the household day', async () => {
    // Pinned 00:30 WIB on November 1: the window is [2026-11-01, 2026-11-08].
    // An item expiring 2026-11-08 is inside on the household calendar; the
    // UTC-cut window ([2026-10-31, 2026-11-07]) would have missed it.
    seedStockExpiry('2026-11-08')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-31T17:30:00.000Z'))

    const body = await getHome()
    expect(body.expiring_7d).toBe(1)
    expect(body.attention_count).toBe(1)
  })
})

describe('ai_usage_events day buckets follow the household day (#554)', () => {
  const call = {
    capability: 'reasoning',
    householdId: 'h1',
    providerKind: 'openai-compatible',
    providerId: 'p-1',
    model: 'test-model',
    funding: 'household',
  } as const

  it('the writer stamps the WIB day at 00:30 WIB', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-07T17:30:00.000Z'))

    await recordAiUsageEvent(
      { DB: d1 } as unknown as Env['Bindings'],
      { userId: 'u1', call, usage: { input_tokens: 10, output_tokens: 5, cached_tokens: null } },
      new Date()
    )
    expect(sqlite.prepare('SELECT date FROM ai_usage_events').get()).toEqual({ date: '2026-11-08' })
  })

  it('GET /api/ai/usage counts a 00:30 WIB call under the household today', async () => {
    // The event is written at 00:30 WIB Nov 8 (17:30Z Nov 7); the read pins
    // the same instant. Writer and reader must agree on the day — pre-#554
    // the writer stamped 2026-11-07 and the reader cut on 2026-11-07, but a
    // 00:30 WIB call landed in "yesterday" for the household.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-07T17:30:00.000Z'))

    await recordAiUsageEvent(
      { DB: d1 } as unknown as Env['Bindings'],
      { userId: 'u1', call, usage: { input_tokens: 10, output_tokens: 5, cached_tokens: null } },
      new Date()
    )

    const res = await apiApp.request('/api/ai/usage', { method: 'GET' }, appEnv())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { used: number }
    expect(body.used).toBe(1)
  })

  it("yesterday's WIB calls do not leak into the household's today", async () => {
    // Written at 23:30 WIB Nov 7 (16:30Z) → day 2026-11-07. Read at 00:30 WIB
    // Nov 8 (17:30Z) → today is 2026-11-08: the call is not in today's count.
    await recordAiUsageEvent(
      { DB: d1 } as unknown as Env['Bindings'],
      { userId: 'u1', call, usage: { input_tokens: 10, output_tokens: 5, cached_tokens: null } },
      new Date('2026-11-07T16:30:00.000Z')
    )
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-07T17:30:00.000Z'))

    const res = await apiApp.request('/api/ai/usage', { method: 'GET' }, appEnv())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { used: number }
    expect(body.used).toBe(0)
  })
})

describe('/api/purchases/scan dateGuess prefills the household day (#554)', () => {
  it('a scan at 00:30 WIB suggests today, not the UTC yesterday', async () => {
    // The scan route resolves the vision capability even in TEST_MODE — the
    // stub answer rides a configured household provider (same as production).
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
         VALUES ('h1', 'vision', 'p-1', 'test-model')`
      )
      .run()

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-07T17:30:00.000Z'))

    // TEST_MODE scan: the stub answer's date IS the dateGuess the review form
    // prefills — the purchase-date stamp source when the receipt shows none.
    // #606: the route byte-sniffs uploads, so the fixture carries real JPEG
    // leading bytes instead of ASCII that would be rejected as non-image.
    const jpegBytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    ])
    const file = new File([jpegBytes], 'receipt.jpg', { type: 'image/jpeg' })
    const formData = new FormData()
    formData.append('image', file)
    const res = await apiApp.request(
      '/api/purchases/scan',
      { method: 'POST', body: formData },
      appEnv({ TEST_MODE: 'true', RECEIPTS: { put: async () => ({}) } })
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { dateGuess: string | null }).dateGuess).toBe('2026-11-08')
  })
})
