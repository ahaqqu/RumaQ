-- Household member management (ahaqqu/RumaQ#331): two additive steps.
--
-- 1) Per-member profile fields on household_members. Members must become
--    stable, addressable entities so per-member product surfaces can attach
--    later WITHOUT schema surgery — ahaqqu/BayiQ (a SEPARATE repo/deployable;
--    never integrated here) will read age-shaped data (e.g. an immunization
--    chart), so birth_date rides the membership row now. Both columns are
--    nullable and additive: existing rows keep NULL and nothing backfills —
--    the household screen owns collecting them. display_name is per-membership
--    (the name this person goes by INSIDE the household) on purpose; users.name
--    stays the login identity. Dates are TEXT 'YYYY-MM-DD' like stock
--    .expiry_date (SQLite has no native DATE).
ALTER TABLE household_members ADD COLUMN display_name TEXT;
ALTER TABLE household_members ADD COLUMN birth_date TEXT;

-- 2) Owner-issued invite codes. One row per generated code; joining inserts a
--    household_members row and (for v1) the code itself is stored — codes are
--    10 chars of ~50 bits entropy from an unambiguous alphabet, expire after
--    7 days, and redemption is rate-limited, so the window a leaked code is
--    live is bounded. A code is revealed to its owner repeatedly (GET
--    /households/:id/invite), which a hash-only store cannot serve; rotating
--    revokes the previous rows via revoked_at, so old links die on rotate.
--    Lookup rides the UNIQUE code index; expires_at/revoked_at are checked in
--    the join query, never trusted client-side.
CREATE TABLE IF NOT EXISTS household_invites (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_household_invites_household
  ON household_invites(household_id);
