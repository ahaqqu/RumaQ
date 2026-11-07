/**
 * "Is this household able to call AI?" — the honest replacement for the retired
 * `has_ai_key` / `server_ai_available` settings fields (ahaqqu/RumaQ#523 P3).
 *
 * The legacy fields described the ONE per-user key; both are gone with the
 * columns migration 0042 drops and the platform key D8 retired. What the API
 * reports now is per capability: `ai_status[capability] === 'household'` means a
 * call would reach a provider row the household owns, `'none'` means 402.
 *
 * Until P4 routes each call site by capability, the backend's compatibility
 * bridge resolves reasoning → decision → vision (lib/ai/legacy.ts), so this
 * predicate mirrors that ladder rather than pretending a stricter rule.
 */
export function isAiConfigured(status) {
  if (!status) return false
  return (
    status.reasoning === 'household' ||
    status.decision === 'household' ||
    status.vision === 'household'
  )
}
