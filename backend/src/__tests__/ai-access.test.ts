import { describe, it, expect } from 'vite-plus/test'
import { isAiUsageLimited, resolveAiAccess } from '../lib/ai-access.js'

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

describe('isAiUsageLimited', () => {
  const access = (keySource: 'user' | 'server') => ({
    provider: 'openai',
    apiKey: 'sk-test',
    baseUrl: null,
    model: null,
    thinkingLevel: null,
    keySource,
  })
  const exceeded = { id: 'usage-1', used: 20, daily_limit: 20 }
  const under = { id: 'usage-1', used: 3, daily_limit: 20 }

  it('caps server-key traffic once the daily limit is reached', () => {
    expect(isAiUsageLimited(access('server'), exceeded)).toBe(true)
    expect(isAiUsageLimited(access('server'), under)).toBe(false)
  })

  it('never caps user-key traffic', () => {
    expect(isAiUsageLimited(access('user'), exceeded)).toBe(false)
    expect(isAiUsageLimited(access('user'), under)).toBe(false)
  })
})
