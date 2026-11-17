import { ApiError } from './api'

// Audit 2026-11-16 L5/L4: the error panels used to describe every failure as
// "offline" (offline.banner) — a 500 sent the user hunting for a network
// problem they don't have. M1's classifier (lib/api.ts) names the outcome;
// this maps each kind to its one i18n key so every error surface speaks the
// same three sentences (en+id): offline, timeout, server.
export function errorKindKey(error) {
  const kind = error instanceof ApiError ? error.kind : 'http'
  if (kind === 'offline') return 'error.offline'
  if (kind === 'timeout') return 'error.timeout'
  return 'error.http'
}
