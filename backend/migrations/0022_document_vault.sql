-- Document vault (ahaqqu/RumaQ#388 MVP): per-household private documents —
-- kartu keluarga, KTP, kartu anak, akta lahir — attachable to family members
-- in BOTH modes (0021): a linked account member or a profile-only member
-- (a toddler with no account). The bytes live in private R2 under
-- documents/<household_id>/<document_id> (see lib/storage.ts) — these tables
-- own the metadata and the audit trail only. No public URLs ever exist: every
-- byte read streams through the authenticated Worker route.
CREATE TABLE IF NOT EXISTS documents (
  -- Dashed UUID at runtime (lib/documents.ts); TEXT PK NOT NULL per the 0021
  -- note — on rowid tables a TEXT PRIMARY KEY does NOT imply NOT NULL.
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  -- The member the document belongs to (the vault filter's target). Nullable:
  -- household-level documents (kartu keluarga) have no single person. A
  -- member row removal keeps the document (the household still owns it) and
  -- only clears the link — ON DELETE SET NULL, never CASCADE, because a D1
  -- cascade cannot reach the R2 object and would orphan the bytes silently.
  member_id TEXT REFERENCES household_members(id) ON DELETE SET NULL,
  -- Closed set (extensible by a later migration, like role's CHECK in 0001):
  -- the MVP directive's categories, 'lainnya' as the catch-all.
  category TEXT NOT NULL CHECK (
    category IN ('kartu_keluarga', 'ktp', 'kartu_anak', 'akta', 'paspor', 'bpjs', 'lainnya')
  ),
  -- Client-visible file name (basename only — the route strips directories).
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  -- The R2 object key (documents/<household_id>/<document_id>). Not unique:
  -- uniqueness comes from the document id the key embeds.
  storage_key TEXT NOT NULL,
  -- Hex SHA-256 of the stored bytes (integrity + future dedup).
  sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The household listing query: WHERE household_id = ? ORDER BY created_at
-- DESC, id DESC (the id tiebreaker keeps same-second rows stable). The DESC
-- index columns match the ORDER BY exactly, so the seek needs no temp
-- B-tree — pinned by an EXPLAIN in migrations.test.ts (same contract as the
-- 0020/0021 index-plan proofs).
CREATE INDEX IF NOT EXISTS idx_documents_household
  ON documents(household_id, created_at DESC, id DESC);

-- Who did what to which document, when (upload/view/download/delete). The
-- audit trail OUTLIVES the document on purpose: document_id is a plain TEXT
-- handle with no FK, so the deletion record survives the row it names — the
-- delete route writes it in the same batch as the DELETE (an FK + cascade
-- here would erase exactly that record). household_id keeps the trail scoped
-- and joinable to the household's own history.
CREATE TABLE IF NOT EXISTS document_audit (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('upload', 'view', 'download', 'delete')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit lookup by document (who touched this one) and by household (the
-- household admin surface's future feed).
CREATE INDEX IF NOT EXISTS idx_document_audit_document
  ON document_audit(document_id, created_at);
CREATE INDEX IF NOT EXISTS idx_document_audit_household
  ON document_audit(household_id, created_at);
