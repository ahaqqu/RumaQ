-- Document expiry & renewal reminders (ahaqqu/RumaQ#426): identity and
-- ownership documents (KTP, passport, STNK, insurance policies, warranties)
-- carry validity dates, and the household needs a due-soon view instead of
-- anyone remembering to check. Expiry is METADATA on the document — the
-- free-text naming of #422 and the multi-file model stay untouched (no
-- category revival).
--
-- DEFAULT CHOICE — remind_days_before defaults at the APP layer, not via a
-- column DEFAULT. The default is conditional ("30 when expires_on is set"),
-- which a column DEFAULT cannot express (it fires on every INSERT omitting
-- the column regardless of expiry), and the app's PATCH path is the only
-- writer and always names both columns together — one code path, one rule
-- (lib/documents.ts). This matches the codebase precedent: column DEFAULTs
-- are timestamps/simple counters (created_at, uploaded_at, session_epoch);
-- conditional business defaults live in the lib. The invariant the app
-- maintains: expires_on non-null ⇒ remind_days_before non-null; the read
-- side additionally treats a NULL window on an expiry row as the 30 default,
-- so a hand-edited row cannot break the due-soon math.
--
-- Both columns are nullable TEXT/INTEGER adds (the 0020 birth_date shape —
-- SQLite has no native DATE; dates are ISO YYYY-MM-DD text). No backfill:
-- every pre-#426 document simply has no expiry until someone sets one.
ALTER TABLE documents ADD COLUMN expires_on TEXT;
ALTER TABLE documents ADD COLUMN remind_days_before INTEGER;

-- The expiring_within filter (list endpoint) seeks the household's
-- expiry-bearing rows: WHERE household_id = ? AND expires_on IS NOT NULL
-- AND expires_on <= ? ORDER BY expires_on. (household_id, expires_on) serves
-- the whole filter in one seek; the existing idx_documents_household keeps
-- serving the default newest-first listing, which this index does not disturb.
CREATE INDEX IF NOT EXISTS idx_documents_household_expiry
  ON documents(household_id, expires_on);

-- The audit vocabulary grows with the operation (#426): metadata edits (the
-- PATCH expiry flow) write 'update' records like every other document
-- mutation. SQLite cannot ALTER a CHECK, so document_audit rebuilds around
-- the widened one; every existing row copies over verbatim. The FK-less
-- design survives unchanged (0025 note): document_id and document_file_id
-- are plain TEXT handles, so deletion records outlive the rows they name.
CREATE TABLE document_audit_new (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (
    action IN ('upload', 'view', 'download', 'delete', 'file_add', 'file_delete', 'update')
  ),
  document_file_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO document_audit_new
  (id, document_id, household_id, actor_user_id, action, document_file_id, created_at)
  SELECT id, document_id, household_id, actor_user_id, action, document_file_id, created_at
    FROM document_audit;

DROP TABLE document_audit;
ALTER TABLE document_audit_new RENAME TO document_audit;

CREATE INDEX IF NOT EXISTS idx_document_audit_document
  ON document_audit(document_id, created_at);
CREATE INDEX IF NOT EXISTS idx_document_audit_household
  ON document_audit(household_id, created_at);
