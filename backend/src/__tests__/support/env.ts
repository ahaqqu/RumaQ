import { vi, type Mock } from 'vite-plus/test'
import type { AuthProps, Env } from '../../types.js'

type MockD1 = {
  prepare: Mock
  bind: Mock
  first: Mock
  all: Mock
  batch: Mock
  run: Mock
}

// Minimal in-memory R2 stub for the BROCHURES bucket (issue #293) and the
// DOCUMENTS vault bucket (issue #388): get/put/delete/list over a Map —
// enough surface for the upload/proxy routes and the retention sweep's
// paginated list. Real Miniflare R2 in the automation harness covers the
// actual semantics.
export type StubR2Object = {
  key: string
  httpMetadata?: { contentType?: string }
  customMetadata?: Record<string, string>
  size: number
  body: ReadableStream<Uint8Array>
  blob: () => Promise<Blob>
  arrayBuffer: () => Promise<ArrayBuffer>
}

export function createBrochuresStub() {
  const objects = new Map<
    string,
    {
      bytes: Uint8Array
      httpMetadata?: { contentType?: string }
      customMetadata?: Record<string, string>
    }
  >()
  // Every delete is recorded — the vault tests assert "no orphan object"
  // against this log, not a mock call count.
  const deleted: string[] = []
  return {
    objects,
    deleted,
    async put(
      key: string,
      value: Uint8Array,
      options: {
        httpMetadata?: { contentType?: string }
        customMetadata?: Record<string, string>
      } = {}
    ) {
      objects.set(key, {
        bytes: value,
        httpMetadata: options.httpMetadata,
        customMetadata: options.customMetadata,
      })
      return { key }
    },
    async get(key: string): Promise<StubR2Object | null> {
      const obj = objects.get(key)
      if (!obj) return null
      return {
        key,
        httpMetadata: obj.httpMetadata,
        customMetadata: obj.customMetadata,
        size: obj.bytes.byteLength,
        // One-shot body stream, like R2ObjectBody — the vault's StorageAdapter
        // streams this straight into the Response.
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(obj.bytes.slice())
            controller.close()
          },
        }),
        blob: () => Promise.resolve(new Blob([obj.bytes as BlobPart])),
        arrayBuffer: () => Promise.resolve(obj.bytes.slice().buffer as ArrayBuffer),
      }
    },
    async delete(key: string) {
      deleted.push(key)
      objects.delete(key)
    },
    async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const prefix = options.prefix ?? ''
      const all = [...objects.keys()].sort().filter((key) => key.startsWith(prefix))
      // R2 cursors are key-anchored (stable under concurrent deletes), not
      // numeric offsets — model the same semantics so sweep pagination is
      // exercised honestly.
      let startIdx = 0
      if (options.cursor) {
        startIdx = all.findIndex((key) => key > options.cursor!)
        if (startIdx === -1) startIdx = all.length
      }
      const limit = options.limit ?? 1000
      const page = all.slice(startIdx, startIdx + limit)
      const truncated = startIdx + limit < all.length
      return {
        objects: page.map((key) => ({ key })) as Array<{ key: string }>,
        truncated,
        ...(truncated && page.length > 0 ? { cursor: page[page.length - 1] } : {}),
      }
    },
  }
}

export type MockBrochures = ReturnType<typeof createBrochuresStub>

// The document vault's in-memory R2 (issue #388) — the same Map-backed stub
// shape as the brochures one; tests assert on the recorded puts/deletes.
export const createDocumentsStub = createBrochuresStub

export type MockEnv = Omit<
  Env['Bindings'],
  'DB' | 'RECEIPTS' | 'BROCHURES' | 'DOCUMENTS' | 'ASSETS' | 'props'
> & {
  DB: MockD1
  // The receipts binding rides the SAME stub shape as the vault's (#503
  // routed receipt IO through the StorageAdapter port; #442's selector keeps
  // the R2 adapter over this stub in tests) — no more Record<never> dead type.
  RECEIPTS: MockBrochures
  BROCHURES: MockBrochures
  DOCUMENTS: MockBrochures
  ASSETS: Fetcher
  props?: AuthProps
}

export function createMockEnv(overrides: Partial<MockEnv> = {}): MockEnv {
  return {
    DB: {
      prepare: vi.fn().mockReturnThis(),
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
      batch: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue(undefined),
    },
    RECEIPTS: createDocumentsStub(),
    BROCHURES: createBrochuresStub(),
    DOCUMENTS: createDocumentsStub(),
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    WORKER_JWT_SECRET: 'test-secret',
    WORKER_ENCRYPTION_KEY: 'test-enc-key',
    PAGES_ORIGIN: 'http://localhost:5173',
    EMAIL_AUTH_ENABLED: 'false',
    ASSETS: undefined as unknown as Fetcher,
    props: undefined,
    ...overrides,
  }
}
