/**
 * "Can this feature call AI?" — the honest replacement for the retired
 * `has_ai_key` / `server_ai_available` settings fields (ahaqqu/RumaQ#523 P3).
 *
 * The legacy fields described the ONE per-user key; both are gone with the
 * columns migration 0042 drops and the platform key D8 retired. The API reports
 * one status per capability: `ai_status[capability] === 'household'` means a
 * call would reach a provider row the household owns, `'none'` means 402.
 *
 * #523 P4: each call site routes by ONE capability, so the predicate asks about
 * that capability and nothing else. Chat and shopping plans are `reasoning`
 * calls — the default here — and the UI must not claim "AI is set up" because
 * some OTHER capability is configured (the P3 review A3 lie, one dimension
 * over). The review screen reads its own `aiConfigured` from the review-mode
 * payload, which the backend answers for `decision`.
 */
export function isAiConfigured(status, capability = 'reasoning') {
  if (!status) return false
  return status[capability] === 'household'
}
