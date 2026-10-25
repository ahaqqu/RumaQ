-- User-selectable AI model is already stored in ai_model (migration 0008);
-- this adds the reasoning-effort preference applied across providers.
ALTER TABLE user_settings ADD COLUMN ai_thinking_level TEXT;
