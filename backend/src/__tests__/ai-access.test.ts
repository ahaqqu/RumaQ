import { describe, it, expect, vi } from 'vite-plus/test'
import {
  deleteExpiredAiUsageEvents,
  recordAiUsageEvent,
  resolveAiAccess,
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
