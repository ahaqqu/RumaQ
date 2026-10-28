DELETE FROM plan_items;
-- Haqita price data (global tables, migration 0007). plan_items references
-- price_observations, so these must go after plan_items.
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
DELETE FROM plans;
DELETE FROM purchase_items;
DELETE FROM purchases;
DELETE FROM ai_usage;
DELETE FROM user_settings;
DELETE FROM stock;
DELETE FROM items;
DELETE FROM household_members;
DELETE FROM stores;
DELETE FROM locations;
DELETE FROM households;
DELETE FROM users;
