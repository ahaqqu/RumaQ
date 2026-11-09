import { describe, it, expect, beforeEach } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import { buildKey } from '../lib/receipts.js'
import { createDb } from './support/d1-sqlite.js'
import { createBrochuresStub } from './support/env.js'
import type { Env } from '../types.js'

// #525: POST /api/purchases accepted `receipt_image_key` as a client-supplied
// object key with no validation. GET /api/purchases/:id/receipt resolves the
// stored key through the storage adapter with no household re-check, so a key
// under another household's prefix (with a guessed uuid) would hand that
// household's receipt to the caller. The write path now demands buildKey's
// exact layout for the caller's own household.
//
// These run against REAL SQLite (node:sqlite — D1 is SQLite) through the real
// Hono route: the pinned property is "which rows exist afterwards and which
// key got stored", and every rejection must leave zero rows (the whole write
// is one batch behind the check). The legit case builds its key WITH the real
// buildKey helper — a validator that ever drifted from the builder would turn
// that test red instead of silently stranding legit uploads.
const OWNER = { userId: 'u1', householdId: 'h1' } as const
const OTHER = { userId: 'u2', householdId: 'h2' } as const

const { sqlite, d1 } = createDb()

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

function count(table: string, where = '1 = 1', ...params: unknown[]): number {
  const row = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .get(...params) as {
    n: number
  }
  return row.n
}

function storedReceiptKeys(): Array<string | null> {
  return sqlite
    .prepare('SELECT receipt_image_key FROM purchases')
    .all()
    .map((r) => {
      return r.receipt_image_key as string | null
    }) as Array<string | null>
}

function appEnv(identity: { userId: string; householdId: string }): Env {
  return { DB: d1, props: identity } as unknown as Env
}

async function postPurchase(
  identity: { userId: string; householdId: string },
  extra: Record<string, unknown> = {}
): Promise<Response> {
  return await apiApp.request(
    '/api/purchases',
    {
      method: 'POST',
      body: JSON.stringify({
        date: '2026-11-08',
        items: [{ name: 'Milk', qty: 1, unit: 'L', price: 1000 }],
        ...extra,
      }),
      headers: { 'Content-Type': 'application/json' },
    },
    appEnv(identity)
  )
}

beforeEach(() => {
  for (const table of [
    'purchases',
    'purchase_items',
    'stock',
    'items',
    'household_members',
    'households',
    'users',
  ]) {
    sqlite.exec(`DELETE FROM ${table}`)
  }
  seedHousehold('h1', 'u1')
  seedHousehold('h2', 'u2')
})

describe('POST /api/purchases — receipt_image_key must be buildKey output for the caller (#525)', () => {
  it('accepts a key the real buildKey produced for this household and stores it', async () => {
    const key = buildKey('h1', 'u1', 'jpg')
    const res = await postPurchase(OWNER, { receipt_image_key: key })

    expect(res.status).toBe(201)
    expect(storedReceiptKeys()).toEqual([key])
    expect(count('purchases')).toBe(1)
    expect(count('purchase_items')).toBe(1)
  })

  it('accepts the very same builder shape from its owning household (scope, not a hardcoded id)', async () => {
    const key = buildKey('h2', 'u2', 'png')
    const res = await postPurchase(OTHER, { receipt_image_key: key })

    expect(res.status).toBe(201)
    expect(storedReceiptKeys()).toEqual([key])
  })

  it('rejects a key under another household prefix with 400 and writes nothing', async () => {
    // A well-formed key — but for h2. Pre-fix this was stored verbatim in an
    // h1 purchase and GET /api/purchases/:id/receipt served h2's object.
    const foreignKey = buildKey('h2', 'u2', 'jpg')
    const res = await postPurchase(OWNER, { receipt_image_key: foreignKey })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid receipt image key' })
    expect(count('purchases')).toBe(0)
    expect(count('purchase_items')).toBe(0)
    expect(count('stock')).toBe(0)
    expect(count('items')).toBe(0)
  })

  it('rejects every malformed shape with the same uniform 400 and writes nothing', async () => {
    const uuid = 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
    const badKeys = [
      `receipts/../2026/11/${uuid}.jpg`, // household segment is `..`
      `receipts/h1/../../secret/${uuid}.jpg`, // traversal out of the prefix
      `/receipts/h1/2026/11/${uuid}.jpg`, // absolute path
      `receipts/h1/2026/11/extra/${uuid}.jpg`, // extra segment
      `other/h1/2026/11/${uuid}.jpg`, // wrong root
      `receipts/h1/2026/11/${uuid}.pdf`, // unsupported extension
      `receipts/h1/2026/11/${uuid}`, // no extension
      `receipts/h1/2026/11/not-a-uuid.jpg`, // not a uuid
      `receipts/h1/2026/13/${uuid}.jpg`, // month out of range
      `receipts/h1/2026/00/${uuid}.jpg`, // month out of range
      `receipts/h1/2026/${uuid}.jpg`, // missing month segment
      '', // empty
      'receipts/', // truncated
    ]

    for (const key of badKeys) {
      const res = await postPurchase(OWNER, { receipt_image_key: key })
      expect(res.status, `expected 400 for key ${JSON.stringify(key)}`).toBe(400)
      // No existence oracle: every invalid shape answers the identical body.
      expect(await res.json()).toEqual({ error: 'Invalid receipt image key' })
      expect(count('purchases'), `expected no row for key ${JSON.stringify(key)}`).toBe(0)
    }
  })

  it('keeps the omitted-key behavior unchanged (stored as null)', async () => {
    const res = await postPurchase(OWNER)

    expect(res.status).toBe(201)
    expect(storedReceiptKeys()).toEqual([null])
  })
})

describe('GET /api/purchases/:id/receipt — the read path re-checks the stored key (#548, R549-B1)', () => {
  function spyBucket() {
    const bucket = createBrochuresStub()
    const gets: string[] = []
    const innerGet = bucket.get.bind(bucket)
    bucket.get = async (key: string) => {
      gets.push(key)
      return innerGet(key)
    }
    return { bucket, gets }
  }

  function receiptEnv(bucket: ReturnType<typeof createBrochuresStub>): Env {
    return { DB: d1, RECEIPTS: bucket, props: OWNER } as unknown as Env
  }

  function seedPurchaseKey(id: string, householdId: string, key: string): void {
    sqlite
      .prepare(
        `INSERT INTO purchases (id, household_id, date, total, receipt_image_key)
         VALUES (?, ?, '2026-11-08', 1000, ?)`
      )
      .run(id, householdId, key)
  }

  it('refuses a pre-fix planted foreign key with 404 before touching storage', async () => {
    // A row planted before the #549 write-path validation: an h1 purchase
    // holding an h2-prefixed key. The household-scoped SELECT resolves the
    // row, so the key-shape re-check is the only thing between the caller and
    // h2's object.
    const { bucket, gets } = spyBucket()
    seedPurchaseKey('p-plant', 'h1', buildKey('h2', 'u2', 'jpg'))

    const res = await apiApp.request('/api/purchases/p-plant/receipt', {}, receiptEnv(bucket))

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Receipt not found' })
    // The uniform 404 came before any storage access — no oracle, no get.
    expect(gets).toEqual([])
  })

  it('still streams a legit own-household key (parity)', async () => {
    const key = buildKey('h1', 'u1', 'jpg')
    seedPurchaseKey('p-own', 'h1', key)
    const bucket = createBrochuresStub()
    await bucket.put(key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: 'image/jpeg' },
    })

    const res = await apiApp.request('/api/purchases/p-own/receipt', {}, receiptEnv(bucket))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
  })
})
