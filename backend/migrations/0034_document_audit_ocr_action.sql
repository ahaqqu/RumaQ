-- Vault expiry OCR audit (ahaqqu/RumaQ#433, review T4-A1): reading a file's
-- bytes to send them to the user's AI provider is a byte access like any
-- other vault read — it must leave a durable document_audit row tied to the
-- document (and file), not just the ephemeral outcome log line and the
-- document-blind ai_usage_events row (which carries no document reference).
-- 'ocr' is its own action, NOT 'view': a view is a human previewing bytes in
-- the household; an OCR read ships those bytes to a third party — exactly the
-- distinction the shared-household audit trail exists to preserve.
--
-- SQLite cannot ALTER a CHECK, so document_audit rebuilds around the widened
-- one (the 0026 shape, one more action); every existing row copies over
-- verbatim. The FK-less design survives unchanged: document_id and
-- document_file_id stay plain TEXT handles so audit rows outlive the rows
-- they name.
CREATE TABLE document_audit_new (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (
    action IN ('upload', 'view', 'download', 'delete', 'file_add', 'file_delete', 'update', 'ocr')
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
