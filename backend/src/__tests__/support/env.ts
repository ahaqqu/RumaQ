import { vi, type Mock } from 'vite-plus/test'
import type { AuthProps, Env } from '../../types.js'

type MockD1 = {
  prepare: Mock
  bind: Mock
  first: Mock
  all: Mock
  batch: Mock
}

export type MockEnv = Omit<Env['Bindings'], 'DB' | 'RECEIPTS' | 'ASSETS' | 'props'> & {
  DB: MockD1
  RECEIPTS: Record<string, never>
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
