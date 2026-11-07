// Shared AI-usage display model. Usage is recorded but never capped — the daily
// limit was removed unconditionally (issue #353) and #523 P3 retired the last
// source distinction: every call is funded by the household's own provider key
// (D9). Every surface shows call counts and the token totals the provider
// reports; no limit, percent, warn or danger is ever fabricated.
//
// #523 P4: the payload is cut by CAPABILITY (decision / reasoning / vision) and
// carries the household total beside the member's own. There is no single
// `provider` any more: each capability may point at a different row, so naming
// one would be a guess. A typed (`questions`) provider reports no tokens, so
// those calls are counted and shown as "not token-billed" instead of as a
// misleading zero (plan §5.3).

// Compact token counts: 950 → "950", 18230 → "18.2k", 234500 → "235k".
export function formatTokens(n) {
  const v = Number(n) || 0
  if (v < 1000) return String(v)
  if (v < 100000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(v / 1000)}k`
}

function tokenTotals(row) {
  return {
    used: row?.used ?? 0,
    inputTokens: row?.input_tokens ?? 0,
    outputTokens: row?.output_tokens ?? 0,
  }
}

// One model for every usage surface (Settings meter). Returns null without
// loaded data so callers can render nothing instead of misreporting a mock as
// real usage.
export function usageMeterModel(usage) {
  if (!usage) return null
  const cachedTokens = usage.cached_tokens ?? null
  const inputTokens = usage.input_tokens ?? 0
  const capabilities = (usage.capabilities ?? []).map((row) => ({
    // null = pre-gateway history: its capability was never recorded.
    capability: row.capability ?? null,
    calls: row.used ?? 0,
    typedCalls: row.typed_calls ?? 0,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
  }))
  return {
    ...tokenTotals(usage),
    // Mirrors the backend cache_hit_rate: cached/input, null when nothing
    // was recorded or the provider reported no cache data — unknown, not 0.
    cacheHitRate: cachedTokens === null || inputTokens <= 0 ? null : cachedTokens / inputTokens,
    capabilities,
    household: usage.household ? tokenTotals(usage.household) : null,
  }
}

// 0.42 → "42%"; null → null so callers render "—" instead of a fabricated 0%.
export function formatCacheRate(rate) {
  if (rate == null) return null
  return `${Math.round(rate * 100)}%`
}
