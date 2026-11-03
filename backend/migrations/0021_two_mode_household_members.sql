-- Two-mode household members (ahaqqu/RumaQ#388 — the document vault's
-- dependency). Today every member IS a user account (Mode A). Mode B adds
-- profile-only members — a toddler, a grandparent without a phone — identified
-- by display_name (+ optional birth_date), with NO user account: they never
-- authenticate, never appear in auth resolution, and are attachable to a real
-- account later WITHOUT data loss (the vault's documents will hang off the
-- member row, so the row must keep its identity when an account is linked).
--
-- SQLite cannot DROP a PK column or alter NOT NULL, so this is the standard
-- create-new / copy / rename rebuild (0015 precedent). Three changes:
--
-- 1) Surrogate PK `id` (random 32-hex, backfilled below). Every per-member
--    surface (vault documents, profile editing, removal) addresses the MEMBER,
--    not the login. Profile-only rows have no user_id to key on, so the
--    addressable handle must exist before Mode B does.
-- 2) `user_id` becomes NULLABLE — NULL = profile-only member. The FK and the
--    ON DELETE CASCADE to users stay (a deleted account still removes its
--    memberships). The auth middleware's COALESCE resolution matches on
--    `user_id = ?`, so a NULL row can never authenticate — unchanged SQL.
-- 3) Uniqueness is re-established as the guardrails require: a PARTIAL unique
--    index on (household_id, user_id) WHERE user_id IS NOT NULL keeps the old
--    PK pair's guarantee for linked members (one row per account per
--    household) while leaving profile-only rows (NULL user_id) unrestricted —
--    a household may have several account-less people.
--
-- Indexes are rebuilt with the table (a rename-away drops the old ones):
-- idx_household_members_user is recreated COLUMN-FOR-COLUMN — the auth
-- middleware's fallback resolution, listHouseholds, and the departure batch
-- seek through it (0020's EXPLAIN QUERY PLAN proof in migrations.test.ts
-- still runs against it, so the fast path cannot silently regress). The old
-- PK's (household_id, ...) prefix also served per-household scans (roster,
-- owner counts, member_count subquery); the partial index above does NOT
-- cover those — a partial index is only usable when the query provably
-- implies its WHERE clause, and `household_id = ?` does not imply
-- `user_id IS NOT NULL` — so a plain household index keeps those seeks.
CREATE TABLE household_members_two_mode (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  display_name TEXT,
  birth_date TEXT
);

-- Backfill the surrogate id for every existing (linked) member row.
INSERT INTO household_members_two_mode
  (id, household_id, user_id, role, joined_at, display_name, birth_date)
SELECT lower(hex(randomblob(16))),
       household_id,
       user_id,
       role,
       joined_at,
       display_name,
       birth_date
  FROM household_members;

DROP TABLE household_members;
ALTER TABLE household_members_two_mode RENAME TO household_members;

-- Old PK pair's uniqueness, linked members only (see note 3 above).
CREATE UNIQUE INDEX IF NOT EXISTS idx_household_members_household_user
  ON household_members(household_id, user_id) WHERE user_id IS NOT NULL;

-- 0020's index, recreated exactly (user_id, joined_at, household_id) — the
-- auth fallback's ORDER BY joined_at, household_id rides it.
CREATE INDEX IF NOT EXISTS idx_household_members_user
  ON household_members(user_id, joined_at, household_id);

-- Per-household scans the old PK prefix used to serve (roster listing,
-- countOwners, the member_count subquery, the departure DELETE).
CREATE INDEX IF NOT EXISTS idx_household_members_household
  ON household_members(household_id, joined_at);
