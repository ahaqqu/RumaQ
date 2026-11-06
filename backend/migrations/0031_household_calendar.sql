-- Household calendar (ahaqqu/RumaQ#430): the shared family calendar — stored
-- events (free-text title, date, optional time, per-member visibility) plus a
-- derive-on-read VIEW of document expiry deadlines (#426's documents.expires_on
-- surfaces automatically; KTP/STNK/SIM/paspor renewals become family-visible
-- dates). The deadlines are NOT seeded as rows — lib/calendar.ts derives them
-- from the documents table on every read, so an expires_on edit reflects on
-- the calendar instantly and there is no second copy to drift (the calendar is
-- a VIEW union of stored events + derived deadline entries; the API entries
-- carry kind: 'event' | 'deadline'). Indonesian moments (school enrollment,
-- mudik prep, annual tax, birthdays) are quick-add TEMPLATES in the UI that
-- pre-fill the create form — first-class, not hidden magic rows (#430).
--
-- Visibility model: 'all' = the whole household; 'members' = exactly the rows
-- in household_calendar_event_members, PLUS the creator (implicit — the
-- restriction is about others, and the creator is always in the manager set,
-- so locking themselves out would strand their own event). A listed member row
-- removal (or the creator's) degrades gracefully: ON DELETE CASCADE drops the
-- visibility row / nulls created_by, never the event.
CREATE TABLE IF NOT EXISTS household_calendar_events (
  -- Dashed UUID at runtime (lib/calendar.ts); TEXT PK NOT NULL per the 0021
  -- note — on rowid tables a TEXT PRIMARY KEY does NOT imply NOT NULL.
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  -- Free text, trimmed 1-120 chars (the #422 document-name bound; the same
  -- bound as 0027 task titles). The app owns trim + non-empty (a title-less
  -- event is a validation 400); the length CHECK is the backstop.
  title TEXT NOT NULL CHECK (length(title) <= 120),
  -- YYYY-MM-DD, NOT NULL — a calendar entry without a date is not on any day.
  -- Lexicographic order = calendar order (the 0027 due_date discipline).
  event_date TEXT NOT NULL,
  -- Optional wall-clock time 'HH:MM' (24h), nullable — an all-day event has
  -- none. Stored as text; ordering puts all-day entries first (NULL sorts
  -- before values in SQLite ASC).
  event_time TEXT,
  -- Closed set: whole household vs a specific member list. 'members' with a
  -- depleted list (every listed row cascaded away) degrades to creator-only —
  -- reads derive visibility live (lib/calendar.ts), never from a stored flag.
  visibility TEXT NOT NULL DEFAULT 'all' CHECK (visibility IN ('all', 'members')),
  -- Provenance: who created the event (the surrogate member id, both modes
  -- 0021 — though only linked members can act). Nullable with ON DELETE SET
  -- NULL: removing the creator must not delete the household's events; when
  -- NULL, authorization falls back to the owners (the 0027 creator rationale).
  created_by_member_id TEXT REFERENCES household_members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The month-window listing query: WHERE household_id = ? [AND event_date
-- range] ORDER BY event_date, event_time — the index columns match the
-- household+date prefix, so the window seek needs no temp B-tree; the plan is
-- pinned by an EXPLAIN in migrations.test.ts (the 0020/0021/0022/0027
-- index-plan-proof contract).
CREATE INDEX IF NOT EXISTS idx_household_calendar_events_household
  ON household_calendar_events(household_id, event_date);

-- Per-member visibility for 'members' events. One row per listed member,
-- both modes (0021 — a profile-only kid can be an event's audience). CASCADE
-- on both sides: deleting the event removes its audience (they are attributes
-- of the event, not history); removing a member row drops their visibility
-- grants. The composite PK serves the read predicate (event_id + member_id)
-- with no extra index.
CREATE TABLE IF NOT EXISTS household_calendar_event_members (
  event_id TEXT NOT NULL REFERENCES household_calendar_events(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, member_id)
);

-- Who did what to which event, when (create/update/delete). The audit trail
-- OUTLIVES the event on purpose: event_id is a plain TEXT handle with no FK,
-- so the deletion record survives the row it names — the delete route writes
-- it in the same batch as the DELETE (an FK + cascade here would erase exactly
-- that record — the 0022 document_audit / 0027 task_audit rationale).
CREATE TABLE IF NOT EXISTS household_calendar_event_audit (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit lookup by event and by household — the 0022/0027 index pair.
CREATE INDEX IF NOT EXISTS idx_household_calendar_event_audit_event
  ON household_calendar_event_audit(event_id, created_at);
CREATE INDEX IF NOT EXISTS idx_household_calendar_event_audit_household
  ON household_calendar_event_audit(household_id, created_at);
