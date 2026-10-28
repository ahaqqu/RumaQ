-- Meter real provider token usage alongside the request counter.
-- input/output tokens are what user-key holders pay for on their provider
-- subscription; `used` (requests) still gates the shared server key.

ALTER TABLE ai_usage ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
