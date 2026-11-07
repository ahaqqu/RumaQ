DELETE FROM plan_items;
-- Haqita price data (global tables, migration 0007). plan_items references
-- price_observations, so these must go after plan_items. Aliases (migration
-- 0030) reference price_products — D1 enforces foreign keys, so they go
-- first; canonical_index_state is a counter and is deliberately left alone
-- (the version only has to be monotonic, never zero).
DELETE FROM price_product_aliases;
-- Rename receipts (migration 0037) are receipts, not children: plain handles,
-- no FK, so deleting the products below cascades nothing into them and reset
-- has to clear them explicitly or a scenario's admin history leaks into the
-- next one's product detail read.
DELETE FROM price_product_audit;
DELETE FROM price_observations;
DELETE FROM price_products;
DELETE FROM price_sources;
-- Scraper run reports (migration 0010) — no FK relations, but reset must
-- return the monitor feed to a clean slate for the price scenarios.
DELETE FROM price_runs;
-- Scrape Now command queue (migration 0012) — events reference commands, so
-- events go first; reset must reopen the one-run-at-a-time queue.
DELETE FROM scrape_run_events;
DELETE FROM scrape_commands;
-- Match review queue (migration 0013) — reset must return the triage queue to
-- a clean slate between scenarios. AI verdicts (migration 0038) reference the
-- pair with ON DELETE CASCADE, but reset deletes them explicitly FIRST so the
-- clean slate never depends on FK enforcement being on in every harness.
DELETE FROM review_ai_verdicts;
DELETE FROM match_review_items;
-- Operator runtime settings (migration 0038): the AI review mode is a global
-- switch, so a scenario that enables auto must not leak that mode into the
-- next scenario. The absent row degrades to the 'assist' default (#484).
DELETE FROM app_settings;
DELETE FROM plans;
DELETE FROM purchase_items;
DELETE FROM purchases;
-- Per-call AI usage events (migration 0015) — the ai_usage aggregate was
-- dropped by that migration, so reset must clear the events table instead.
DELETE FROM ai_usage_events;
DELETE FROM user_settings;
DELETE FROM stock;
DELETE FROM items;
DELETE FROM household_members;
-- AI gateway (migration 0041): a capability assignment references its provider,
-- so assignments go first. Deleting the household cascades both, but reset does
-- not depend on FK enforcement being on in every harness.
DELETE FROM ai_capabilities;
DELETE FROM ai_providers;
DELETE FROM stores;
DELETE FROM locations;
DELETE FROM households;
DELETE FROM users;
