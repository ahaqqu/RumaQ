-- 0042_drop_legacy_ai_settings.sql — ahaqqu/RumaQ#523 P3 (plan §4.3, D6).
--
-- The legacy per-user AI settings are DEAD: from 0041 on, every AI call resolves
-- the household's `ai_providers` / `ai_capabilities` rows (lib/ai/capabilities.ts),
-- and nothing reads `user_settings.ai_*` any more. The owner decided there is NO
-- compatibility window (D6, §7.2 #4), so the columns die in the same PR that ships
-- the Settings screen which replaces them — screen and schema can never disagree.
--
-- DESTRUCTIVE: this is the one migration in the AI-gateway project that is not a
-- plain `git revert`. The backfill in 0041 copied every legacy key verbatim (v1:
-- envelope) and converted it lazily on first read (D10), so no key is lost here;
-- what the drop removes is the projection nothing reads. The complete rollback is
-- the D1 backup taken immediately before deploy (plan §6 P3, risk 5).
--
-- D1 runs SQLite >= 3.35, so DROP COLUMN is native — verified against
-- `node:sqlite` on the full 0001..0041 chain (migrations.test.ts), including the
-- fact that no index or CHECK on `user_settings` references these columns (an
-- expression index or a table CHECK would make DROP COLUMN fail).
ALTER TABLE user_settings DROP COLUMN ai_provider;
ALTER TABLE user_settings DROP COLUMN encrypted_ai_key;
ALTER TABLE user_settings DROP COLUMN ai_base_url;
ALTER TABLE user_settings DROP COLUMN ai_model;
ALTER TABLE user_settings DROP COLUMN ai_vision_model;
ALTER TABLE user_settings DROP COLUMN ai_thinking_level;
