-- Link-later (ahaqqu/RumaQ#397): owner-marked invites. An owner can generate
-- an invite FOR one profile-only member (user_id NULL, #388); redeeming it
-- then ATTACHES the redeemer's account to that existing household_members row
-- instead of inserting a new one — display_name/birth_date and the surrogate
-- id survive, so the vault's documents (keyed by member id, 0022) stay
-- attached through the link.
--
-- Additive nullable column (no table rebuild): existing invites keep NULL,
-- which IS the plain-invite marker — the join path branches on it and stays
-- byte-identical for unmarked codes. The FK references the member row with
-- ON DELETE CASCADE — a pending invite is TRANSIENT data (a code waiting to
-- be redeemed), so when the member it names is removed the invite is dead
-- weight and dies with them. That is the opposite call from 0022's
-- documents.member_id ON DELETE SET NULL: a document outlives the member (the
-- household still owns it, and a D1 cascade cannot reach the R2 bytes), while
-- an unredeemed invite for a member who no longer exists must never survive
-- to attach a redeemer to a ghost row.
ALTER TABLE household_invites
  ADD COLUMN target_member_id TEXT REFERENCES household_members(id) ON DELETE CASCADE;
