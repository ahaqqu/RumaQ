import { describe, it, expect, beforeEach, vi } from 'vite-plus/test'
import type { Env } from '../types.js'
import { encryptAiKey } from '../lib/crypto.js'
import { loadHouseholdAiConfig, resolveAccess } from '../lib/ai/capabilities.js'
import { accessMaterial } from '../lib/ai/key-material.js'
import { deleteExpiredAiUsageEvents, recordAiUsageEvent } from '../lib/ai/usage.js'
import type { AiCtx } from '../lib/ai/types.js'
import { createDb, type Db } from './support/d1-sqlite.js'

// The AI gateway resolver (#523 P1) against a REAL SQLite (node:sqlite over the
// real migration chain — D1 is SQLite, so the two tables, their FKs/CHECKs and
// the joins are exercised, not mocked) and REAL AES-GCM envelopes from
// lib/crypto.ts. The ladder is two-outcome by owner decision (D8):
//
//   assignment → usable access            (the household's own rows)
//   anything else → null → 402           (no server key, no platform default)

const ENCRYPTION_KEY = 'test-encryption-key-32-bytes-long!!'
const ENCRYPTED_KEY = 'v1:KIPkC6p1Fvnv4KoVsu-dx-GNoEqmm2kStaExhNbptUJ3lrE'

let sqlite: Db
let d1: D1Database
let env: Env['Bindings']

beforeEach(() => {
  const { sqlite: db, d1: adapter } = createDb()
  sqlite = db
  d1 = adapter
  // D1 enforces foreign keys; node:sqlite defaults them OFF.
  sqlite.exec('PRAGMA foreign_keys = ON')
  env = { DB: d1, WORKER_ENCRYPTION_KEY: ENCRYPTION_KEY } as unknown as Env['Bindings']
})

// --- fixtures --------------------------------------------------------------

function addUser(id = 'u1', name = 'Alice'): void {
  sqlite.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id, `${id}@x`, name)
}

function addHousehold(id = 'h1', createdBy = 'u1'): void {
  sqlite
    .prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)')
    .run(id, id.toUpperCase(), createdBy)
}

function addMember(
  householdId: string,
  userId: string,
  role: 'owner' | 'member' = 'owner',
  joinedAt = '2026-01-01 00:00:00'
): void {
  sqlite
    .prepare(
      `INSERT INTO household_members (id, household_id, user_id, role, joined_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(`${householdId}-${userId}`, householdId, userId, role, joinedAt)
}

type ProviderSeed = {
  id?: string
  householdId?: string
  label?: string
  kind?: string
  preset?: string | null
  baseUrl?: string | null
  /** Provider-level default model (#523 owner decision); undefined = NULL. */
  defaultModel?: string | null
  /** Plaintext key; undefined = no key column value at all. */
  key?: string | null
}

async function addProvider(seed: ProviderSeed = {}): Promise<string> {
  const id = seed.id ?? 'p-1'
  const encrypted = seed.key == null ? null : await encryptAiKey(seed.key, ENCRYPTION_KEY)
  sqlite
    .prepare(
      `INSERT INTO ai_providers
         (id, household_id, label, kind, preset, base_url, default_model, encrypted_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      seed.householdId ?? 'h1',
      seed.label ?? 'OpenAI',
      seed.kind ?? 'openai-compatible',
      seed.preset === undefined ? 'openai' : seed.preset,
      seed.baseUrl ?? null,
      seed.defaultModel ?? null,
      encrypted
    )
  return id
}

function addCapability(
  capability: string,
  providerId: string,
  options: { householdId?: string; model?: string | null; thinking?: string | null } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO ai_capabilities
         (household_id, capability, provider_id, model, thinking_level)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      options.householdId ?? 'h1',
      capability,
      providerId,
      options.model ?? null,
      options.thinking ?? null
    )
}

function ctx(householdId = 'h1', userId = 'u1'): AiCtx {
  return { env, householdId, userId }
}

/** A complete single-provider household, as the P1 backfill produces it. */
async function seedHousehold(seed: { key?: string } = {}): Promise<void> {
  addUser('u1')
  addHousehold('h1')
  addMember('h1', 'u1')
  // Every account creation path writes this row (apps/auth.ts), and the P1
  // bridge reads the resolved household from the projection.
  sqlite
    .prepare(
      `INSERT INTO user_settings (id, user_id, active_household_id) VALUES ('s1', 'u1', 'h1')`
    )
    .run()
  const providerId = await addProvider({
    key: seed.key ?? 'sk-household',
    label: 'OpenAI (imported)',
  })
  addCapability('reasoning', providerId, { model: 'gpt-4o-mini', thinking: 'low' })
  addCapability('decision', providerId, { model: 'gpt-4o-mini', thinking: 'low' })
  addCapability('vision', providerId, { model: 'gpt-4o-vision' })
}

// --- resolveAccess: the two-outcome ladder ----------------------------------

describe('resolveAccess (household capability ladder)', () => {
  it('resolves the assignment into a funded handle with the decrypted key', async () => {
    await seedHousehold()

    const access = await resolveAccess(ctx(), 'reasoning')

    expect(access).toMatchObject({
      capability: 'reasoning',
      call: {
        capability: 'reasoning',
        householdId: 'h1',
        providerKind: 'openai-compatible',
        providerId: 'p-1',
        model: 'gpt-4o-mini',
        funding: 'household',
      },
    })
    // The key material is NEVER on the handle (P2): it lives in the door's
    // module-private WeakMap and no signature or response can reach it.
    expect(access).not.toHaveProperty('apiKey')
    expect(accessMaterial(access!)).toMatchObject({
      apiKey: 'sk-household',
      baseUrl: 'https://api.openai.com/v1',
      preset: 'openai',
      thinkingLevel: 'low',
    })
  })

  it('returns null when the capability has no assignment', async () => {
    await seedHousehold()
    sqlite.prepare(`DELETE FROM ai_capabilities WHERE capability = 'vision'`).run()
    expect(await resolveAccess(ctx(), 'vision')).toBeNull()
  })

  it('returns null for an empty account (no provider, no assignment)', async () => {
    addUser('u1')
    addHousehold('h1')
    addMember('h1', 'u1')
    for (const capability of ['decision', 'reasoning', 'vision'] as const) {
      expect(await resolveAccess(ctx(), capability)).toBeNull()
    }
  })

  it('returns null when the assigned provider has no key (the row needs setup, no 500)', async () => {
    addUser('u1')
    addHousehold('h1')
    addMember('h1', 'u1')
    const providerId = await addProvider({ key: null })
    addCapability('reasoning', providerId, { model: 'gpt-4o-mini' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await resolveAccess(ctx(), 'reasoning')).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no usable provider'))
    warn.mockRestore()
  })

  it('treats an undecryptable key as not configured (never throws, never logs the key)', async () => {
    addUser('u1')
    addHousehold('h1')
    addMember('h1', 'u1')
    // A well-formed envelope sealed with a DIFFERENT key: the tag fails.
    const foreign = await encryptAiKey('sk-someone-else', 'another-key-entirely-32-bytes!!')
    const providerId = await addProvider({ key: null })
    sqlite
      .prepare('UPDATE ai_providers SET encrypted_key = ? WHERE id = ?')
      .run(foreign, providerId)
    addCapability('reasoning', providerId, { model: 'gpt-4o-mini' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(resolveAccess(ctx(), 'reasoning')).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`[ai] stored provider unusable household=h1`)
    )
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('sk-someone-else')
    warn.mockRestore()
  })

  it('accepts a v2: envelope bound to its own row (D10)', async () => {
    addUser('u1')
    addHousehold('h1')
    addMember('h1', 'u1')
    const providerId = await addProvider({ key: null })
    // encryptAiKey with additionalData writes the v2 form (crypto.ts).
    const sealed = await encryptAiKey('sk-bound', ENCRYPTION_KEY, `ai_provider:${providerId}`)
    sqlite.prepare('UPDATE ai_providers SET encrypted_key = ? WHERE id = ?').run(sealed, providerId)
    addCapability('reasoning', providerId, { model: 'gpt-4o-mini' })

    const access = await resolveAccess(ctx(), 'reasoning')
    expect(accessMaterial(access!)?.apiKey).toBe('sk-bound')
  })

  it('returns null for an openai-compatible row with neither base URL nor preset endpoint', async () => {
    addUser('u1')
    addHousehold('h1')
    addMember('h1', 'u1')
    const providerId = await addProvider({ key: 'sk-x', preset: null, baseUrl: null })
    addCapability('reasoning', providerId)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await resolveAccess(ctx(), 'reasoning')).toBeNull()
  })

  it('lets the row base URL override the preset endpoint', async () => {
    addUser('u1')
    addHousehold('h1')
    addMember('h1', 'u1')
    const providerId = await addProvider({
      key: 'sk-x',
      preset: 'openai',
      baseUrl: 'https://openrouter.example/v1',
    })
    addCapability('reasoning', providerId, { model: 'gpt-4o-mini' })
    const access = await resolveAccess(ctx(), 'reasoning')
    expect(accessMaterial(access!)?.baseUrl).toBe('https://openrouter.example/v1')
  })

  it('resolves a typed questions provider (base URL is its endpoint)', async () => {
    addUser('u1')
    addHousehold('h1')
    addMember('h1', 'u1')
    const providerId = await addProvider({
      key: 'sk-typed',
      kind: 'questions',
      preset: null,
      baseUrl: 'https://api.typesafe.ai/v1/systemone',
    })
    addCapability('decision', providerId, { model: 'jev-latest' })
    const access = await resolveAccess(ctx(), 'decision')
    expect(access).toMatchObject({
      capability: 'decision',
      call: { providerKind: 'questions', model: 'jev-latest' },
    })
    expect(accessMaterial(access!)?.apiKey).toBe('sk-typed')
  })

  it('keys on the household, never on the user (another household resolves nothing)', async () => {
    await seedHousehold()
    addUser('u2')
    addHousehold('h2', 'u2')
    addMember('h2', 'u2')
    // h1's assignment is invisible to h2 — and an h1 member sees the SAME row.
    expect(await resolveAccess(ctx('h2', 'u2'), 'reasoning')).toBeNull()
    const asMember = await resolveAccess(ctx('h1', 'u1'), 'reasoning')
    expect(asMember?.call.providerId).toBe('p-1')
  })

  it('refuses an assignment that points at another household provider (thermos A1)', async () => {
    addUser('u1')
    addUser('u2')
    addHousehold('h1')
    addHousehold('h2', 'u2')
    addMember('h1', 'u1')
    addMember('h2', 'u2')
    // h2 owns a keyed provider; h1's assignment is redirected at it (a hand
    // edit, or a future write-path bug — the resolver is the boundary either
    // way). SQLite has no composite FK, so the JOIN must carry the household.
    const victim = await addProvider({
      id: 'p-victim',
      householdId: 'h2',
      label: 'Victim',
      key: 'sk-victim-household',
    })
    addCapability('reasoning', victim, { householdId: 'h1', model: 'gpt-4o-mini' })

    expect(await resolveAccess(ctx('h1', 'u1'), 'reasoning')).toBeNull()
    // h2 still resolves its own row — the join is scoped, not broken.
    sqlite
      .prepare(
        `INSERT INTO ai_capabilities (household_id, capability, provider_id, model)
         VALUES ('h2','reasoning','p-victim','gpt-4o-mini')`
      )
      .run()
    expect((await resolveAccess(ctx('h2', 'u2'), 'reasoning'))?.call.providerId).toBe('p-victim')
    // The settings read model agrees with the resolver about h1.
    expect((await loadHouseholdAiConfig(env, 'h1')).status.reasoning).toBe('none')
  })

  it('lets the capability model win over the provider default', async () => {
    addUser('u1')
    addHousehold('h1')
    addMember('h1', 'u1')
    const providerId = await addProvider({ key: 'sk-x', defaultModel: 'chatgpt-4o-latest' })
    addCapability('reasoning', providerId, { model: 'gpt-4.1' })

    const access = await resolveAccess(ctx(), 'reasoning')
    expect(access?.call.model).toBe('gpt-4.1')
  })

  it("inherits the provider's default model when the capability leaves it blank", async () => {
    addUser('u1')
    addHousehold('h1')
    addMember('h1', 'u1')
    const providerId = await addProvider({ key: 'sk-x', defaultModel: 'chatgpt-4o-latest' })
    addCapability('reasoning', providerId)
    addCapability('vision', providerId)

    const reasoning = await resolveAccess(ctx(), 'reasoning')
    expect(reasoning?.call.model).toBe('chatgpt-4o-latest')
    // Vision inherits the same default, and still carries no thinking level.
    const vision = await resolveAccess(ctx(), 'vision')
    expect(vision?.call.model).toBe('chatgpt-4o-latest')
    expect(accessMaterial(vision!)?.thinkingLevel).toBeNull()
  })

  it('returns null when neither the capability nor the provider has a model (no adapter default)', async () => {
    addUser('u1')
    addHousehold('h1')
    addMember('h1', 'u1')
    const providerId = await addProvider({ key: 'sk-x' })
    addCapability('reasoning', providerId)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await resolveAccess(ctx(), 'reasoning')).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no model'))
    warn.mockRestore()
  })

  it('resolves EACH capability to its own assignment, never a shared primary (#523 P4)', async () => {
    // The legacy bridge picked reasoning → decision → vision once and served
    // every route from it; the receipt scan therefore sent an image to the text
    // model. After P4 each call site resolves its own capability, so three
    // assignments on two providers must come back as three distinct calls.
    await seedHousehold()
    const visionProvider = await addProvider({
      id: 'p-vision',
      label: 'Vision',
      kind: 'gemini',
      preset: 'gemini',
      key: 'sk-vision',
    })
    sqlite
      .prepare(`UPDATE ai_capabilities SET provider_id = ?, model = ? WHERE capability = 'vision'`)
      .run(visionProvider, 'gemini-3.6-flash')

    const reasoning = await resolveAccess(ctx(), 'reasoning')
    const decision = await resolveAccess(ctx(), 'decision')
    const vision = await resolveAccess(ctx(), 'vision')

    expect(reasoning?.call).toMatchObject({
      capability: 'reasoning',
      providerId: 'p-1',
      providerKind: 'openai-compatible',
      model: 'gpt-4o-mini',
    })
    expect(decision?.call).toMatchObject({ capability: 'decision', providerId: 'p-1' })
    // The scan path's access is the vision ROW: another provider, its own model.
    expect(vision?.call).toMatchObject({
      capability: 'vision',
      providerId: 'p-vision',
      providerKind: 'gemini',
      model: 'gemini-3.6-flash',
    })
    expect(accessMaterial(vision!)?.apiKey).toBe('sk-vision')
  })

  it('ignores retired RUMAQ_SERVER_AI_* bindings entirely (env present but inert)', async () => {
    addUser('u1')
    addHousehold('h1')
    addMember('h1', 'u1')
    const legacyEnv = {
      ...env,
      // TypeScript no longer declares these (D8); a Worker that still carries
      // them must have NO effect on resolution.
      RUMAQ_SERVER_AI_PROVIDER: 'gemini',
      RUMAQ_SERVER_AI_KEY: 'sk-server',
      RUMAQ_SERVER_AI_MODEL: 'gemini-3.6-pro',
    } as unknown as Env['Bindings']

    expect(
      await resolveAccess({ env: legacyEnv, userId: 'u1', householdId: 'h1' }, 'reasoning')
    ).toBeNull()
    expect(
      await resolveAccess({ env: legacyEnv, userId: 'u1', householdId: 'h1' }, 'decision')
    ).toBeNull()
    expect(
      await resolveAccess({ env: legacyEnv, userId: 'u1', householdId: 'h1' }, 'vision')
    ).toBeNull()
  })
})

describe('loadHouseholdAiConfig (the settings read model)', () => {
  it('returns the providers, the three assignments and the usable status', async () => {
    await seedHousehold()
    const config = await loadHouseholdAiConfig(env, 'h1')

    expect(config.providers).toEqual([
      expect.objectContaining({
        id: 'p-1',
        label: 'OpenAI (imported)',
        kind: 'openai-compatible',
        base_url: null,
        has_key: true,
      }),
    ])
    expect(config.capabilities.reasoning).toEqual({
      provider_id: 'p-1',
      provider_label: 'OpenAI (imported)',
      model: 'gpt-4o-mini',
      effective_model: 'gpt-4o-mini',
      thinking_level: 'low',
      source: 'household',
    })
    expect(config.capabilities.vision).toMatchObject({
      model: 'gpt-4o-vision',
      effective_model: 'gpt-4o-vision',
      thinking_level: null,
    })
    expect(config.status).toEqual({
      decision: 'household',
      reasoning: 'household',
      vision: 'household',
    })
  })

  it('reports a configured-but-unusable row as source=household, status=none', async () => {
    addUser('u1')
    addHousehold('h1')
    addMember('h1', 'u1')
    const providerId = await addProvider({ key: null })
    addCapability('reasoning', providerId)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const config = await loadHouseholdAiConfig(env, 'h1')
    expect(config.capabilities.reasoning.source).toBe('household')
    expect(config.status).toEqual({ decision: 'none', reasoning: 'none', vision: 'none' })
  })

  it('reports the effective model and the provider default in the payload', async () => {
    addUser('u1')
    addHousehold('h1')
    addMember('h1', 'u1')
    const providerId = await addProvider({ key: 'sk-x', defaultModel: 'chatgpt-4o-latest' })
    addCapability('reasoning', providerId)
    addCapability('vision', providerId, { model: 'gpt-4o-vision' })

    const config = await loadHouseholdAiConfig(env, 'h1')
    expect(config.providers[0]).toMatchObject({ default_model: 'chatgpt-4o-latest' })
    // reasoning has no model of its own (the column stays null, so the Settings
    // form shows a blank "inherit" field) but it resolves to the inherited one.
    expect(config.capabilities.reasoning.model).toBeNull()
    expect(config.capabilities.reasoning.effective_model).toBe('chatgpt-4o-latest')
    // ...and a capability model still wins on both fields.
    expect(config.capabilities.vision.model).toBe('gpt-4o-vision')
    expect(config.capabilities.vision.effective_model).toBe('gpt-4o-vision')
    expect(config.status.reasoning).toBe('household')
    expect(config.status.vision).toBe('household')
  })

  it('reports status=none when neither the capability nor the provider has a model', async () => {
    addUser('u1')
    addHousehold('h1')
    addMember('h1', 'u1')
    const providerId = await addProvider({ key: 'sk-x' })
    addCapability('reasoning', providerId)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const config = await loadHouseholdAiConfig(env, 'h1')
    // Configured (an owner chose a provider) but unusable (no model anywhere).
    expect(config.capabilities.reasoning.source).toBe('household')
    expect(config.capabilities.reasoning.model).toBeNull()
    expect(config.capabilities.reasoning.effective_model).toBeNull()
    expect(config.status.reasoning).toBe('none')
  })

  it('never serialises key material, for any provider or status', async () => {
    await seedHousehold({ key: 'sk-household' })
    const config = await loadHouseholdAiConfig(env, 'h1')
    const serialized = JSON.stringify(config)
    expect(serialized).not.toContain('sk-household')
    expect(serialized).not.toContain(ENCRYPTED_KEY)
    expect(Object.keys(config.providers[0] ?? {})).not.toContain('encrypted_key')
  })

  it('returns an empty, all-none block for a fresh household', async () => {
    addUser('u1')
    addHousehold('h1')
    addMember('h1', 'u1')
    const config = await loadHouseholdAiConfig(env, 'h1')
    expect(config.providers).toEqual([])
    expect(config.status).toEqual({ decision: 'none', reasoning: 'none', vision: 'none' })
    expect(config.capabilities.reasoning).toEqual({
      provider_id: null,
      provider_label: null,
      model: null,
      effective_model: null,
      thinking_level: null,
      source: 'none',
    })
  })
})

// --- usage writer ----------------------------------------------------------

describe('recordAiUsageEvent (#523 usage dimensions)', () => {
  const call = {
    capability: 'reasoning' as const,
    householdId: 'h1',
    providerKind: 'openai-compatible' as const,
    providerId: 'p-1',
    model: 'gpt-4o-mini',
    funding: 'household' as const,
  }

  it('writes capability + household_id + funding, and no key_source', async () => {
    addUser('u1')
    addHousehold('h1')
    addMember('h1', 'u1')
    sqlite
      .prepare('INSERT INTO ai_providers (id, household_id, label, kind) VALUES (?, ?, ?, ?)')
      .run('p-1', 'h1', 'OpenAI', 'openai-compatible')

    await recordAiUsageEvent(
      env,
      {
        userId: 'u1',
        call,
        usage: { input_tokens: 900, output_tokens: 100, cached_tokens: 640 },
      },
      new Date('2026-11-01T07:15:30.400Z')
    )

    const rows = sqlite.prepare('SELECT * FROM ai_usage_events ORDER BY ts').all() as Array<
      Record<string, unknown>
    >
    expect(rows).toEqual([
      expect.objectContaining({
        user_id: 'u1',
        ts: '2026-11-01T07:15:30.400Z',
        date: '2026-11-01',
        provider: 'openai-compatible',
        model: 'gpt-4o-mini',
        capability: 'reasoning',
        household_id: 'h1',
        funding: 'household',
        input_tokens: 900,
        output_tokens: 100,
        cached_tokens: 640,
        // D9 replaced the old provenance column; history keeps whatever it had.
        key_source: null,
      }),
    ])
  })

  it('records null cached tokens when the provider reports none', async () => {
    addUser('u1')
    addHousehold('h1')
    addMember('h1', 'u1')
    sqlite
      .prepare('INSERT INTO ai_providers (id, household_id, label, kind) VALUES (?, ?, ?, ?)')
      .run('p-1', 'h1', 'OpenAI', 'openai-compatible')

    await recordAiUsageEvent(
      env,
      {
        userId: 'u1',
        call: { ...call, model: null },
        usage: { input_tokens: 0, output_tokens: 0, cached_tokens: null },
      },
      new Date('2026-11-01T23:59:59.000Z')
    )
    const row = sqlite.prepare('SELECT model, cached_tokens FROM ai_usage_events').get()
    expect(row).toEqual({ model: null, cached_tokens: null })
  })
})

describe('deleteExpiredAiUsageEvents (1-year retention)', () => {
  it('deletes events strictly older than 365 days at the injected instant', async () => {
    addUser('u1')
    const insert = sqlite.prepare(
      `INSERT INTO ai_usage_events (id, user_id, ts, date) VALUES (?, ?, ?, ?)`
    )
    insert.run('old', 'u1', '2025-11-01T03:16:59.999Z', '2025-11-01')
    insert.run('boundary', 'u1', '2025-11-01T03:17:00.000Z', '2025-11-01')
    insert.run('fresh', 'u1', '2026-06-01T00:00:00.000Z', '2026-06-01')

    await deleteExpiredAiUsageEvents(env, new Date('2026-11-01T03:17:00.000Z'))

    const ids = (
      sqlite.prepare('SELECT id FROM ai_usage_events ORDER BY id').all() as Array<{
        id: string
      }>
    ).map((row) => row.id)
    expect(ids).toEqual(['boundary', 'fresh'])
  })
})
