-- Admin flag on the user row (issue #315): operator-only surfaces
-- (requireAdmin) read users.is_admin instead of the former email-allowlist
-- Worker secret, so grant/revoke is a one-statement SQL runbook and the flag
-- can never drift from the deploy environment (issue #314). SQLite boolean
-- convention (log_truncated in 0012, flag_count in 0013): 1 = admin,
-- 0 = regular user; new signups omit the column and default to 0.

ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- One-time provisioning of the two known admins, backfilled in the SAME
-- migration so the schema change and the grants land atomically (a separate
-- manual step would re-create the #314 failure window: deploy goes live
-- before the grant runs). Grant/revoke runbook for future admins — no
-- redeploy needed, the flag is read per-request:
--   cf d1 execute rumaq --remote --command \
--     "UPDATE users SET is_admin = 1 WHERE email = '…';"
UPDATE users SET is_admin = 1
WHERE email IN ('angga.haqqu@gmail.com', 'admin@rumaq.ahaqqu.com');
