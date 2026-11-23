-- The re-ingest flags on scrape_commands (ahaqqu/RumaQ#753, fill-phase
-- toolkit): a command must CARRY what was asked of it, or the agent that
-- claims it cannot honor it. reset_novelty tells the VPS agent to purge the
-- store's novelty state (/var/lib/rumaq-scraper/<slug>/state.json + images/,
-- + x-state for hari-hari) before the run so already-seen pages re-scrape;
-- wipe_ingest is bookkeeping on the claim — the Worker already wiped the
-- store's rows BEFORE this row was created (lib/ingest-wipe.ts), the column
-- records the fact so the admin history and the agent's own log can show it.
--
-- NOT NULL DEFAULT 0 on an ALTER ADD COLUMN: constant default, valid SQLite —
-- every pre-#753 command reads as a plain scrape (the absent-flag semantics),
-- so old rows and new plain rows are indistinguishable, which is exactly the
-- byte-identical default the contract promises.
--
-- NUMBERING NOTE: 0055 is applied; this file takes the next free number, 0056.
-- NEVER rename an applied migration — wrangler keys its d1_migrations table by
-- filename, so a rename re-runs the file (the 0030 warning).
ALTER TABLE scrape_commands ADD COLUMN reset_novelty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scrape_commands ADD COLUMN wipe_ingest INTEGER NOT NULL DEFAULT 0;
