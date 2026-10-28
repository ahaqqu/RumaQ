import { vi, type Mock } from 'vite-plus/test'
import type { AuthProps, Env } from '../../types.js'

type MockD1 = {
  prepare: Mock
  bind: Mock
  first: Mock
  all: Mock
  batch: Mock
}

// Minimal in-memory R2 stub for the BROCHURES bucket (issue #293):
// get/put/delete/list over a Map — enough surface for the upload/proxy
// routes and the retention sweep's paginated list. Real Miniflare R2 in the
// automation harness covers the actual semantics.
export type StubR2Object = {
  key: string
  httpMetadata?: { contentType?: string }
  customMetadata?: Record<string, string>
  blob: () => Promise<Blob>
  arrayBuffer: () => Promise<ArrayBuffer>
}

export function createBrochuresStub() {
  const objects = new Map<
    string,
    { bytes: Uint8Array; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }
  >()
  return {
    objects,
    async put(
      key: string,
      value: Uint8Array,
      options: {
        httpMetadata?: { contentType?: string }
        customMetadata?: Record<string, string>
      } = {}
    ) {
      objects.set(key, { bytes: value, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata })
      return { key }
    },
    async get(key: string): Promise<StubR2Object | null> {
      const obj = objects.get(key)
      if (!obj) return null
      return {
        key,
        httpMetadata: obj.httpMetadata,
        customMetadata: obj.customMetadata,
        blob: () => Promise.resolve(new Blob([obj.bytes as BlobPart])),
        arrayBuffer: () =>
          Promise.resolve(
            obj.bytes.slice().buffer as ArrayBuffer
          ),
      }
    },
    async delete(key: string) {
      objects.delete(key)
    },
    async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const prefix = options.prefix ?? ''
      const all = [...objects.keys()].sort().filter((key) => key.startsWith(prefix))
      const cursor = options.cursor ? Number(options.cursor) : 0
      const limit = options.limit ?? 1000
      const page = all.slice(cursor, cursor + limit)
      const truncated = cursor + limit < all.length
      return {
        objects: page.map((key) => ({ key })) as Array<{ key: string }>,
        truncated,
        ...(truncated ? { truncatedPart: String(cursor + limit) } : {}),
      }
    },
  }
}

export type MockBrochures = ReturnType<typeof createBrochuresStub>

export type MockEnv = Omit<Env['Bindings'], 'DB' | 'RECEIPTS' | 'BROCHURES' | 'ASSETS' | 'props'> & {
  DB: MockD1
  RECEIPTS: Record<string, never>
  BROCHURES: MockBrochures
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
    },
    RECEIPTS: {},
    BROCHURES: createBrochuresStub(),
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
