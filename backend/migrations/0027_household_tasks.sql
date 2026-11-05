-- Household tasks (ahaqqu/RumaQ#429): per-member task assignments — chores,
-- errands, household admin. Tasks belong to a household (the vault's
-- substrate), optionally to one member in EITHER mode (0021): a linked account
-- member or a profile-only member (the kid with no account). Free-text title,
-- same philosophy as #422's document names — no preset category list.
--
-- Completion model: status flips open → done through the PATCH complete
-- action. A RECURRING task never rests in 'done': completing it rolls
-- due_date forward to the next occurrence (lib/tasks.ts computeNextDue) and
-- the task re-opens for the next cycle — the completed instance lives on in
-- household_task_audit ('complete' rows), which is what a future completion
-- history or the allowance ledger would read.
--
-- needs_approval is DERIVED, never client-writable: true while the assignee
-- is a profile-only member (user_id IS NULL — #388 Mode B). The approval step
-- (approved_by_member_id) pairs with the future allowance ledger: the
-- assigner acknowledges the kid's completed chore.
CREATE TABLE IF NOT EXISTS household_tasks (
  -- Dashed UUID at runtime (lib/tasks.ts); TEXT PK NOT NULL per the 0021
  -- note — on rowid tables a TEXT PRIMARY KEY does NOT imply NOT NULL.
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  -- Free text, trimmed 1-120 chars (the #422 document-name bound). The app
  -- owns trim + non-empty (a title-less task is a validation 400); the length
  -- CHECK is the backstop.
  title TEXT NOT NULL CHECK (length(title) <= 120),
  -- The member the task is assigned to. Nullable: unassigned tasks are
  -- allowed (the household's own errands). A member row removal keeps the
  -- task (the household still owns it) and only clears the link — ON DELETE
  -- SET NULL, the 0022 documents.member_id rationale.
  assignee_member_id TEXT REFERENCES household_members(id) ON DELETE SET NULL,
  -- Provenance: who created the task (the surrogate member id, so it works
  -- for both modes — though only linked members can act). Nullable with ON
  -- DELETE SET NULL: removing the creator must not delete the household's
  -- tasks nor orphan them on a dangling FK; authorization falls back to the
  -- owners when this is NULL.
  created_by_member_id TEXT REFERENCES household_members(id) ON DELETE SET NULL,
  -- YYYY-MM-DD, nullable (no deadline). Lexicographic order = calendar order.
  due_date TEXT,
  -- v1 recurrences (ahaqqu/RumaQ#429): the simple next-due computation on
  -- completion lives in lib/tasks.ts. 'custom' is the issue's future word —
  -- the closed CHECK extends by a later migration, like role's CHECK in 0001.
  recurrence TEXT CHECK (recurrence IS NULL OR recurrence IN ('daily', 'weekly', 'monthly')),
  -- Closed set: the board's two columns. NOT NULL with a default so the
  -- INSERT can omit it.
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  -- Derived (see the header): 1 while the assignee is a profile-only member.
  -- INTEGER 0/1 — the persona_enabled/users.is_admin precedent (no BOOLEAN
  -- type in SQLite).
  needs_approval INTEGER NOT NULL DEFAULT 0 CHECK (needs_approval IN (0, 1)),
  -- Who acknowledged the completed task (the assigner or an owner); NULL
  -- until the approve action. The approve route guards on needs_approval and
  -- status='done' — this column alone must never turn approval on.
  approved_by_member_id TEXT REFERENCES household_members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The board listing query: WHERE household_id = ? [AND status = ?] ORDER BY
-- due_date — the open column sorts by due date (soonest first). The index
-- columns match the household+status prefix, so the status-filtered seek needs
-- no temp B-tree; the plan is pinned by an EXPLAIN in migrations.test.ts (the
-- 0020/0021/0022 index-plan-proof contract).
CREATE INDEX IF NOT EXISTS idx_household_tasks_household
  ON household_tasks(household_id, status, due_date);

-- Who did what to which task, when (create/update/complete/approve/delete).
-- The audit trail OUTLIVES the task on purpose: task_id is a plain TEXT
-- handle with no FK, so the deletion record survives the row it names — the
-- delete route writes it in the same batch as the DELETE (an FK + cascade
-- here would erase exactly that record — the 0022 document_audit rationale,
-- and for tasks it matters MORE: recurring completions are the durable
-- record the future allowance ledger reads).
CREATE TABLE IF NOT EXISTS household_task_audit (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'complete', 'approve', 'delete')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit lookup by task (who touched this one) and by household (the
-- household admin surface's future feed) — the 0022 index pair.
CREATE INDEX IF NOT EXISTS idx_household_task_audit_task
  ON household_task_audit(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_household_task_audit_household
  ON household_task_audit(household_id, created_at);
