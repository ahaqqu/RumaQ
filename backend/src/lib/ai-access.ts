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
  // 'user' = the caller's own stored key; 'server' = RumaQ's shared key.
  // Recorded for analytics (ai_usage_events) either way — neither source is
  // capped: BYOK is the norm, and the shared key is uncapped too (issue #353).
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
// stored key always wins; the server-provided key is a fallback for users
// who have not configured one.
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

export type AiUsageEvent = {
  userId: string
  provider: string | null
  // The model configured for the call; null means the provider default applied.
  model: string | null
  keySource: 'user' | 'server' | null
  inputTokens: number
  outputTokens: number
  // null when the provider reported no cached-token figure.
  cachedTokens: number | null
}

// Persist one completed AI call as its own event row. Usage is recorded for
// analytics only — it never gates a call (the daily cap was removed #353).
// `now` is injectable so tests can pin ts/date.
export async function recordAiUsageEvent(
  env: Env['Bindings'],
  event: AiUsageEvent,
  now: Date = new Date()
): Promise<void> {
  const ts = now.toISOString()
  await env.DB.prepare(
    `INSERT INTO ai_usage_events
       (id, user_id, ts, date, provider, model, input_tokens, output_tokens, cached_tokens, key_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      event.userId,
      ts,
      ts.slice(0, 10),
      event.provider,
      event.model,
      event.inputTokens,
      event.outputTokens,
      event.cachedTokens,
      event.keySource
    )
    .run()
}

// Usage records are deleted after one year (issue #353). Invoked daily by the
// Worker's scheduled handler (cron in cloudflare.config.ts); `now` is
// injectable so tests can exercise the boundary exactly.
export async function deleteExpiredAiUsageEvents(
  env: Env['Bindings'],
  now: Date = new Date()
): Promise<void> {
  const cutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)
  await env.DB.prepare('DELETE FROM ai_usage_events WHERE ts < ?').bind(cutoff.toISOString()).run()
}
