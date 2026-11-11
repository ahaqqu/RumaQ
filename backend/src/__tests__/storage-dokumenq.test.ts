import { describe, it, expect, vi, afterEach } from 'vite-plus/test'
import {
  createDokumenQStorageAdapter,
  docIdForKey,
  DokumenQStorageError,
  DokumenQUnauthorizedError,
  DokumenQRateLimitedError,
  DokumenQDigestMismatchError,
} from '../ports/storage/dokumenq.js'
import { selectStorageAdapter, DokumenQConfigError } from '../ports/storage/select.js'
import { StorageBindingMissingError } from '../ports/storage/missing.js'
import { createDocumentsStub } from './support/env.js'
import type { StorageAdapter } from '../ports/storage/index.js'
import type { Env } from '../types.js'

// DokumenQ Mode A adapter pins (ahaqqu/RumaQ#442 — plugin architecture T8).
// The wire contract lives in ahaqqu/DokumenQ docs/API.md: the adapter is the
// app-token client for authorize (§4.1), the signed byte path (§3.1/§3.3)
// and the documents CRUD (§4.5) — the fake below routes on exactly those
// shapes, so every assertion here is a protocol pin, not a mock call count:
// the bearer header, the authorize intent fields, the deterministic key →
// doc_id map, the 409 digest reconciliation, and the 401/429/5xx mappings.
// Synthetic bytes only — no real documents, no real PII, no secrets (the
// "secret" below is a test literal).

const BASE = 'https://dokumenq.test'
const SECRET = 'dq-test-secret-literal'
const KEY = 'documents/hh1/doc1/file1'
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]) // %PDF

type Call = { url: string; init: RequestInit }

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** The signed-URL shape the fake service mints (API.md §1.2 — the adapter
 *  never parses it, it only fetches it verbatim; the path carries the
 *  doc_id so the byte endpoints can route). */
function mintedUrl(docId: string, method: 'get' | 'put'): string {
  return `${BASE}/v1/o/${docId}?k=kid&m=${method}&e=1700000000&a=app&u=tag&d=attachment&mac=fake`
}

function docIdFromUrl(url: string): string {
  return new URL(url).pathname.split('/').pop()!
}

// One fake service for the whole file: authorize mints for a `store` the
// byte endpoints read/write. `authStatus`/`authBody` model a credential-level
// answer (401/429/500) applied to EVERY authenticated endpoint — a revoked
// secret fails authorize AND the documents CRUD alike, which is exactly the
// service's contract (the bearer gate runs before any document lookup).
function fakeDokumenQ(
  options: {
    store?: Map<string, { bytes: Uint8Array; contentType: string }>
    authStatus?: number
    authBody?: unknown
    uploadStatus?: number
    uploadBody?: unknown
  } = {}
): { calls: Call[]; fetch: typeof fetch } {
  const store = options.store ?? new Map()
  const calls: Call[] = []
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const url = String(input)
      calls.push({ url, init })
      if (options.authStatus && url !== `${BASE}/v1/healthz`) {
        return jsonRes(options.authStatus, options.authBody)
      }
      if (url === `${BASE}/v1/authorize`) {
        const body = JSON.parse(String(init.body)) as { method: string; doc_id: string }
        return jsonRes(200, {
          url: mintedUrl(body.doc_id, body.method === 'put' ? 'put' : 'get'),
          doc_id: body.doc_id,
          expires_at: 1700000000,
          node: 'n1',
        })
      }
      if (url.startsWith(`${BASE}/v1/o/`)) {
        const docId = docIdFromUrl(url)
        if (init.method === 'PUT') {
          if (options.uploadStatus) {
            return jsonRes(options.uploadStatus, options.uploadBody)
          }
          const bytes = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())
          store.set(docId, {
            bytes,
            contentType: (init.headers as Record<string, string>)['content-type']!,
          })
          return jsonRes(201, { doc_id: docId, sha256: 'aa', size: bytes.byteLength, mime: 'x' })
        }
        const held = store.get(docId)
        if (!held)
          return jsonRes(404, { error: { code: 'not_found', message: 'document not found' } })
        return new Response(held.bytes as BodyInit, {
          status: 200,
          headers: {
            'content-type': held.contentType,
            'content-length': String(held.bytes.byteLength),
          },
        })
      }
      if (url.startsWith(`${BASE}/v1/documents/`)) {
        const docId = docIdFromUrl(url)
        return store.has(docId)
          ? jsonRes(200, { id: docId, deleted_at: 1 })
          : jsonRes(404, { error: { code: 'not_found', message: 'document not found' } })
      }
      throw new Error(`fake DokumenQ saw an unexpected URL: ${url}`)
    }
  ) as unknown as typeof fetch
  return { calls, fetch: fetchMock }
}

function adapterWith(fake: { fetch: typeof fetch }): StorageAdapter {
  return createDokumenQStorageAdapter({
    baseUrl: BASE,
    appSecret: SECRET,
    fetch: fake.fetch,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('docIdForKey — the deterministic key → doc_id map (#442)', () => {
  it('is a pure function of the key: stable across calls, distinct per key', async () => {
    const first = await docIdForKey(KEY)
    expect(await docIdForKey(KEY)).toBe(first)
    expect(await docIdForKey('documents/hh1/doc1/file2')).not.toBe(first)
    expect(await docIdForKey('receipts/hh1/2026/11/x.jpg')).not.toBe(first)
  })

  it('answers a valid RFC 4122 UUID (v4-shaped) so DokumenQ accepts it as doc_id', async () => {
    const id = await docIdForKey(KEY)
    // 36-char lowercase hyphenated; version nibble '4'; variant nibble 8/9/a/b.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('DokumenQStorageAdapter put — authorize + signed byte transfer (Mode A)', () => {
  it('authorizes a put intent with the bearer secret and uploads the exact bytes to the minted URL', async () => {
    const fake = fakeDokumenQ()
    const adapter = adapterWith(fake)
    await expect(adapter.put(KEY, PDF_BYTES, 'application/pdf')).resolves.toBeUndefined()

    // The authorize call: bearer app token, JSON intent (API.md §4.1).
    const authorize = fake.calls[0]!
    expect(authorize.url).toBe(`${BASE}/v1/authorize`)
    expect((authorize.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${SECRET}`
    )
    const intent = JSON.parse(String(authorize.init.body)) as Record<string, unknown>
    expect(intent['method']).toBe('put')
    expect(intent['doc_id']).toBe(await docIdForKey(KEY))
    expect(intent['size']).toBe(PDF_BYTES.byteLength)
    expect(intent['mime']).toBe('application/pdf')
    expect(intent['subject']).toBe(KEY)
    expect(typeof intent['sha256']).toBe('string')
    expect(intent['collection']).toBe('rumaq')

    // The byte call hits the MINTED url with the declared content type.
    const upload = fake.calls[1]!
    expect(upload.url.startsWith(`${BASE}/v1/o/${intent['doc_id'] as string}?`)).toBe(true)
    expect(upload.init.method).toBe('PUT')
    expect((upload.init.headers as Record<string, string>)['content-type']).toBe('application/pdf')
    expect(new Uint8Array(await new Response(upload.init.body as BodyInit).arrayBuffer())).toEqual(
      PDF_BYTES
    )
  })

  it('reconciles a replayed upload: 409 with a MATCHING stored digest resolves, not throws', async () => {
    // Create-only byte path (API.md §3.3): a retried put that lost its 201
    // re-derives the same doc_id and reads the stored digest from the 409
    // payload — match = already synced (DESIGN §9.1.9).
    const digest = await import('../lib/crypto.js').then((m) => m.sha256HexBytes(PDF_BYTES))
    const fake = fakeDokumenQ({
      uploadStatus: 409,
      uploadBody: {
        error: {
          code: 'document_exists',
          message: 'document already exists',
          existing: {
            doc_id: 'x',
            size: PDF_BYTES.byteLength,
            sha256: digest,
            mime: 'application/pdf',
          },
        },
      },
    })
    const adapter = adapterWith(fake)
    await expect(adapter.put(KEY, PDF_BYTES, 'application/pdf')).resolves.toBeUndefined()
  })

  it('refuses a 409 whose stored digest does NOT match — same key, different bytes', async () => {
    const fake = fakeDokumenQ({
      uploadStatus: 409,
      uploadBody: {
        error: {
          code: 'document_exists',
          message: 'document already exists',
          existing: { doc_id: 'x', size: 4, sha256: 'deadbeef', mime: 'application/pdf' },
        },
      },
    })
    const adapter = adapterWith(fake)
    await expect(adapter.put(KEY, PDF_BYTES, 'application/pdf')).rejects.toThrow(
      DokumenQDigestMismatchError
    )
    await expect(adapter.put(KEY, PDF_BYTES, 'application/pdf')).rejects.toThrow(/different bytes/)
  })

  it('bridges a mime outside DokumenQ §5.3 allowlist (image/heic) onto the octet-stream passthrough', async () => {
    const fake = fakeDokumenQ()
    const adapter = adapterWith(fake)
    await expect(
      adapter.put('receipts/hh1/2026/11/x.jpg', PDF_BYTES, 'image/heic')
    ).resolves.toBeUndefined()
    const intent = JSON.parse(String(fake.calls[0]!.init.body)) as Record<string, unknown>
    expect(intent['mime']).toBe('application/octet-stream')
    expect((fake.calls[1]!.init.headers as Record<string, string>)['content-type']).toBe(
      'application/octet-stream'
    )
  })

  it('falls back to a sha256 subject when the key exceeds the 128-byte subject cap', async () => {
    const fake = fakeDokumenQ()
    const adapter = adapterWith(fake)
    const longKey = `documents/${'h'.repeat(140)}`
    await expect(adapter.put(longKey, PDF_BYTES, 'application/pdf')).resolves.toBeUndefined()
    const intent = JSON.parse(String(fake.calls[0]!.init.body)) as Record<string, unknown>
    expect(intent['subject']).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('DokumenQStorageAdapter get — minted signed GET streamed back', () => {
  it('authorizes a get intent and returns the stored bytes with the stored content type', async () => {
    const store = new Map([
      [await docIdForKey(KEY), { bytes: PDF_BYTES, contentType: 'application/pdf' }],
    ])
    const fake = fakeDokumenQ({ store })
    const adapter = adapterWith(fake)
    const stored = await adapter.get(KEY)
    expect(stored).not.toBeNull()
    expect(stored!.contentType).toBe('application/pdf')
    expect(stored!.size).toBe(PDF_BYTES.byteLength)
    expect(new Uint8Array(await new Response(stored!.stream as BodyInit).arrayBuffer())).toEqual(
      PDF_BYTES
    )

    const intent = JSON.parse(String(fake.calls[0]!.init.body)) as Record<string, unknown>
    expect(intent['method']).toBe('get')
    expect(intent['doc_id']).toBe(await docIdForKey(KEY))
    expect(intent['subject']).toBe(KEY)
    expect((fake.calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${SECRET}`
    )
  })

  it('answers null on the uniform 404 from authorize (unknown key = port not-found)', async () => {
    const fake = fakeDokumenQ({
      authStatus: 404,
      authBody: { error: { code: 'not_found', message: 'document not found' } },
    })
    const adapter = adapterWith(fake)
    await expect(adapter.get(KEY)).resolves.toBeNull()
  })

  it('answers null when the signed GET itself 404s (raced a delete after minting)', async () => {
    const fake = fakeDokumenQ() // empty store → byte endpoint 404s
    const adapter = adapterWith(fake)
    await expect(adapter.get(KEY)).resolves.toBeNull()
    expect(fake.calls).toHaveLength(2) // authorize + byte fetch both happened
  })
})

describe('DokumenQStorageAdapter delete — idempotent, R2-parity', () => {
  it('deletes through the app-token CRUD endpoint', async () => {
    const store = new Map([
      [await docIdForKey(KEY), { bytes: PDF_BYTES, contentType: 'application/pdf' }],
    ])
    const fake = fakeDokumenQ({ store })
    const adapter = adapterWith(fake)
    await expect(adapter.delete(KEY)).resolves.toBeUndefined()
    expect(fake.calls[0]!.url).toBe(`${BASE}/v1/documents/${await docIdForKey(KEY)}`)
    expect(fake.calls[0]!.init.method).toBe('DELETE')
  })

  it('answers ok on the uniform 404 — deleting an absent key succeeds (r2.ts parity)', async () => {
    const fake = fakeDokumenQ()
    const adapter = adapterWith(fake)
    await expect(adapter.delete(KEY)).resolves.toBeUndefined()
  })
})

describe('DokumenQ error mapping (401 / 429 / 5xx / network)', () => {
  it('maps a 401 to the typed credential error — a wrong/revoked DOKUMENQ_APP_SECRET', async () => {
    // The credential gate runs before ANY document lookup on every endpoint
    // (API.md §1.1/§4), so one auth answer covers authorize, the byte path
    // and the CRUD delete.
    const fake = fakeDokumenQ({
      authStatus: 401,
      authBody: { error: { code: 'unauthorized', message: 'invalid token' } },
    })
    const adapter = adapterWith(fake)
    await expect(adapter.put(KEY, PDF_BYTES, 'application/pdf')).rejects.toThrow(
      DokumenQUnauthorizedError
    )
    await expect(adapter.get(KEY)).rejects.toThrow(DokumenQUnauthorizedError)
    await expect(adapter.delete(KEY)).rejects.toThrow(DokumenQUnauthorizedError)
  })

  it('maps a 429 to the rate-limit error and carries Retry-After (plain-string limiter body)', async () => {
    // The limiter answers `{"error":"rate limit exceeded"}` with Retry-After
    // (API.md §6) — NOT the typed envelope. The parser must take both.
    const adapter = createDokumenQStorageAdapter({
      baseUrl: BASE,
      appSecret: SECRET,
      fetch: (async () =>
        jsonRes(429, { error: 'rate limit exceeded' }, { 'Retry-After': '7' })) as typeof fetch,
    })
    const attempt = () => adapter.get(KEY)
    await expect(attempt()).rejects.toThrow(DokumenQRateLimitedError)
    await expect(attempt()).rejects.toThrow(/rate limit exceeded/)
    try {
      await attempt()
      expect.unreachable('429 must reject')
    } catch (err) {
      expect(err).toBeInstanceOf(DokumenQRateLimitedError)
      expect((err as DokumenQRateLimitedError).retryAfterSeconds).toBe(7)
    }
  })

  it('maps a 500 (typed envelope) to DokumenQStorageError with the service status and code', async () => {
    const fake = fakeDokumenQ({
      authStatus: 500,
      authBody: { error: { code: 'internal_error', message: 'boom' } },
    })
    const adapter = adapterWith(fake)
    try {
      await adapter.get(KEY)
      expect.unreachable('500 must reject')
    } catch (err) {
      expect(err).toBeInstanceOf(DokumenQStorageError)
      expect((err as DokumenQStorageError).status).toBe(500)
      expect((err as DokumenQStorageError).code).toBe('internal_error')
    }
  })

  it('maps a transport failure (fetch throws) to a network DokumenQStorageError', async () => {
    const adapter = createDokumenQStorageAdapter({
      baseUrl: BASE,
      appSecret: SECRET,
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch,
    })
    try {
      await adapter.delete(KEY)
      expect.unreachable('network failure must reject')
    } catch (err) {
      expect(err).toBeInstanceOf(DokumenQStorageError)
      expect((err as DokumenQStorageError).status).toBe(0)
      expect((err as DokumenQStorageError).code).toBe('network')
    }
  })
})

// The cutover selector (#442): one decision for BOTH composition sites.
describe('selectStorageAdapter — the R2 → DokumenQ cutover', () => {
  function envWith(
    vars: { baseUrl?: string; appSecret?: string },
    binding?: ReturnType<typeof createDocumentsStub>
  ): Env['Bindings'] {
    return {
      DOKUMENQ_BASE_URL: vars.baseUrl,
      DOKUMENQ_APP_SECRET: vars.appSecret,
      DOCUMENTS: binding,
    } as unknown as Env['Bindings']
  }

  it('cuts over to the DokumenQ adapter only when the app secret exists (the deliberate act)', async () => {
    // Stub the global fetch: the selector-built adapter has no injected
    // transport, production shape.
    const fake = fakeDokumenQ()
    vi.stubGlobal('fetch', fake.fetch)
    const adapter = selectStorageAdapter(
      envWith({ baseUrl: BASE, appSecret: SECRET }),
      undefined,
      'DOCUMENTS'
    )
    await expect(adapter.put(KEY, PDF_BYTES, 'application/pdf')).resolves.toBeUndefined()
    expect(fake.calls[0]!.url).toBe(`${BASE}/v1/authorize`)
  })

  it('keeps the R2 adapter when the secret is absent — base URL alone is inert pre-cutover config', async () => {
    const bucket = createDocumentsStub()
    const adapter = selectStorageAdapter(
      envWith({ baseUrl: BASE }),
      bucket as unknown as R2Bucket,
      'DOCUMENTS'
    )
    await expect(adapter.put(KEY, PDF_BYTES, 'application/pdf')).resolves.toBeUndefined()
    // The bytes landed in the R2 stub, storage-identical to the pre-#442 path.
    const stored = bucket.objects.get(KEY)
    expect(stored).toBeDefined()
    expect(stored?.httpMetadata?.contentType).toBe('application/pdf')
  })

  it('keeps the missing-binding failover when neither the secret nor the binding exists (V1-A1 parity)', async () => {
    const adapter = selectStorageAdapter(envWith({}), undefined, 'DOCUMENTS')
    await expect(adapter.get(KEY)).rejects.toThrow(StorageBindingMissingError)
    await expect(adapter.get(KEY)).rejects.toThrow(/'DOCUMENTS'/)
  })

  it('refuses call-time when the secret exists without a base URL — never silent R2 under a live credential', async () => {
    const adapter = selectStorageAdapter(envWith({ appSecret: SECRET }), undefined, 'DOCUMENTS')
    for (const attempt of [
      () => adapter.put(KEY, PDF_BYTES, 'application/pdf'),
      () => adapter.get(KEY),
      () => adapter.delete(KEY),
    ]) {
      await expect(attempt()).rejects.toThrow(DokumenQConfigError)
      await expect(attempt()).rejects.toThrow(
        /DOKUMENQ_APP_SECRET is set but DOKUMENQ_BASE_URL is unset/
      )
    }
  })

  it('composes the same way for the receipts site — one selector, both bindings', async () => {
    const bucket = createDocumentsStub()
    const adapter = selectStorageAdapter(
      envWith({}, undefined),
      bucket as unknown as R2Bucket,
      'RECEIPTS'
    )
    await expect(
      adapter.put('receipts/h1/2026/11/x.jpg', PDF_BYTES, 'image/jpeg')
    ).resolves.toBeUndefined()
    expect(bucket.objects.get('receipts/h1/2026/11/x.jpg')).toBeDefined()
  })
})

// The route-level cutover pin (#442 acceptance: "Vault behavior identical…
// tables/URLs/audit unchanged"): the receipts scan route rides the port, so
// with the cutover vars set the SAME route stores through DokumenQ with zero
// route edits — and the receipts/ key layout is untouched.
describe('receipts scan route under the DokumenQ cutover (#442)', () => {
  it('stores the receipt through the DokumenQ adapter via the unchanged route', async () => {
    const { apiApp } = await import('../apps/api.js')
    const fake = fakeDokumenQ()
    vi.stubGlobal('fetch', fake.fetch)

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
      encrypted_key: 'v1:KIPkC6p1Fvnv4KoVsu-dx-GNoEqmm2kStaExhNbptUJ3lrE',
    }
    const jpegBytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    ])
    const formData = new FormData()
    formData.append('image', new File([jpegBytes], 'receipt.jpg', { type: 'image/jpeg' }))

    const { createMockEnv } = await import('./support/env.js')
    const env = createMockEnv({
      DOKUMENQ_BASE_URL: BASE,
      DOKUMENQ_APP_SECRET: SECRET,
      // The key the AI_ROW fixture's encrypted_key was sealed with (see
      // receipts-storage.test.ts) — otherwise the vision resolution 402s.
      WORKER_ENCRYPTION_KEY: 'test-encryption-key-32-bytes-long!!',
      props: { userId: 'u1', householdId: 'h1' },
      TEST_MODE: 'true',
    }) as unknown as Env['Bindings'] & {
      DB: { first: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn> }
    }
    env.DB.first = vi.fn().mockResolvedValue(AI_ROW)
    env.DB.run = vi.fn().mockResolvedValue(undefined)

    const res = await apiApp.request('/api/purchases/scan', { method: 'POST', body: formData }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { imageKey: string; imageUrl: string | null }
    // THE KEY-LAYOUT PIN, unchanged under the new adapter: receipts/<household>/<yyyy>/<mm>/<uuid>.<ext>.
    expect(body.imageKey).toMatch(
      /^receipts\/h1\/\d{4}\/(0[1-9]|1[0-2])\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/
    )
    // imageUrl stays null — Mode A forbids handing any URL to the client.
    expect(body.imageUrl).toBeNull()

    // The bytes went through authorize + signed PUT (the Mode A shape), and
    // the stored subject is the receipts key.
    expect(fake.calls[0]!.url).toBe(`${BASE}/v1/authorize`)
    const intent = JSON.parse(String(fake.calls[0]!.init.body)) as Record<string, unknown>
    expect(intent['method']).toBe('put')
    expect(intent['subject']).toBe(body.imageKey)
    expect(intent['doc_id']).toBe(await docIdForKey(body.imageKey))
    const uploadBody = new Uint8Array(
      await new Response(fake.calls[1]!.init.body as BodyInit).arrayBuffer()
    )
    expect(uploadBody).toEqual(jpegBytes)
  })
})

describe('signed-URL redirect refusal — the workerd redirect contract', () => {
  // workerd throws TypeError on fetch's `redirect: 'error'` (browsers-only);
  // the adapter must fetch with `redirect: 'manual'` and refuse any 3xx
  // itself. Found live in production 2026-11-11: scans 500'd after a
  // successful mint because the pinned option doesn't exist at the edge.
  function redirectingFake(byteStatus: number): { calls: Call[]; fetch: typeof fetch } {
    const calls: Call[] = []
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
        const url = String(input)
        calls.push({ url, init })
        if (url === `${BASE}/v1/authorize`) {
          const body = JSON.parse(String(init.body)) as { method: string; doc_id: string }
          return jsonRes(200, {
            url: mintedUrl(body.doc_id, body.method === 'put' ? 'put' : 'get'),
            doc_id: body.doc_id,
            expires_at: 1700000000,
            node: 'n1',
          })
        }
        return new Response(null, {
          status: byteStatus,
          headers: { location: `${BASE}/v1/o/elsewhere` },
        })
      }
    ) as unknown as typeof fetch
    return { calls, fetch: fetchMock }
  }

  it('put: fetches with redirect manual and refuses a 3xx from the signed URL', async () => {
    const fake = redirectingFake(302)
    const adapter = adapterWith(fake)
    await expect(adapter.put(KEY, PDF_BYTES, 'application/pdf')).rejects.toMatchObject({
      name: 'DokumenQStorageError',
      code: 'redirect_refused',
      status: 302,
    })
    const putCall = fake.calls.find((c) => c.init.method === 'PUT')!
    // The edge-safe option, not the browsers-only 'error'.
    expect(putCall.init.redirect).toBe('manual')
  })

  it('get: refuses a 3xx from the signed URL instead of following it', async () => {
    const fake = redirectingFake(301)
    const adapter = adapterWith(fake)
    await expect(adapter.get(KEY)).rejects.toMatchObject({
      name: 'DokumenQStorageError',
      code: 'redirect_refused',
      status: 301,
    })
    expect(fake.calls[1]!.init.redirect).toBe('manual')
  })
})
