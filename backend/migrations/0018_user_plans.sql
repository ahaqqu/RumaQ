-- Premium gating hooks (ahaqqu/RumaQ#376): per-user plan assignment backing
-- backend/src/lib/entitlements.ts. Additive and writer-less tonight — no
-- route assigns a plan yet (future product ticket), so every user resolves
-- to 'free', which carries every entitlement shipped so far. plan stays
-- free-form TEXT (no CHECK) so a future plan enum can grow without another
-- migration; unknown values resolve to 'free' in resolvePlan.
CREATE TABLE IF NOT EXISTS user_plans (
  user_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free',
  updated_at TEXT
);
