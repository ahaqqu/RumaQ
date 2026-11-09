import { describe, it, expect, vi } from 'vite-plus/test'
import { apiApp } from '../apps/api.js'
import { receiptsStorage } from '../lib/receipts.js'
import { PluginBindingMissingError } from '../ports/storage/missing.js'
import { createDocumentsStub } from './support/env.js'

// Receipt storage port pins (#503). The purchase routes' receipt IO rides the
// StorageAdapter port exactly like the vault's document IO — driven here by the
// SAME in-memory R2 stub the documents harness uses (support/env.ts) under the
// REAL R2 adapter (receiptsStorage builds createR2StorageAdapter from the
// stubbed binding), so the assertions cover what was actually stored and
// streamed, not mock call counts. The failover pins mirror
// plugin-registry.test.ts's missing-binding pins (V1-A1): the two port
// consumers — vault documents and receipts — must refuse identically, because
// the #442 adapter swap replaces the implementation under BOTH with zero
// route edits.
//
// The DB mock is the api-routes.test.ts idiom: the routes run a fixed prepare
// → bind → first/run chain per request. The capability row fixture mirrors its
// aiConfiguredRow (the scan route resolves `vision` through the AI door before
// TEST_MODE hands back the canned scan).

const ENCRYPTED_KEY = 'v1:KIPkC6p1Fvnv4KoVsu-dx-GNoEqmm2kStaExhNbptUJ3lrE'

// One fixture carries both halves (persona-settings + capability JOIN) the AI
// routes read through the mocked D1 — same shape as aiConfiguredRow.
const AI_ROW = {
  persona_enabled: 0,
  persona_user_role: null,
  persona_ai_role: null,
  capability: 'vision',
  model: null,
  thinking_level: null,
  provider_id: 'p-1',
  kind: 'openai-compatible',
  preset: 'openai',
  base_url: null,
  default_model: 'gpt-4o-mini',
  encrypted_key: ENCRYPTED_KEY,
}

function createEnv(overrides = {}) {
  const bucket = createDocumentsStub()
  const env = {
    DB: {
      prepare: vi.fn().mockReturnThis(),
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
      batch: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue(undefined),
    },
    RECEIPTS: bucket,
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    WORKER_JWT_SECRET: 'test-secret',
    WORKER_ENCRYPTION_KEY: 'test-encryption-key-32-bytes-long!!',
    PAGES_ORIGIN: 'http://localhost:5173',
    EMAIL_AUTH_ENABLED: 'false',
    ASSETS: undefined as unknown as Fetcher,
    props: { userId: 'u1', householdId: 'h1' },
    TEST_MODE: 'true',
    ...overrides,
  }
  return { env, bucket }
}

function scanRequest() {
  const file = new File(['x'], 'receipt.jpg', { type: 'image/jpeg' })
  const formData = new FormData()
  formData.append('image', file)
  return { method: 'POST', body: formData }
}

describe('receipts storage port (#503)', () => {
  it('scan stores the receipt through the port under the unchanged receipts/ key layout', async () => {
    const { env, bucket } = createEnv()
    env.DB.first = vi.fn().mockResolvedValue(AI_ROW)
    env.DB.run = vi.fn().mockResolvedValue(undefined)
    const res = await apiApp.request('/api/purchases/scan', scanRequest(), env)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { imageKey: string; imageUrl: string | null }
    // THE KEY-LAYOUT PIN: receipts/<household_id>/<yyyy>/<mm>/<uuid>.<ext>
    // (lib/receipts.ts buildKey), byte-for-byte the layout the raw
    // RECEIPTS-binding path wrote before the port. Routing IO through the
    // adapter moved no keys and no bytes — same physical bucket, same prefix.
    expect(body.imageKey).toMatch(
      /^receipts\/h1\/\d{4}\/(0[1-9]|1[0-2])\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/
    )
    // imageUrl stays null: the port forbids signed URLs for private objects
    // (ports/storage/index.ts — the receipt-proxy pattern), so getSignedUrl
    // keeps answering null exactly as before.
    expect(body.imageUrl).toBeNull()

    // The bytes + content type actually landed in storage under that exact key.
    const stored = bucket.objects.get(body.imageKey)
    expect(stored).toBeDefined()
    expect(stored?.httpMetadata?.contentType).toBe('image/jpeg')
    expect([...(stored?.bytes ?? [])]).toEqual([0x78])
  })

  it('GET streams the stored bytes back with the stored content type', async () => {
    const { env, bucket } = createEnv()
    const key = 'receipts/h1/2026/11/0aa6a5de-1234-4a44-9d44-aaaaaaaaaaaa.jpg'
    bucket.objects.set(key, {
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      httpMetadata: { contentType: 'image/jpeg' },
    })
    env.DB.first = vi.fn().mockResolvedValue({ receipt_image_key: key })
    const res = await apiApp.request('/api/purchases/p1/receipt', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    )
  })

  it('GET answers the same 404 when the row points at bytes storage does not have', async () => {
    const { env } = createEnv()
    env.DB.first = vi.fn().mockResolvedValue({
      receipt_image_key: 'receipts/h1/2026/11/gone.jpg',
    })
    const res = await apiApp.request('/api/purchases/p1/receipt', {}, env)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe(
      'Receipt image not found in storage'
    )
  })

  it('a rejected put answers the same 500 the route has always mapped storage failures to', async () => {
    const { env } = createEnv({
      RECEIPTS: { put: vi.fn().mockRejectedValue(new Error('bucket down')) },
    })
    env.DB.first = vi.fn().mockResolvedValue(AI_ROW)
    env.DB.run = vi.fn().mockResolvedValue(undefined)
    const res = await apiApp.request('/api/purchases/scan', scanRequest(), env)
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toBe('Failed to upload receipt image')
  })
})

describe('receipts missing-binding failover (vault port-contract parity, V1-A1)', () => {
  it('receiptsStorage over an unwired binding refuses from EVERY method with the typed error naming RECEIPTS', async () => {
    const { env } = createEnv({ RECEIPTS: undefined })
    const adapter = receiptsStorage(env as unknown as Parameters<typeof receiptsStorage>[0])
    for (const attempt of [
      () => adapter.put('receipts/h1/k.jpg', new Uint8Array([0x78]), 'image/jpeg'),
      () => adapter.get('receipts/h1/k.jpg'),
      () => adapter.delete('receipts/h1/k.jpg'),
    ]) {
      await expect(attempt()).rejects.toThrow(PluginBindingMissingError)
      await expect(attempt()).rejects.toThrow(/'RECEIPTS'/)
    }
  })

  it('the GET route still answers (500, typed refusal surfaced) under the missing-binding failover', async () => {
    // The vault's parity shape: a mis-wired deployment must never crash the
    // worker or fall over as an opaque TypeError — the refusal surfaces at the
    // first call that would have touched the binding, through the same
    // onError contract every api route answers with.
    const { env } = createEnv({ RECEIPTS: undefined })
    env.DB.first = vi.fn().mockResolvedValue({
      receipt_image_key: 'receipts/h1/2026/11/k.jpg',
    })
    const res = await apiApp.request('/api/purchases/p1/receipt', {}, env)
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toContain("'RECEIPTS'")
  })
})
