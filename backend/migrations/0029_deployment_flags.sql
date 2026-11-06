-- Deployment availability flags (ahaqqu/RumaQ#435 — plugin architecture phase
-- A, docs/plan/plugin-architecture.md §3.3/§4.6/§8.6): the ops kill-switch is
-- DATA, not config — a flag in cloudflare.config.ts is a PR plus a deploy,
-- which is the wrong latency for the incident it exists to handle (e.g.
-- pausing the vault during a DokumenQ cutover). One tiny key/value table,
-- read once per isolate with a ≤30 s cache (backend/src/plugins/flags.ts);
-- cloudflare.config.ts carries no flag state.
--
-- NUMBERING NOTE: 0027 is RESERVED for the in-flight #429 task-assignments
-- branch; this file takes 0029 (0028 is household_plugins, same ticket).
--
-- FAIL-OPEN on a read error and on an absent key (an availability posture —
-- a flags outage must never take the vault down). This is the deliberate
-- OPPOSITE of household enablement (0028), which fails CLOSED (a privacy
-- posture). The two postures are documented where each is read and must
-- never be unified (plan §3.3).
CREATE TABLE IF NOT EXISTS deployment_flags (
  -- Dotted key shape: 'plugin.<id>.available' (plugins/flags.ts owns the
  -- construction). Free-form TEXT key: other ops flags land here without a
  -- migration. Absent key = available; value 'off' = unavailable.
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK (value IN ('on', 'off')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
