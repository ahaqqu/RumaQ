-- AI gateway (ahaqqu/RumaQ#523, phase P1): multiple providers per HOUSEHOLD,
-- one assignment per capability (decision / reasoning / vision), plus
-- capability, household and funding stamps on usage rows.
-- NUMBERING: the design doc's "0039" is illustrative — 0039 and 0040 were
-- taken by price_alias_audit and price_runs_v2_receipt, so this takes the next
-- free slot. Never rename an applied migration: wrangler keys d1_migrations by
-- filename.
--
-- Purely additive: user_settings.ai_* is NOT touched here (P3 drops those six
-- columns with the Settings screen, plan §4.3). Everything below is either a
-- new table, a new index, or a nullable column on ai_usage_events.

-- A provider instance: the wire kind, a preset, an optional base URL, one
-- sealed key. A typed-decision endpoint is a row like any other — a label,
-- kind 'questions', and a base URL. No vendor name appears in a table, column
-- or type: the abstraction is the wire, and nothing is seeded.
CREATE TABLE IF NOT EXISTS ai_providers (
  -- Dashed UUID at runtime; TEXT PK NOT NULL per the 0021 note (on rowid
  -- tables a TEXT PRIMARY KEY does not imply NOT NULL). The backfill writes
  -- 'legacy-' || user_id so the migration can address the row deterministically.
  id TEXT PRIMARY KEY NOT NULL,
  -- D1: the HOUSEHOLD owns the credentials, because the household pays. Which
  -- member made a call is recorded per call (ai_usage_events.user_id), never here.
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  -- The household's name for it ("Work account", "Personal key").
  label TEXT NOT NULL,
  -- The WIRE protocol, not the vendor: 'openai-compatible' serves OpenAI,
  -- OpenCode, Ollama and any custom base URL. 'gemini' is separate because its
  -- wire is genuinely different; 'questions' is a typed choice/answer wire.
  kind TEXT NOT NULL CHECK (kind IN ('openai-compatible', 'anthropic', 'gemini', 'questions')),
  -- The vendor preset this row was created from ('openai', 'opencode', 'ollama',
  -- 'custom', 'anthropic', 'gemini', or NULL for a hand-configured endpoint).
  -- DATA, not a type: a new vendor is a row in lib/ai/presets.ts, never a
  -- migration. The preset supplies the display label, the canonical base URL
  -- and the default models per capability.
  preset TEXT,
  -- Optional: NULL = the preset's canonical endpoint. Required when there is
  -- neither a preset endpoint nor this value ('custom', 'questions').
  base_url TEXT,
  -- The provider-level default model ("one alias per key"). A capability that
  -- leaves ai_capabilities.model NULL inherits THIS value; if this is NULL too
  -- the capability is not configured (402). Owner-typed, never a code-side
  -- vendor catalog: floating aliases like 'chatgpt-4o-latest' live in data.
  default_model TEXT,
  -- AES-GCM ciphertext (lib/crypto.ts). NULL means the row cannot serve a call:
  -- it may be edited and re-keyed, but it cannot be ASSIGNED to a capability
  -- until it has a key. NEVER returned by an API, for any role.
  encrypted_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- If a key is stored it must be a crypto.ts envelope, not a plaintext slip.
  -- BOTH versions are accepted from day one ON PURPOSE: SQLite cannot alter a
  -- CHECK without rebuilding the table, and D10's AAD-bound 'v2:' envelope
  -- arrives in P2 — one release after this migration. v1: = legacy (no AAD),
  -- v2: = bound to this row's id.
  CHECK (encrypted_key IS NULL OR encrypted_key LIKE 'v1:%' OR encrypted_key LIKE 'v2:%')
);

-- Case-insensitive label uniqueness WITHIN a household: two "Gemini" rows are
-- a UX bug, not a feature. Expression index, so the check is the database's.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_providers_household_label
  ON ai_providers (household_id, lower(label));

-- Exactly one assignment per (household, capability) — the PK IS the invariant.
CREATE TABLE IF NOT EXISTS ai_capabilities (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN ('decision', 'reasoning', 'vision')),
  -- Deleting a provider clears the assignments that pointed at it (CASCADE):
  -- the capability then becomes not configured (402). The API reports the
  -- cleared capabilities so the UI can warn BEFORE the delete.
  provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  -- NULL = inherit the provider's default_model (owner decision, #523). If the
  -- provider has none either, the capability is NOT configured (402) — the
  -- gateway never guesses an adapter default.
  model TEXT,
  -- Per-capability thinking level: NULL = the provider default.
  thinking_level TEXT CHECK (thinking_level IN ('low', 'medium', 'high')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (household_id, capability),
  -- Vision providers take no reasoning knob: a vision OCR read wants a cheap
  -- deterministic answer. Enforced here so no adapter has to silently drop it.
  CHECK (capability <> 'vision' OR thinking_level IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_ai_capabilities_provider ON ai_capabilities (provider_id);

-- Usage rows gain the three dimensions D1 and D9 need. All NULL on pre-0041
-- history (still valid; the admin views treat NULL as "unknown").
ALTER TABLE ai_usage_events ADD COLUMN capability TEXT;
-- The household the call acted for. SET NULL, not CASCADE: deleting a
-- household must not delete the record that its tokens were spent.
ALTER TABLE ai_usage_events ADD COLUMN household_id TEXT REFERENCES households(id) ON DELETE SET NULL;
-- D9's reserved dimension: 'household' (BYOK) today, 'platform' if RumaQ ever pays.
ALTER TABLE ai_usage_events ADD COLUMN funding TEXT CHECK (funding IN ('household', 'platform'));

-- Per-user "today" (the existing route) and per-household accounting (D1).
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_user_date_capability
  ON ai_usage_events (user_id, date, capability);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_household_date
  ON ai_usage_events (household_id, date);

-- ---------------------------------------------------------------------------
-- Backfill from today's single provider (plan §3.3). The one ambiguity is
-- whose household a legacy row belongs to. The answer is already in the code:
-- ACTIVE_HOUSEHOLD_SQL (backend/src/auth.ts) — user_settings.active_household_id
-- while it is still a membership, else the oldest membership. This mirrors
-- that rule exactly, so migration and runtime cannot disagree.
--
-- Filtering on a 'v1:' envelope on purpose: one hand-edited non-envelope
-- ciphertext would fail the ai_providers CHECK and abort the deploy. Such a
-- row is skipped (its key could not be decrypted anyway) and the user lands in
-- the normal "not configured" state instead of blocking everyone else.
-- ---------------------------------------------------------------------------

-- 0) The household each configured legacy user belongs to, plus the legacy
--    values. Repeated in both INSERTs below rather than stored in a temp table:
--    a D1 migration file must not depend on session-local objects surviving
--    between statements.
WITH source AS (
  SELECT s.user_id, s.ai_provider, s.ai_base_url, s.ai_model,
         s.ai_vision_model, s.ai_thinking_level, s.encrypted_ai_key,
         COALESCE(
           (SELECT m.household_id
              FROM household_members m
              JOIN user_settings a ON a.user_id = m.user_id
                                   AND a.active_household_id = m.household_id
             WHERE m.user_id = s.user_id
             LIMIT 1),
           (SELECT m.household_id
              FROM household_members m
             WHERE m.user_id = s.user_id
             ORDER BY m.joined_at, m.household_id
             LIMIT 1)
         ) AS household_id
    FROM user_settings s
   WHERE s.ai_provider IS NOT NULL
     AND s.encrypted_ai_key IS NOT NULL AND s.encrypted_ai_key <> ''
     AND s.encrypted_ai_key LIKE 'v1:%'
),
-- 1) One provider per configured user, handed to that user's household. A user
--    in two households gets it in exactly one — the active/oldest one, never
--    duplicated. Members of the same household keep ONE row each; the label
--    disambiguates them with the member's name and a partition-unique
--    sequence, so the (household, lower(label)) index can never abort the deploy.
labelled AS (
  SELECT src.*, u.name AS user_name,
         CASE src.ai_provider
           WHEN 'openai' THEN 'OpenAI' WHEN 'opencode' THEN 'OpenCode'
           WHEN 'anthropic' THEN 'Anthropic' WHEN 'gemini' THEN 'Gemini'
           WHEN 'ollama' THEN 'Ollama Cloud' ELSE 'Custom provider'
         END || ' (imported)' AS base_label
    FROM source src
    JOIN users u ON u.id = src.user_id
   WHERE src.household_id IS NOT NULL
),
-- The sequence is numbered per WRITTEN label, not per raw preset id: every
-- unrecognised ai_provider collapses to the same 'Custom provider' prefix, so
-- numbering by the id would hand two different unknown ids rn = 1 each and
-- abort the deploy on the (household, lower(label)) index. Partitioning by the
-- label makes that uniqueness structural.
numbered AS (
  SELECT labelled.*,
         ROW_NUMBER() OVER (
           PARTITION BY household_id, base_label
           ORDER BY user_id
         ) AS rn
    FROM labelled
)
INSERT INTO ai_providers (id, household_id, label, kind, preset, base_url, encrypted_key)
SELECT 'legacy-' || user_id,
       household_id,
       base_label || CASE WHEN rn > 1
                          THEN ' · ' || COALESCE(NULLIF(user_name, ''), user_id) || ' #' || rn
                          ELSE '' END,
       CASE ai_provider WHEN 'anthropic' THEN 'anthropic'
                        WHEN 'gemini' THEN 'gemini'
                        ELSE 'openai-compatible' END,
       ai_provider,          -- the legacy value IS a preset id (0008 vocabulary)
       ai_base_url,
       -- The v1: envelope is copied VERBATIM: no re-encryption, no re-entry.
       -- The AAD-bound v2: form arrives with P2; rows convert on first read.
       encrypted_ai_key
  FROM numbered;

-- 2) Capabilities are household-level, so exactly one member's legacy values
--    win per capability: the household OWNER's, else the earliest-joined
--    member's, else the lowest user id. Deterministic, and every other member's
--    provider row still exists for the owner to assign later — no key is
--    discarded. The join on household_members both resolves the role and drops
--    a legacy row whose user has no membership (provider_id is NOT NULL).
WITH source AS (
  SELECT s.user_id, s.ai_provider, s.ai_model,
         s.ai_vision_model, s.ai_thinking_level, s.encrypted_ai_key,
         COALESCE(
           (SELECT m.household_id
              FROM household_members m
              JOIN user_settings a ON a.user_id = m.user_id
                                   AND a.active_household_id = m.household_id
             WHERE m.user_id = s.user_id
             LIMIT 1),
           (SELECT m.household_id
              FROM household_members m
             WHERE m.user_id = s.user_id
             ORDER BY m.joined_at, m.household_id
             LIMIT 1)
         ) AS household_id
    FROM user_settings s
   WHERE s.ai_provider IS NOT NULL
     AND s.encrypted_ai_key IS NOT NULL AND s.encrypted_ai_key <> ''
     AND s.encrypted_ai_key LIKE 'v1:%'
),
candidate AS (
  -- reasoning + decision inherit the text model / thinking level; vision
  -- inherits the explicit vision model, else the text model, and NEVER a
  -- thinking level (the CHECK above requires it).
  --
  -- The thinking level is NORMALISED, not trusted: 0009 added the column with
  -- no CHECK and only the settings schema constrains the vocabulary, so one
  -- hand-edited value would fail ai_capabilities' CHECK and abort the whole
  -- migration for everyone — the same hazard the 'v1:' key filter above
  -- guards. A corrupt preference is dropped; the user keeps their key.
  SELECT src.household_id, src.user_id, m.role, m.joined_at,
         'reasoning' AS capability, src.ai_model AS model,
         CASE WHEN src.ai_thinking_level IN ('low', 'medium', 'high')
              THEN src.ai_thinking_level END AS thinking_level
    FROM source src
    JOIN household_members m ON m.user_id = src.user_id AND m.household_id = src.household_id
  UNION ALL
  SELECT src.household_id, src.user_id, m.role, m.joined_at,
         'vision', COALESCE(src.ai_vision_model, src.ai_model), NULL
    FROM source src
    JOIN household_members m ON m.user_id = src.user_id AND m.household_id = src.household_id
  UNION ALL
  SELECT src.household_id, src.user_id, m.role, m.joined_at,
         'decision', src.ai_model,
         CASE WHEN src.ai_thinking_level IN ('low', 'medium', 'high')
              THEN src.ai_thinking_level END
    FROM source src
    JOIN household_members m ON m.user_id = src.user_id AND m.household_id = src.household_id
),
ranked AS (
  SELECT candidate.*,
         ROW_NUMBER() OVER (
           PARTITION BY household_id, capability
           ORDER BY (role = 'owner') DESC, joined_at, user_id
         ) AS rn
    FROM candidate
)
INSERT INTO ai_capabilities (household_id, capability, provider_id, model, thinking_level)
SELECT household_id, capability, 'legacy-' || user_id, model, thinking_level
  FROM ranked
 WHERE rn = 1;

-- 3) History gains the household and the funding source it actually used: the
--    old per-user key is a household call, the retired shared key was
--    platform-funded. Pre-existing capability stays NULL ("unknown").
UPDATE ai_usage_events
   SET household_id = (
     SELECT COALESCE(
       (SELECT m.household_id
          FROM household_members m
          JOIN user_settings a ON a.user_id = m.user_id
                               AND a.active_household_id = m.household_id
         WHERE m.user_id = ai_usage_events.user_id
         LIMIT 1),
       (SELECT m.household_id
          FROM household_members m
         WHERE m.user_id = ai_usage_events.user_id
         ORDER BY m.joined_at, m.household_id
         LIMIT 1)))
 WHERE household_id IS NULL;

UPDATE ai_usage_events
   SET funding = CASE key_source WHEN 'server' THEN 'platform' WHEN 'user' THEN 'household' END
 WHERE funding IS NULL AND key_source IN ('user', 'server');
