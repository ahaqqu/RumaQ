// Shared AI-usage display model. The daily request cap only applies to
// RumaQ's shared server key; a user's own key is unmetered — what matters
// for them is the token count their provider subscription bills.

// Compact token counts: 950 → "950", 18230 → "18.2k", 234500 → "235k".
export function formatTokens(n) {
  const v = Number(n) || 0
  if (v < 1000) return String(v)
  if (v < 100000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(v / 1000)}k`
}

export function usageState(u) {
  const pct = Math.min(100, Math.round((u.used / u.limit) * 100))
  const remaining = Math.max(0, u.limit - u.used)
  const warn = u.used >= Math.round(u.limit * 0.8) && u.used < u.limit
  const danger = u.used >= u.limit
  return { pct, remaining, warn, danger }
}

// One model for every usage surface (sidebar, Settings meter, Assistant):
// server-key usage gets the cap meter, own-key usage the token counts.
// Returns null without loaded data so callers can render nothing instead of
// misreporting a mock as real usage.
export function usageMeterModel(usage) {
  if (!usage) return null
  const ownKey = usage.key_source === 'user'
  const limit = usage.limit ?? usage.daily_limit ?? 20
  return {
    ownKey,
    used: usage.used,
    limit,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...usageState({ used: usage.used, limit }),
  }
}
