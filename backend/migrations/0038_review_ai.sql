-- Model-agnostic AI review of match-review items (ahaqqu/RumaQ#484, PR 1):
-- the reviewer is a PROMPT through the existing provider-agnostic AI layer
-- (lib/ai.ts + lib/ai-access.ts) — never a vendor client and never a new
-- secret. The verdict's provider/model are recorded per row so a later
-- ai_provider/ai_model settings change stays comparable, and changes the
-- reviewer with no code change.
--
-- NUMBERING NOTE: 0037 is applied (price_product_audit); this file takes the
-- next free number, 0038. NEVER rename an applied migration — wrangler keys
-- its d1_migrations table by filename, so a rename re-runs the file.

-- Operator settings that must be DATA, not config (the deployment_flags
-- rationale, 0029): the review MODE is a runtime switch the owner flips from
-- the admin UI, and a cloudflare.config.ts flag would be a PR plus a deploy.
-- One tiny key/value table so the next runtime switch lands without a
-- migration. Keys used today (lib/review-ai.ts owns them):
--   review_mode       — 'manual' | 'assist' | 'auto' (assist = the default:
--                       the AI proposes, the human decides — issue #484).
--   review_ai_user_id — the acting admin whose AI access the auto sweep uses;
--                       written when auto is enabled, absent = try the
--                       server-key fallback.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Default mode = approve-with-AI. OR IGNORE keeps the seed idempotent (the
-- 0002 seed pattern) — an operator-set mode is never overwritten.
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('review_mode', 'assist');

-- One cached AI verdict per review item (UNIQUE below): verdicts are computed
-- once and cached forever, so the cron sweep and the on-demand route can never
-- double-bill the same pair (idempotent under concurrency and retries).
--
-- The row is a CHILD of the review item (ON DELETE CASCADE), unlike the
-- 0027/0032 receipts: a verdict is data ABOUT a pair, worthless without it,
-- so it dies with the item.
CREATE TABLE IF NOT EXISTS review_ai_verdicts (
  -- Dashed UUID at runtime; TEXT PK NOT NULL per the 0021 note — on rowid
  -- tables a TEXT PRIMARY KEY does NOT imply NOT NULL.
  id TEXT PRIMARY KEY NOT NULL,
  review_item_id TEXT NOT NULL REFERENCES match_review_items(id) ON DELETE CASCADE,
  -- Closed vocabulary, matching the prompt's answer schema.
  verdict TEXT NOT NULL CHECK (verdict IN ('same', 'different')),
  -- Model confidence, clamped to [0, 1] by lib/review-ai.ts's strict parse.
  confidence REAL NOT NULL,
  -- The model's one-line justification; NULL only for a hand-written row.
  reason TEXT,
  -- The provider/model that produced the verdict — the comparability record
  -- across a settings-driven model change (NULL = the provider default).
  provider TEXT,
  model TEXT,
  -- The mode in force when the verdict was computed; 'auto' additionally
  -- applied it when it cleared the confidence floor.
  mode TEXT NOT NULL CHECK (mode IN ('assist', 'auto')),
  -- The human's relation to this verdict on the item's decision, filled by
  -- POST /api/admin/review/:id/decision when the caller sends an agreement.
  human_agreement TEXT CHECK (human_agreement IN ('agreed', 'disagreed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- One verdict per item, structurally: the cache's uniqueness IS this index.
  UNIQUE (review_item_id)
);

-- Provenance of an item's current decision (issue #484): who/what produced
-- it. Nullable on purpose — a pending (never decided, or undone) row has no
-- decision to attribute, so the undo path clears it. Existing rows are all
-- human decisions, which is what the default backfills.
ALTER TABLE match_review_items ADD COLUMN decided_source TEXT DEFAULT 'human'
  CHECK (decided_source IN ('human', 'ai_assist', 'ai_auto'));
