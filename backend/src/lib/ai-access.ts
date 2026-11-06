import type { Env } from '../types.js'
import type { ThinkingLevel } from './ai.js'
import { decryptAiKey } from './crypto.js'

export type UserAiSettings = {
  ai_provider: string | null
  ai_base_url: string | null
  ai_model: string | null
  // Explicit vision model (0030, issue #433) — the vault's document OCR uses
  // it INSTEAD of ai_model when set. Same charset as ai_model.
  ai_vision_model: string | null
  ai_thinking_level: string | null
  encrypted_ai_key: string | null
}

export type AiAccess = {
  provider: string
  apiKey: string
  baseUrl: string | null
  model: string | null
  // The resolved vision model for vision work (document OCR): the user's
  // explicit ai_vision_model, else their ai_model, else — only on the server
  // fallback branch — the server's model. null = the provider default applies.
  // Never mixes the server's model name into a user-keyed call: a model id is
  // provider-specific, and the server's choice may not exist on the user's
  // provider (nor should it leak there).
  visionModel: string | null
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

// Stored model ids are trimmed at the settings PATCH, so '' never persists;
// the trim here is defense against hand-edited rows, matching the way the
// callers re-trim before sending (ai.ts's `opts?.model?.trim()`).
function normalizeModel(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
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
      model: normalizeModel(settings.ai_model),
      // Vision precedence (issue #433): explicit vision model → the text
      // model → null (the provider default applies). The server's model is
      // deliberately NOT a third step here — see AiAccess.visionModel.
      visionModel: normalizeModel(settings.ai_vision_model) ?? normalizeModel(settings.ai_model),
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
      model: normalizeModel(env.RUMAQ_SERVER_AI_MODEL),
      // No separate server vision model: the fallback key serves one model
      // for text and vision alike.
      visionModel: normalizeModel(env.RUMAQ_SERVER_AI_MODEL),
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
