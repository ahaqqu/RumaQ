import { describe, it, expect, beforeEach, vi } from 'vite-plus/test'
import type { Env } from '../types.js'
import { decryptAiKey, encryptAiKey } from '../lib/crypto.js'
import { encryptProviderKey, providerKeyAad } from '../lib/ai/credentials.js'
import { loadHouseholdAiConfig, resolveAccess } from '../lib/ai/capabilities.js'
import { accessMaterial } from '../lib/ai/key-material.js'
import { completeText } from '../lib/ai/index.js'
import type { AiCtx, Capability } from '../lib/ai/types.js'
import { createDb, type Db } from './support/d1-sqlite.js'

// D10: a provider key is bound to its `ai_providers` row (plan §3.6). These
// tests run the REAL AES-GCM envelopes against the REAL migration chain on
// node:sqlite, because the guarantee is cryptographic and relational at once:
//
//   - a v2: ciphertext copied onto another provider row fails the tag
//     (the transplant a database-level attacker would attempt),
//   - the same envelope in its own row decrypts,
//   - a v1: row decrypts without AAD and is re-sealed exactly once with a
//     compare-and-set (the second read is a no-op),
//   - a failed rewrite still returns the key and never fails the call,
//   - a tag/auth failure is "not configured", never a 500.

const ENCRYPTION_KEY = 'test-encryption-key-32-bytes-long!!'
const HOUSEHOLD = 'h1'

let sqlite: Db
let env: Env['Bindings']
let updates: string[]

/** A D1 wrapper that records which statements were prepared. */
function recordingDb(d1: D1Database): D1Database {
  return {
    ...d1,
    prepare: (sql: string) => {
      if (/UPDATE\s+ai_providers/i.test(sql)) updates.push(sql)
      return d1.prepare(sql)
    },
  } as D1Database
}

beforeEach(() => {
  updates = []
  const { sqlite: db, d1 } = createDb()
  sqlite = db
  sqlite.exec('PRAGMA foreign_keys = ON')
  env = { DB: recordingDb(d1), WORKER_ENCRYPTION_KEY: ENCRYPTION_KEY } as unknown as Env['Bindings']
  sqlite
    .prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)')
    .run('u1', 'u1@example.test', 'Alice')
  sqlite
    .prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)')
    .run(HOUSEHOLD, 'Home', 'u1')
})

function addProvider(
  id: string,
  encryptedKey: string | null,
  overrides: { householdId?: string; label?: string } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO ai_providers (id, household_id, label, kind, preset, base_url, encrypted_key)
       VALUES (?, ?, ?, 'openai-compatible', 'openai', NULL, ?)`
    )
    .run(id, overrides.householdId ?? HOUSEHOLD, overrides.label ?? id, encryptedKey)
}

function assign(capability: Capability, providerId: string): void {
  sqlite
    .prepare(
      `INSERT INTO ai_capabilities (household_id, capability, provider_id, model)
       VALUES (?, ?, ?, 'test-model')`
    )
    .run(HOUSEHOLD, capability, providerId)
}

function ctx(): AiCtx {
  return { env, userId: 'u1', householdId: HOUSEHOLD }
}

function storedEnvelope(providerId: string): string | null {
  const row = sqlite
    .prepare('SELECT encrypted_key FROM ai_providers WHERE id = ?')
    .get(providerId) as { encrypted_key: string | null } | undefined
  return row?.encrypted_key ?? null
}

describe('v2: provider keys are bound to their row (D10)', () => {
  it('decrypts its own envelope and never exposes it on the handle', async () => {
    addProvider('p-1', await encryptProviderKey(env, 'p-1', 'sk-own-row'))
    assign('reasoning', 'p-1')

    const access = await resolveAccess(ctx(), 'reasoning')

    expect(access).not.toBeNull()
    expect(access).not.toHaveProperty('apiKey')
    expect(accessMaterial(access!)?.apiKey).toBe('sk-own-row')
    expect(storedEnvelope('p-1')).toMatch(/^v2:/)
  })

  it('a ciphertext copied onto another provider row fails to decrypt (the transplant case)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    addProvider('p-victim', await encryptProviderKey(env, 'p-victim', 'sk-victim'))
    const copied = storedEnvelope('p-victim')!
    // The attack: copy the victim's ciphertext onto a row the attacker can
    // point their own assignment at. The tag covers `ai_provider:p-other`.
    addProvider('p-other', null)
    sqlite.prepare('UPDATE ai_providers SET encrypted_key = ? WHERE id = ?').run(copied, 'p-other')
    assign('reasoning', 'p-other')

    await expect(resolveAccess(ctx(), 'reasoning')).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[ai] stored provider unusable household=h1')
    )

    // The victim's own row is untouched and still decrypts.
    assign('decision', 'p-victim')
    expect(accessMaterial((await resolveAccess(ctx(), 'decision'))!)?.apiKey).toBe('sk-victim')
    warn.mockRestore()
  })

  it('a wrong WORKER_ENCRYPTION_KEY maps to not_configured, never a 500', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    addProvider('p-1', await encryptProviderKey(env, 'p-1', 'sk-x'))
    assign('reasoning', 'p-1')
    const otherEnv = {
      DB: env.DB,
      WORKER_ENCRYPTION_KEY: 'a-completely-different-key-32b!!',
    } as unknown as Env['Bindings']

    await expect(
      resolveAccess({ env: otherEnv, userId: 'u1', householdId: HOUSEHOLD }, 'reasoning')
    ).resolves.toBeNull()
    // Through the door this is the normal "needs setup" state — a 402, never a 500.
    const error = await completeText({
      env: otherEnv,
      userId: 'u1',
      householdId: HOUSEHOLD,
      messages: [{ role: 'user', content: 'hello' }],
    }).catch((err: unknown) => err)
    expect(error).toMatchObject({ code: 'not_configured', httpStatus: 402 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stored provider unusable'))
    warn.mockRestore()
  })
})

describe('v1: → v2: lazy rewrite (plan §3.6)', () => {
  it('decrypts the legacy envelope and rewrites the row exactly once', async () => {
    addProvider('p-legacy', await encryptAiKey('sk-legacy', ENCRYPTION_KEY))
    assign('reasoning', 'p-legacy')
    expect(storedEnvelope('p-legacy')).toMatch(/^v1:/)

    const first = await resolveAccess(ctx(), 'reasoning')
    expect(accessMaterial(first!)?.apiKey).toBe('sk-legacy')

    const rewritten = storedEnvelope('p-legacy')
    expect(rewritten).toMatch(/^v2:/)
    // The new envelope is bound to THIS row and opens with its AAD.
    await expect(
      decryptAiKey(rewritten!, ENCRYPTION_KEY, providerKeyAad('p-legacy'))
    ).resolves.toBe('sk-legacy')
    expect(updates).toHaveLength(1)

    // The second read is a v2 read: no second UPDATE.
    const second = await resolveAccess(ctx(), 'reasoning')
    expect(accessMaterial(second!)?.apiKey).toBe('sk-legacy')
    expect(updates).toHaveLength(1)
  })

  it('a concurrent key change is not overwritten by the lazy re-seal (compare-and-set)', async () => {
    addProvider('p-legacy', await encryptAiKey('sk-legacy', ENCRYPTION_KEY))
    assign('reasoning', 'p-legacy')
    // The owner rotates the key in another request between our read and our
    // UPDATE. The CAS (`WHERE encrypted_key = <the v1 we read>`) is what keeps
    // the re-seal from clobbering the fresh envelope with the old key.
    const concurrent = await encryptProviderKey(env, 'p-legacy', 'sk-rotated')
    let raced = false
    const racingDb = {
      ...env.DB,
      prepare: (sql: string) => {
        if (!raced && /UPDATE\s+ai_providers/i.test(sql)) {
          raced = true
          sqlite
            .prepare('UPDATE ai_providers SET encrypted_key = ? WHERE id = ?')
            .run(concurrent, 'p-legacy')
        }
        return env.DB.prepare(sql)
      },
    } as D1Database
    const racingEnv = {
      DB: racingDb,
      WORKER_ENCRYPTION_KEY: ENCRYPTION_KEY,
    } as unknown as Env['Bindings']

    const access = await resolveAccess(
      { env: racingEnv, userId: 'u1', householdId: HOUSEHOLD },
      'reasoning'
    )

    // This read still answers with the key it decrypted…
    expect(accessMaterial(access!)?.apiKey).toBe('sk-legacy')
    // …and the concurrent writer's envelope survives: the CAS matched no row.
    expect(storedEnvelope('p-legacy')).toBe(concurrent)
    await expect(
      decryptAiKey(storedEnvelope('p-legacy')!, ENCRYPTION_KEY, providerKeyAad('p-legacy'))
    ).resolves.toBe('sk-rotated')
  })

  it('a failed rewrite still returns the key and never fails the call', async () => {
    // Same database, but the re-seal UPDATE is refused at prepare time — the
    // D1 failure the plan says must never fail the call.
    const guardedDb = {
      ...env.DB,
      prepare: (sql: string) => {
        if (/UPDATE\s+ai_providers/i.test(sql)) throw new Error('D1 write refused')
        return env.DB.prepare(sql)
      },
    } as D1Database
    const guarded = {
      DB: guardedDb,
      WORKER_ENCRYPTION_KEY: ENCRYPTION_KEY,
    } as unknown as Env['Bindings']
    addProvider('p-legacy', await encryptAiKey('sk-legacy', ENCRYPTION_KEY))
    assign('reasoning', 'p-legacy')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const access = await resolveAccess(
      { env: guarded, userId: 'u1', householdId: HOUSEHOLD },
      'reasoning'
    )

    expect(accessMaterial(access!)?.apiKey).toBe('sk-legacy')
    expect(storedEnvelope('p-legacy')).toMatch(/^v1:/)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[ai] legacy key re-seal failed provider=p-legacy')
    )
    warn.mockRestore()
  })

  it('the settings read model never rewrites (a GET must not write)', async () => {
    addProvider('p-legacy', await encryptAiKey('sk-legacy', ENCRYPTION_KEY))
    assign('reasoning', 'p-legacy')

    const config = await loadHouseholdAiConfig(env, HOUSEHOLD)

    expect(config.status.reasoning).toBe('household')
    expect(storedEnvelope('p-legacy')).toMatch(/^v1:/)
    expect(updates).toHaveLength(0)
  })
})
