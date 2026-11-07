// Usage accounting beside the door (ahaqqu/RumaQ#523, plan §5.3). Moved out of
// lib/ai-access.ts in P1 so the writer and the resolver have one owner each.
//
// One row per provider call, on failure too, now stamped with the dimensions
// D1/D9 need: `capability`, the household that paid (`household_id`), and the
// funding source (`funding`). `key_source` is deliberately no longer written —
// D9 replaced it; historical rows keep their values (the column stays).
//
// Usage never gates a call: there is no limiter, no quota and no daily cap
// (issue #353, plan §2.6). A future platform-funded meter lives inside the
// door, never here.

import type { Env } from '../../types.js'
import type { AiCall, TokenUsage } from './types.js'

/**
 * Accumulate provider-reported usage into a caller-owned total across calls.
 * Unreported cache figures leave the running total as-is, so a series with no
 * cache data at all stays null. Moved here from the deprecated shim in P2: it
 * is usage arithmetic, not provider transport.
 */
export function usageCollector(target: TokenUsage): (usage: TokenUsage) => void {
  return (usage) => {
    target.input_tokens += usage.input_tokens
    target.output_tokens += usage.output_tokens
    if (usage.cached_tokens !== null) {
      target.cached_tokens = (target.cached_tokens ?? 0) + usage.cached_tokens
    }
  }
}

export type AiUsageEvent = {
  /** The ACTING member: attribution, not ownership. */
  userId: string
  /** What was called and who paid — resolved once, reused for the row. */
  call: AiCall
  usage: TokenUsage
}

/**
 * The usage-event INSERT as a STATEMENT. One row per call is the rule, but a
 * bounded fan-out (the review sweep) batches its attempts into ONE db.batch so
 * the whole tick costs one subrequest instead of one per item — each statement
 * counts against the free plan's 50-subrequest invocation cap.
 */
export function buildAiUsageEventStatement(
  env: Env['Bindings'],
  event: AiUsageEvent,
  now: Date = new Date()
): ReturnType<D1Database['prepare']> {
  const ts = now.toISOString()
  return env.DB.prepare(
    `INSERT INTO ai_usage_events
       (id, user_id, ts, date, provider, model, capability, household_id, funding,
        input_tokens, output_tokens, cached_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    event.userId,
    ts,
    ts.slice(0, 10),
    // The provider column keeps today's meaning: the WIRE KIND, not the vendor.
    event.call.providerKind,
    // The model actually sent; null = the adapter default applied.
    event.call.model,
    event.call.capability,
    event.call.householdId,
    event.call.funding,
    event.usage.input_tokens,
    event.usage.output_tokens,
    event.usage.cached_tokens
  )
}

export async function recordAiUsageEvent(
  env: Env['Bindings'],
  event: AiUsageEvent,
  now: Date = new Date()
): Promise<void> {
  await buildAiUsageEventStatement(env, event, now).run()
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
