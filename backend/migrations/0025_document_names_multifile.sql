-- Document vault rework (ahaqqu/RumaQ#422): free-text document names replace
-- the preset category list, and one document groups N files (KTP front + back,
-- buku nika pages 1-10). The three locked owner decisions (2026-11-05):
--   1. the per-file free-text label is OPTIONAL (NULL allowed),
--   2. the list's category filter becomes a NAME search,
--   3. max 20 files per document.
--
-- The documents table REBUILDS rather than ALTERs: SQLite cannot drop a
-- column, and the category CHECK must go with the preset list it described —
-- no remnant anywhere in the schema. `name` arrives NOT NULL (trimmed 1-120
-- chars, app-enforced) and is backfilled from the old category's human
-- (EN locale) label — readable, and the owner can rename freely afterwards.
--
-- Ordering matters: document_files (below) references documents(id), so the
-- legacy per-document file metadata is mirrored FIRST (dropping `documents`
-- would otherwise take the only copy of it), then the rebuild, then the file
-- rows are minted from the mirror. R2 bytes are NOT moved or re-uploaded: the
-- migrated file reuses the document's existing storage key
-- (documents/<household>/<document_id>) as attachment #1 of its document.
CREATE TABLE documents_legacy_files (
  document_id TEXT PRIMARY KEY NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  -- The document's creation time becomes the migrated file's uploaded_at —
  -- that IS when the bytes went up.
  created_at TEXT NOT NULL
);

INSERT INTO documents_legacy_files
  (document_id, file_name, mime_type, size_bytes, storage_key, sha256, uploaded_by, created_at)
  SELECT id, file_name, mime_type, size_bytes, storage_key, sha256, uploaded_by, created_at
    FROM documents;

CREATE TABLE documents_new (
  -- Same shape as 0022 minus the per-file columns (they moved into
  -- document_files), plus the free-text name. Dashed UUID at runtime
  -- (lib/documents.ts); TEXT PK NOT NULL per the 0021 note — on rowid tables
  -- a TEXT PRIMARY KEY does NOT imply NOT NULL.
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  -- The member the document belongs to (the vault filter's target). Nullable:
  -- household-level documents (kartu keluarga) have no single person. A
  -- member row removal keeps the document (the household still owns it) and
  -- only clears the link — ON DELETE SET NULL, never CASCADE, because a D1
  -- cascade cannot reach the R2 objects and would orphan the bytes silently
  -- (0022 note, unchanged).
  member_id TEXT REFERENCES household_members(id) ON DELETE SET NULL,
  -- Free text, trimmed 1-120 chars. The app owns trim + non-empty (a document
  -- without a name is a validation 400); the length CHECK is the backstop.
  name TEXT NOT NULL CHECK (length(name) <= 120),
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Backfill: the old category's human label as the starting name — the exact
-- EN locale strings the UI showed (i18n documents.category.*). 'lainnya' →
-- 'Other' (EN), per the migration story pinned in the PR.
INSERT INTO documents_new (id, household_id, member_id, name, uploaded_by, created_at)
  SELECT
    id,
    household_id,
    member_id,
    CASE category
      WHEN 'kartu_keluarga' THEN 'Kartu Keluarga'
      WHEN 'ktp' THEN 'KTP'
      WHEN 'kartu_anak' THEN 'Kartu Anak'
      WHEN 'akta' THEN 'Akta Lahir'
      WHEN 'paspor' THEN 'Paspor'
      WHEN 'bpjs' THEN 'BPJS'
      ELSE 'Other'
    END,
    uploaded_by,
    created_at
  FROM documents;

DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;

-- Same listing index as 0022: WHERE household_id = ? ORDER BY created_at
-- DESC, id DESC (the id tiebreaker keeps same-second rows stable). The DROP
-- above took the old index; this recreation keeps the EXPLAIN proof in
-- migrations.test.ts true for the full chain.
CREATE INDEX IF NOT EXISTS idx_documents_household
  ON documents(household_id, created_at DESC, id DESC);

-- One document, N files (owner cap: 20, enforced in lib/documents.ts): each
-- file is its own PRIVATE R2 object. New uploads key as
-- documents/<household_id>/<document_id>/<file_id>; the migrated first file
-- keeps its legacy 3-segment key (isDocumentKey accepts both shapes). No
-- public URLs ever exist — every byte read streams through the authenticated
-- Worker route (docs/ARCHITECTURE.md §10).
CREATE TABLE IF NOT EXISTS document_files (
  id TEXT PRIMARY KEY NOT NULL,
  -- Document deletion cascades the metadata rows; the R2 objects behind them
  -- are deleted by the route first (a D1 cascade cannot reach R2 — the 0022
  -- rationale, now per file).
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- The R2 object key. Not unique by constraint: uniqueness comes from the
  -- file id the key embeds.
  r2_key TEXT NOT NULL,
  -- Client-visible file name (basename only — the route strips directories).
  file_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  -- Optional free-text label ("Front", "Page 3"): NULL when unnamed, same
  -- 1-120 bound as the document name (app-enforced; CHECK is the backstop).
  label TEXT CHECK (label IS NULL OR length(label) <= 120),
  -- Upload order, deterministic (next = max(sort_order) + 1); the listing
  -- sorts by it, id as the tiebreaker.
  sort_order INTEGER NOT NULL,
  -- Hex SHA-256 of the stored bytes (integrity + future dedup) — carried
  -- over from the 0022 documents row for the migrated first file.
  sha256 TEXT NOT NULL,
  -- Who added this file — may differ from the document's uploader on later
  -- additions; the file-delete authorization reads it.
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- File listing per document: WHERE document_id = ? ORDER BY sort_order — the
-- index columns match the ORDER BY exactly, same contract as the 0022 index.
CREATE INDEX IF NOT EXISTS idx_document_files_document
  ON document_files(document_id, sort_order);

-- The migrated first file of every pre-#422 document: the old per-document
-- file metadata becomes attachment #1, reusing the existing R2 key (no byte
-- movement) and the document's created_at as its upload time — that IS when
-- those bytes were uploaded. Deterministic id: derived from the document id,
-- so a re-apply can never mint a second copy silently.
INSERT INTO document_files
  (id, document_id, r2_key, file_name, size_bytes, content_type, label,
   sort_order, sha256, uploaded_by, uploaded_at)
  SELECT
    'file-' || document_id,
    document_id,
    storage_key,
    file_name,
    size_bytes,
    mime_type,
    NULL,
    1,
    sha256,
    uploaded_by,
    created_at
  FROM documents_legacy_files;

DROP TABLE documents_legacy_files;

-- The audit vocabulary grows with the operations (#422): file_add /
-- file_delete join the document-level actions, and document_file_id names the
-- exact file for file-scoped rows (content streams audit per file now).
-- SQLite cannot ALTER a CHECK, so document_audit rebuilds around the widened
-- one; every existing row copies over verbatim. The FK-less design survives:
-- document_id and document_file_id are plain TEXT handles, so deletion
-- records outlive the rows (and files) they name.
CREATE TABLE document_audit_new (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (
    action IN ('upload', 'view', 'download', 'delete', 'file_add', 'file_delete')
  ),
  -- The file this record names (view/download/file_add/file_delete rows);
  -- NULL for document-level records (upload/delete). No FK: the file_delete
  -- record must survive the file row it names, same rationale as document_id.
  document_file_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO document_audit_new
  (id, document_id, household_id, actor_user_id, action, document_file_id, created_at)
  SELECT id, document_id, household_id, actor_user_id, action, NULL, created_at
    FROM document_audit;

DROP TABLE document_audit;
ALTER TABLE document_audit_new RENAME TO document_audit;

CREATE INDEX IF NOT EXISTS idx_document_audit_document
  ON document_audit(document_id, created_at);
CREATE INDEX IF NOT EXISTS idx_document_audit_household
  ON document_audit(household_id, created_at);
