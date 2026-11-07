// Shared fixture for the suites that exercise a FEATURE call site (chat, plans,
// the receipt scan) rather than the door itself: a two-line fake D1 that answers
// the resolver's single JOIN, a real AES-GCM envelope from lib/crypto.ts, and a
// resolved `AiAccessHandle` for the test to hand the module under test.
//
// The provider transport is the mocked global `fetch` each test installs — no
// suite may reach a real AI endpoint. `ai-call-sites.test.ts` uses the real
// SQLite chain instead, because it asserts the usage ROWS a route writes; this
// fixture is for the pure feature modules, where the row is not the subject.

import type { Env } from '../../types.js'
import { encryptAiKey } from '../../lib/crypto.js'
import { resolveAccess, type AiAccessHandle } from '../../lib/ai/index.js'
import type { Capability } from '../../lib/ai/types.js'

export const AI_ENCRYPTION_KEY = 'test-encryption-key-32-bytes-long!!'
export const AI_TEST_HOUSEHOLD = 'h1'
export const AI_TEST_USER = 'u1'

export type FakeRow = Record<string, unknown>

type BoundStatement = {
  first: () => Promise<FakeRow | null>
  all: () => Promise<{ results: FakeRow[] }>
  run: () => Promise<{ meta: { changes: number } }>
}

export type FakeAiEnv = {
  env: Env['Bindings']
  /** How many statements were prepared (the resolver's one read is 1). */
  prepares: () => number
  runs: () => Array<{ sql: string; params: unknown[] }>
}

/**
 * One fake D1: the resolver's JOIN is answered from `rows` keyed by the
 * requested capability (the SQL's second bind parameter), which is exactly what
 * the real ACCESS_SQL returns.
 */
export function fakeAiEnv(rows: Partial<Record<Capability, FakeRow>>): FakeAiEnv {
  let prepares = 0
  const runs: Array<{ sql: string; params: unknown[] }> = []

  const execute = (sql: string, params: unknown[]): BoundStatement => ({
    first: async () => rows[String(params[1]) as Capability] ?? null,
    all: async () => ({ results: [] }),
    run: async () => {
      runs.push({ sql, params })
      return { meta: { changes: 1 } }
    },
  })

  const db = {
    prepare: (sql: string) => {
      prepares += 1
      let bound = execute(sql, [])
      const statement = {
        bind: (...params: unknown[]) => {
          bound = execute(sql, params)
          return statement
        },
        first: () => bound.first(),
        all: () => bound.all(),
        run: () => bound.run(),
      }
      return statement
    },
  }

  return {
    env: { DB: db, WORKER_ENCRYPTION_KEY: AI_ENCRYPTION_KEY } as unknown as Env['Bindings'],
    prepares: () => prepares,
    runs: () => runs,
  }
}

/** One provider row shaped exactly like the resolver's JOIN. */
export async function aiProviderRow(
  capability: Capability,
  overrides: FakeRow = {}
): Promise<FakeRow> {
  const providerId = String(overrides.provider_id ?? 'p-1')
  return {
    capability,
    model: 'test-model',
    thinking_level: null,
    provider_id: providerId,
    kind: 'openai-compatible',
    preset: 'openai',
    base_url: null,
    default_model: null,
    encrypted_key: await encryptAiKey(
      'sk-household',
      AI_ENCRYPTION_KEY,
      `ai_provider:${providerId}`
    ),
    ...overrides,
  }
}

/** `fakeAiEnv` seeded with one provider row per requested capability. */
export async function fakeAiEnvWith(
  rows: Partial<Record<Capability, FakeRow>>
): Promise<FakeAiEnv> {
  const resolved: Record<string, FakeRow> = {}
  for (const capability of ['reasoning', 'decision', 'vision'] as const) {
    if (rows[capability]) resolved[capability] = await aiProviderRow(capability, rows[capability])
  }
  return fakeAiEnv(resolved)
}

/** The handle a feature call site would hold after resolving one capability. */
export async function resolveTestAccess(
  env: Env['Bindings'],
  capability: Capability,
  householdId: string = AI_TEST_HOUSEHOLD,
  userId: string = AI_TEST_USER
): Promise<AiAccessHandle> {
  const access = await resolveAccess({ env, userId, householdId }, capability)
  if (!access) throw new Error(`test setup: capability '${capability}' did not resolve`)
  return access
}

/** A provider answer shaped like the OpenAI-compatible chat response. */
export function openAiChatAnswer(
  content: string,
  usage: { prompt_tokens: number; completion_tokens: number } = {
    prompt_tokens: 100,
    completion_tokens: 10,
  }
) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ choices: [{ message: { content } }], usage }),
    text: async () => '',
  } as unknown as Response
}
