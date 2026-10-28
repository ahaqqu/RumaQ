import type { Env } from '../types.js'
import type { ThinkingLevel } from './ai.js'
import { decryptAiKey } from './crypto.js'

export type UserAiSettings = {
  ai_provider: string | null
  ai_base_url: string | null
  ai_model: string | null
  ai_thinking_level: string | null
  encrypted_ai_key: string | null
}

export type AiAccess = {
  provider: string
  apiKey: string
  baseUrl: string | null
  model: string | null
  thinkingLevel: ThinkingLevel | null
  // 'user' = the caller's own key (no daily cap); 'server' = RumaQ's shared
  // key, which is the only path the daily limit applies to.
  keySource: 'user' | 'server'
}

// Providers the server key can serve. 'custom' is excluded: it requires a
// user-supplied base URL the server key path never has.
const SERVER_PROVIDER_PRESETS: ReadonlySet<string> = new Set([
  'opencode',
  'openai',
  'anthropic',
  'gemini',
  'ollama',
])

const THINKING_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high'])

function normalizeThinkingLevel(value: string | null): ThinkingLevel | null {
  return value && THINKING_LEVELS.has(value) ? (value as ThinkingLevel) : null
}

// Resolve which provider credentials serve this request. The user's own
// stored key always wins; the server-provided key is a limited fallback for
// users who have not configured one.
export async function resolveAiAccess(
  env: Env['Bindings'],
  settings: UserAiSettings | null
): Promise<AiAccess | null> {
  if (settings?.ai_provider && settings?.encrypted_ai_key) {
    return {
      provider: settings.ai_provider,
      apiKey: await decryptAiKey(settings.encrypted_ai_key, env.WORKER_ENCRYPTION_KEY),
      baseUrl: settings.ai_base_url ?? null,
      model: settings.ai_model ?? null,
      thinkingLevel: normalizeThinkingLevel(settings.ai_thinking_level),
      keySource: 'user',
    }
  }

  const serverProvider = env.RUMAQ_SERVER_AI_PROVIDER
  const serverKey = env.RUMAQ_SERVER_AI_KEY
  // An invalid provider (typo, or 'custom' with no base URL) must degrade to
  // 'not configured' (402), not throw at call time (502) on every AI route.
  if (serverProvider && serverKey && SERVER_PROVIDER_PRESETS.has(serverProvider)) {
    return {
      provider: serverProvider,
      apiKey: serverKey,
      baseUrl: null,
      model: env.RUMAQ_SERVER_AI_MODEL ?? null,
      thinkingLevel: null,
      keySource: 'server',
    }
  }

  return null
}

export type AiUsageRow = {
  id: string
  used: number
  daily_limit: number
}

// Fetch today's usage counter for the user, creating a zeroed row on first
// use. The daily_limit column only gates server-key traffic; user keys are
// uncapped.
export async function getOrCreateAiUsage(
  env: Env['Bindings'],
  userId: string,
  provider: string
): Promise<AiUsageRow> {
  const today = new Date().toISOString().slice(0, 10)
  const existing = await env.DB.prepare(
    'SELECT id, used, daily_limit FROM ai_usage WHERE user_id = ? AND date = ?'
  )
    .bind(userId, today)
    .first<AiUsageRow>()

  if (existing) return existing

  const id = crypto.randomUUID()
  await env.DB.prepare(
    'INSERT INTO ai_usage (id, user_id, date, provider, used, daily_limit) VALUES (?, ?, ?, ?, 0, 20)'
  )
    .bind(id, userId, today, provider)
    .run()
  return { id, used: 0, daily_limit: 20 }
}

export function isAiUsageLimited(access: AiAccess, usage: AiUsageRow): boolean {
  return access.keySource === 'server' && usage.used >= usage.daily_limit
}

// Persist one call's metered usage against today's row. `requests` stays
// success-only (callers omit it on the provider-error path); tokens are
// recorded whenever the provider reported them, error or not — the key
// owner is billed for failed calls too.
export async function recordAiUsage(
  env: Env['Bindings'],
  usageRow: { id: string },
  delta: { requests?: number; inputTokens?: number; outputTokens?: number }
): Promise<void> {
  await env.DB.prepare(
    'UPDATE ai_usage SET used = used + ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?'
  )
    .bind(delta.requests ?? 0, delta.inputTokens ?? 0, delta.outputTokens ?? 0, usageRow.id)
    .run()
}
