// Shared AI-usage display model. Usage is recorded but never capped — the
// daily limit was removed unconditionally (issue #353): BYOK is the norm and
// the shared server key is uncapped too. Every surface shows call counts and
// the token totals the provider reports; no limit, percent, warn or danger is
// ever fabricated.

// Compact token counts: 950 → "950", 18230 → "18.2k", 234500 → "235k".
export function formatTokens(n) {
  const v = Number(n) || 0
  if (v < 1000) return String(v)
  if (v < 100000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(v / 1000)}k`
}

// One model for every usage surface (Settings meter, Assistant). Returns
// null without loaded data so callers can render nothing instead of
// misreporting a mock as real usage.
export function usageMeterModel(usage) {
  if (!usage) return null
  const cachedTokens = usage.cached_tokens ?? null
  const inputTokens = usage.input_tokens ?? 0
  return {
    ownKey: usage.key_source === 'user',
    used: usage.used ?? 0,
    inputTokens,
    outputTokens: usage.output_tokens ?? 0,
    // Mirrors the backend cache_hit_rate: cached/input, null when nothing
    // was recorded or the provider reported no cache data — unknown, not 0.
    cacheHitRate: cachedTokens === null || inputTokens <= 0 ? null : cachedTokens / inputTokens,
  }
}

// 0.42 → "42%"; null → null so callers render "—" instead of a fabricated 0%.
export function formatCacheRate(rate) {
  if (rate == null) return null
  return `${Math.round(rate * 100)}%`
}
