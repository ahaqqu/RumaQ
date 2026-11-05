-- Session-epoch logout revocation (ahaqqu/RumaQ#405, owner decision: option 2
-- — per-user session epoch). Logout bumps this counter; the auth middleware
-- compares the epoch signed into the JWT against it in the same single indexed
-- lookup as the active-household resolution (backend/src/auth.ts), so a stale
-- token — a stolen cookie that survived the cookie clear — fails closed.
--
-- Additive column with a hard default: every existing user starts at epoch 0,
-- which is exactly what tokens minted before the claim existed (no epoch
-- claim) and every invite-created account compare equal to. No backfill, no
-- table rebuild. Monotonically increasing per logout, never reset — a re-login
-- mints a token carrying the CURRENT epoch, so bump-then-relogin invalidates
-- only the sessions issued before the logout (logout-everywhere semantics for
-- a family app where one shared device can end everyone's stale sessions).
ALTER TABLE users
  ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;
