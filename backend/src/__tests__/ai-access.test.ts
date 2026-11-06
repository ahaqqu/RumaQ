import { describe, it, expect, vi } from 'vite-plus/test'
import {
  deleteExpiredAiUsageEvents,
  loadUserAiSettings,
  recordAiUsageEvent,
  resolveAiAccess,
  USER_AI_SETTINGS_COLUMNS,
} from '../lib/ai-access.js'

// Same key pair the api-routes tests use, so encrypted_ai_key decrypts.
const ENCRYPTED_KEY = 'v1:KIPkC6p1Fvnv4KoVsu-dx-GNoEqmm2kStaExhNbptUJ3lrE'
const WORKER_ENCRYPTION_KEY = 'test-encryption-key-32-bytes-long!!'

const baseEnv = { WORKER_ENCRYPTION_KEY } as Parameters<typeof resolveAiAccess>[0]

function userSettings(overrides: Record<string, unknown> = {}) {
  return {
    ai_provider: 'openai',
    ai_base_url: null,
    ai_model: null,
    ai_vision_model: null,
    ai_thinking_level: null,
    encrypted_ai_key: ENCRYPTED_KEY,
    ...overrides,
  }
}

describe('resolveAiAccess', () => {
  it('returns null when neither the user nor the server has a key', async () => {
    const access = await resolveAiAccess(baseEnv, userSettings({ encrypted_ai_key: null }))
    expect(access).toBeNull()
  })

  it('falls back to the server key for users without their own', async () => {
    const access = await resolveAiAccess(
      {
        ...baseEnv,
        RUMAQ_SERVER_AI_PROVIDER: 'gemini',
        RUMAQ_SERVER_AI_KEY: 'sk-server',
        RUMAQ_SERVER_AI_MODEL: 'gemini-3.6-pro',
      },
      null
    )
    expect(access).toMatchObject({
      provider: 'gemini',
      apiKey: 'sk-server',
      model: 'gemini-3.6-pro',
      thinkingLevel: null,
      keySource: 'server',
    })
  })

  it('treats an invalid server provider as not configured instead of throwing at call time', async () => {
    expect(
      await resolveAiAccess(
        { ...baseEnv, RUMAQ_SERVER_AI_PROVIDER: 'geminiy', RUMAQ_SERVER_AI_KEY: 'sk-server' },
        null
      )
    ).toBeNull()
    // 'custom' needs a user-supplied base URL the server path never has.
    expect(
      await resolveAiAccess(
        { ...baseEnv, RUMAQ_SERVER_AI_PROVIDER: 'custom', RUMAQ_SERVER_AI_KEY: 'sk-server' },
        null
      )
    ).toBeNull()
  })

  it('keeps a valid thinking level and drops one outside the enum', async () => {
    const ok = await resolveAiAccess(baseEnv, userSettings({ ai_thinking_level: 'low' }))
    expect(ok?.thinkingLevel).toBe('low')

    const stale = await resolveAiAccess(baseEnv, userSettings({ ai_thinking_level: 'extreme' }))
    expect(stale?.thinkingLevel).toBeNull()
  })

  // Vision-model precedence (issue #433): explicit vision → user text model →
  // provider default; the server's model ONLY on the server-fallback branch.
  describe('vision model resolution', () => {
    it('prefers the explicit vision model over the text model', async () => {
      const access = await resolveAiAccess(
        baseEnv,
        userSettings({ ai_model: 'text-model', ai_vision_model: 'vision-model' })
      )
      expect(access?.visionModel).toBe('vision-model')
      // The text model is untouched — chat keeps using it.
      expect(access?.model).toBe('text-model')
    })

    it('falls back to the text model when no vision model is set', async () => {
      const access = await resolveAiAccess(baseEnv, userSettings({ ai_model: 'text-model' }))
      expect(access?.visionModel).toBe('text-model')
    })

    it('resolves to null (provider default) when the user set neither model', async () => {
      const access = await resolveAiAccess(baseEnv, userSettings())
      expect(access?.visionModel).toBeNull()
    })

    it('never leaks the server model into a user-keyed call', async () => {
      const access = await resolveAiAccess(
        {
          ...baseEnv,
          RUMAQ_SERVER_AI_PROVIDER: 'gemini',
          RUMAQ_SERVER_AI_KEY: 'sk-server',
          RUMAQ_SERVER_AI_MODEL: 'gemini-3.6-pro',
        },
        userSettings()
      )
      expect(access?.keySource).toBe('user')
      expect(access?.visionModel).toBeNull()
    })

    it('uses the server model for vision when the whole access falls back to the server key', async () => {
      const access = await resolveAiAccess(
        {
          ...baseEnv,
          RUMAQ_SERVER_AI_PROVIDER: 'gemini',
          RUMAQ_SERVER_AI_KEY: 'sk-server',
          RUMAQ_SERVER_AI_MODEL: 'gemini-3.6-pro',
        },
        null
      )
      expect(access?.keySource).toBe('server')
      expect(access?.visionModel).toBe('gemini-3.6-pro')
    })
  })
})

// The single settings loader (review T4-B3): the AI projection lives in ONE
// place, so a missed column cannot silently degrade to the provider default
// the way the seven hand-rolled SELECTs could.
describe('loadUserAiSettings', () => {
  function createDb(first: unknown) {
    const firstFn = vi.fn().mockResolvedValue(first)
    const bind = vi.fn().mockReturnValue({ first: firstFn })
    const prepare = vi.fn().mockReturnValue({ bind })
    return { db: { prepare } as unknown as D1Database, prepare, bind, firstFn }
  }

  it('selects exactly the owned AI projection and hands the row through', async () => {
    const row = {
      ai_provider: 'openai',
      ai_base_url: null,
      ai_model: 'gpt-5.1',
      ai_vision_model: 'vision-model',
      ai_thinking_level: 'low',
      encrypted_ai_key: 'enc',
    }
    const { db, prepare, bind, firstFn } = createDb(row)

    const settings = await loadUserAiSettings(db, 'u1')

    expect(prepare).toHaveBeenCalledWith(
      expect.stringContaining(`SELECT ${USER_AI_SETTINGS_COLUMNS} FROM user_settings`)
    )
    expect(bind).toHaveBeenCalledWith('u1')
    expect(firstFn).toHaveBeenCalled()
    expect(settings).toEqual(row)
  })

  it('returns null when the user has no settings row', async () => {
    const { db } = createDb(null)
    expect(await loadUserAiSettings(db, 'u2')).toBeNull()
  })
})

describe('recordAiUsageEvent', () => {
  function createEnv() {
    const run = vi.fn().mockResolvedValue(undefined)
    const bind = vi.fn().mockReturnValue({ run })
    const prepare = vi.fn().mockReturnValue({ bind })
    return {
      env: { DB: { prepare } } as unknown as Parameters<typeof recordAiUsageEvent>[0],
      prepare,
      bind,
    }
  }

  it('inserts one event row with ts, UTC date and the call details', async () => {
    const { env, prepare, bind } = createEnv()
    await recordAiUsageEvent(
      env,
      {
        userId: 'u1',
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        keySource: 'user',
        inputTokens: 900,
        outputTokens: 100,
        cachedTokens: 640,
      },
      new Date('2026-11-01T07:15:30.400Z')
    )

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO ai_usage_events'))
    expect(bind).toHaveBeenCalledWith(
      expect.any(String), // id
      'u1',
      '2026-11-01T07:15:30.400Z',
      '2026-11-01',
      'gemini',
      'gemini-3.6-flash',
      900,
      100,
      640,
      'user'
    )
  })

  it('records null cached tokens when the provider reports none', async () => {
    const { env, bind } = createEnv()
    await recordAiUsageEvent(
      env,
      {
        userId: 'u1',
        provider: 'openai',
        model: null,
        keySource: 'server',
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: null,
      },
      new Date('2026-11-01T23:59:59.000Z')
    )
    expect(bind).toHaveBeenCalledWith(
      expect.any(String),
      'u1',
      '2026-11-01T23:59:59.000Z',
      '2026-11-01',
      'openai',
      null,
      0,
      0,
      null,
      'server'
    )
  })
})

describe('deleteExpiredAiUsageEvents (1-year retention)', () => {
  function createEnv() {
    const run = vi.fn().mockResolvedValue(undefined)
    const bind = vi.fn().mockReturnValue({ run })
    const prepare = vi.fn().mockReturnValue({ bind })
    return {
      env: { DB: { prepare } } as unknown as Parameters<typeof deleteExpiredAiUsageEvents>[0],
      prepare,
      bind,
    }
  }

  it('deletes events strictly older than 365 days at the injected instant', async () => {
    const { env, prepare, bind } = createEnv()
    await deleteExpiredAiUsageEvents(env, new Date('2026-11-01T03:17:00.000Z'))

    expect(prepare).toHaveBeenCalledWith('DELETE FROM ai_usage_events WHERE ts < ?')
    expect(bind).toHaveBeenCalledWith('2025-11-01T03:17:00.000Z')
  })
})
