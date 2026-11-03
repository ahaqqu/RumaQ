-- Household member management (ahaqqu/RumaQ#331, thermos review pass): three
-- additive steps.
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

-- 2) user_id index on the membership table (review A1). The PK is
--    (household_id, user_id), so user_id-only lookups — the auth middleware's
--    fallback resolution (every request of a user whose active pointer is
--    NULL/stale), listHouseholds, and the leave/remove remaining-check — were
--    full scans with a temp B-tree sort. This index turns all three into
--    seeks and kills the sort (its column order matches the fallback's
--    ORDER BY joined_at, household_id). Verified against EXPLAIN QUERY PLAN
--    in migrations.test.ts so the fast path cannot silently regress.
CREATE INDEX IF NOT EXISTS idx_household_members_user
  ON household_members(user_id, joined_at, household_id);

-- 3) Owner-issued invite codes. One row per generated code; joining inserts a
--    household_members row and the lookup rides the code_hash index.
--    At-rest hardening (review A8): the code itself is NEVER stored — the row
--    keeps a deterministic SHA-256 hash for the join lookup (normalized code,
--    so case/spacing presentation never breaks the match) plus the AES-GCM
--    ciphertext (WORKER_ENCRYPTION_KEY, encryptAiKey precedent) so the owner
--    screen can still reveal the current code. A DB/backup leak now yields
--    neither usable codes nor their hashes' preimages. expires_at and
--    revoked_at are checked in the join query, never trusted client-side;
--    rotation revokes previous rows.
CREATE TABLE IF NOT EXISTS household_invites (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  code_encrypted TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_household_invites_household
  ON household_invites(household_id);
