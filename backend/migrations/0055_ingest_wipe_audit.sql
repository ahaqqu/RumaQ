-- The wipe receipt (ahaqqu/RumaQ#753, fill-phase toolkit): the append-only
-- record of a store-scoped ingest wipe — the FIRST bulk DELETE surface in the
-- product. A wipe deletes a store's price_observations and their now-orphaned
-- price_products before a re-ingest command is queued; without a receipt the
-- catalog would silently lose rows and the fill loop's "what did this re-push
-- destroy" question would be unanswerable.
--
-- An audit row is a RECEIPT, not a child of anything it names (the 0032/0037/
-- 0039/0054 pattern): store_slug and actor_user_id are PLAIN TEXT handles with
-- no FK, so the record "this store's ingest rows were wiped, N observations
-- and M products deleted, by whom" survives the deleted rows it describes, the
-- price_sources row that carries the slug (deliberately NOT deleted by the
-- wipe — it holds the source's name/kind metadata), and the acting account.
-- The counts are frozen at wipe time — after the re-ingest the store repopulates,
-- so the receipt is the only durable "before" picture. One wipe is one receipt,
-- even when it deletes nothing (a no-op wipe on an empty store is still a fact
-- worth one row — the destructive flag was armed and fired).
--
-- NUMBERING NOTE: 0054 is applied; this file takes the next free number, 0055.
-- NEVER rename an applied migration — wrangler keys its d1_migrations table by
-- filename, so a rename re-runs the file (the 0030 warning).
CREATE TABLE IF NOT EXISTS ingest_wipe_audit (
  -- Dashed UUID at runtime; TEXT PK NOT NULL per the 0021 note — on rowid
  -- tables a TEXT PRIMARY KEY does NOT imply NOT NULL.
  id TEXT PRIMARY KEY NOT NULL,
  -- The wiped store, frozen at wipe time. Plain handle, no FK: the slug is the
  -- pipeline's own stable identifier (SCRAPE_STORE_SLUGS) and the receipt must
  -- survive even a future source-row removal.
  store_slug TEXT NOT NULL,
  -- Plain handle, no FK (0032's rationale): an account cleanup must not take
  -- the receipt with it. A script-token wipe (#656 precedent) is attributed to
  -- the deployment's admin user the token acts as — propsOrReviewScriptAuth
  -- resolves that identity before the route runs.
  actor_user_id TEXT NOT NULL,
  -- The batch's numbers, frozen at wipe time (the 0054 counts convention).
  -- Zeroes are a valid receipt — the wipe no-oped on an empty store.
  observations_deleted INTEGER NOT NULL,
  products_deleted INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- No feed index yet (0022/0027/0037 convention): there is no wipe-history
-- read surface in v1 — the receipt is written to be joined on ad-hoc when an
-- ops query asks. Add the feed index pair with the endpoint that needs it.
