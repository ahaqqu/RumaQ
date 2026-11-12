-- Representative D1 export dump (`dump_options.compatibility = "d1"`), in
-- the shape Cloudflare's dumpSql emits: a `PRAGMA defer_foreign_keys=TRUE;`
-- header, then per table its CREATE followed by its INSERTs, in
-- sqlite_schema rowid (= creation) order, with indexes last.
--
-- The table order mirrors the real migration chain: plan_items is created by
-- 0001 and gets its price_observation_id FK in 0007, so its row is emitted
-- BEFORE price_observations exists. That forward reference is valid for a D1
-- import, but it made the restore drill fail with "no such table:
-- main.price_observations" until ahaqqu/RumaQ#659: node:sqlite enables FK
-- enforcement by default, and `defer_foreign_keys` defers row checks without
-- letting a statement prepare against a table that does not exist yet.
--
-- Synthetic canary rows only — no production data.
PRAGMA defer_foreign_keys=TRUE;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT
);
INSERT INTO "users" ("id","email","name") VALUES('u1','canary@example.com','Canary');

CREATE TABLE households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id)
);
INSERT INTO "households" ("id","name","created_by") VALUES('h1','Keluarga Canary','u1');

CREATE TABLE household_members (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member'
);
INSERT INTO "household_members" ("id","household_id","user_id","role") VALUES('m1','h1','u1','owner');

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);
INSERT INTO "items" ("id","household_id","name") VALUES('i1','h1','Beras');

CREATE TABLE stock (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  qty REAL NOT NULL DEFAULT 0
);
INSERT INTO "stock" ("id","household_id","item_id","qty") VALUES('s1','h1','i1',2);

CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  total INTEGER
);
INSERT INTO "purchases" ("id","household_id","date","total") VALUES('p1','h1','2026-11-03',15000);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft'
);
INSERT INTO "plans" ("id","household_id","status") VALUES('plan1','h1','active');

CREATE TABLE plan_items (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES items(id),
  qty REAL NOT NULL,
  price_observation_id TEXT REFERENCES price_observations(id)
);
-- Inserted while its FK parent does not exist yet: the forward reference the
-- old drill rejected. The parent row lands further down.
INSERT INTO "plan_items" ("id","plan_id","item_id","qty","price_observation_id") VALUES('pi1','plan1','i1',1,'obs1');

CREATE TABLE price_observations (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  price INTEGER NOT NULL
);
INSERT INTO "price_observations" ("id","product_id","price") VALUES('obs1','prod1',15000);

CREATE TABLE documents (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id TEXT REFERENCES household_members(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id)
);
INSERT INTO "documents" ("id","household_id","member_id","name","uploaded_by") VALUES('doc1','h1','m1','KTP','u1');

CREATE INDEX idx_plan_items_plan ON plan_items(plan_id);
CREATE INDEX idx_documents_household ON documents(household_id);
