-- Per-call AI usage events (issue #353). Replaces the per-user/day ai_usage
-- aggregate: event granularity is what makes ts-exact 24h/7d/30d ranges and
-- per-model cache hit rates possible. The daily cap dies with ai_usage —
-- usage is recorded for analytics only and never gates a call.
--
-- The DROP below is destructive by design. Rollback is D1 Time Travel
-- (`wrangler d1 time-travel restore`) within 30 days of the deploy that
-- applies this file. Deploy order (scripts/deploy.sh applies migrations
-- before `cf deploy`) means the old Worker briefly still queries ai_usage:
-- transient 500s on the AI endpoints are expected until the new Worker lands.
-- Legacy `used` request counts are not carried over — each legacy day seeds
-- ONE synthetic call (tokens preserved, calls undercount for legacy days).

CREATE TABLE ai_usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- ISO instant of the call; `date` is its UTC day (cheap "today" lookups).
  ts TEXT NOT NULL,
  date TEXT NOT NULL,
  provider TEXT,
  -- NULL for the legacy seed rows (per-day aggregate never knew the model).
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- NULL when the provider reported no cached-token figure — unknown, not 0.
  cached_tokens INTEGER,
  -- 'user' | 'server' for live rows; NULL for the legacy seed rows.
  key_source TEXT
);

CREATE INDEX idx_ai_usage_events_ts ON ai_usage_events (ts);
CREATE INDEX idx_ai_usage_events_user_ts ON ai_usage_events (user_id, ts);

-- Seed one synthetic event per legacy daily row (midnight UTC of that day,
-- model/cache/key_source unknown) so the 7d/30d admin views have token
-- history on day one.
INSERT INTO ai_usage_events (
  id, user_id, ts, date, provider, model,
  input_tokens, output_tokens, cached_tokens, key_source
)
SELECT
  'legacy-' || id,
  user_id,
  date || 'T00:00:00Z',
  date,
  provider,
  NULL,
  input_tokens,
  output_tokens,
  NULL,
  NULL
FROM ai_usage;

DROP TABLE ai_usage;
