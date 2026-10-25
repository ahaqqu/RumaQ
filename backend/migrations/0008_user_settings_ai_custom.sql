-- Custom OpenAI-compatible AI provider configuration
ALTER TABLE user_settings ADD COLUMN ai_base_url TEXT;
ALTER TABLE user_settings ADD COLUMN ai_model TEXT;
