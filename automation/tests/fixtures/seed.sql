-- Default authenticated user; is_admin = 1 makes it the operator for the
-- admin surfaces (users.is_admin, migration 0014 — the env allowlist is gone).
INSERT INTO users (id, email, name, picture, google_id, password_hash, is_admin)
VALUES (
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  'test@rumaq.dev',
  'Test User',
  NULL,
  'google-test-123',
  'pbkdf2_sha256$100000$pGW_FQUWkZ4LWR5SAXwDbg$eavlQExxmqixP0sIhu9HM8OIZqaxNm5ngKDMQd7Ge3s',
  1
);

-- Household
INSERT INTO households (id, name, created_by)
VALUES (
  '11111111-2222-3333-4444-555555555555',
  'Test Household',
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
);

-- Household membership
INSERT INTO household_members (household_id, user_id, role)
VALUES (
  '11111111-2222-3333-4444-555555555555',
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  'owner'
);

-- User settings (with active household, no AI key configured)
INSERT INTO user_settings (id, user_id, active_household_id, ai_provider, encrypted_ai_key)
VALUES (
  'ssssssss-0000-0000-0000-000000000001',
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  '11111111-2222-3333-4444-555555555555',
  NULL,
  NULL
);

-- Locations
INSERT INTO locations (id, household_id, label, sort_order) VALUES
  ('loc-kitchen', '11111111-2222-3333-4444-555555555555', 'Kitchen',       1),
  ('loc-fridge',  '11111111-2222-3333-4444-555555555555', 'Fridge',         2),
  ('loc-pantry',  '11111111-2222-3333-4444-555555555555', 'Pantry',         3);

-- Second user (for cross-household security tests)
INSERT INTO users (id, email, name) VALUES (
  'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
  'second@rumaq.dev',
  'Second User'
);

INSERT INTO households (id, name, created_by) VALUES (
  '22222222-3333-4444-5555-666666666666',
  'Second Household',
  'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
);

INSERT INTO household_members (household_id, user_id, role) VALUES (
  '22222222-3333-4444-5555-666666666666',
  'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
  'owner'
);

INSERT INTO user_settings (id, user_id, active_household_id)
VALUES (
  'ssssssss-0000-0000-0000-000000000002',
  'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
  '22222222-3333-4444-5555-666666666666'
);

-- Stores
INSERT INTO stores (id, household_id, label) VALUES
  ('store-indo',    '11111111-2222-3333-4444-555555555555', 'Indomaret'),
  ('store-super',    '11111111-2222-3333-4444-555555555555', 'Superindo');

-- Items
INSERT INTO items (id, household_id, name, default_unit, category) VALUES
  ('item-rice',     '11111111-2222-3333-4444-555555555555', 'Rice',            'kg',  'grains'),
  ('item-oil',      '11111111-2222-3333-4444-555555555555', 'Cooking Oil',    'L',   'cooking'),
  ('item-egg',      '11111111-2222-3333-4444-555555555555', 'Eggs',           'pcs', 'protein'),
  ('item-milk',     '11111111-2222-3333-4444-555555555555', 'Milk',           'L',   'dairy'),
  ('item-sugar',    '11111111-2222-3333-4444-555555555555', 'Sugar',          'kg',  'cooking');

-- Stock (3 items in stock, varying urgency)
INSERT INTO stock (id, household_id, item_id, location_id, qty, unit, run_out_days, basis, updated_at) VALUES
  ('stock-rice',  '11111111-2222-3333-4444-555555555555', 'item-rice',  'loc-pantry',  2.0,  'kg',   14,  'default', datetime('now')),
  ('stock-oil',   '11111111-2222-3333-4444-555555555555', 'item-oil',   'loc-kitchen', 0.5,  'L',    3,   'default', datetime('now')),
  ('stock-egg',   '11111111-2222-3333-4444-555555555555', 'item-egg',   'loc-fridge',  10,   'pcs',  7,   'default', datetime('now'));

-- Purchase history (for run-out computation)
INSERT INTO purchases (id, household_id, store_id, date, total, created_at) VALUES
  ('purch-1', '11111111-2222-3333-4444-555555555555', 'store-indo', '2026-06-01', 85000, datetime('now')),
  ('purch-2', '11111111-2222-3333-4444-555555555555', 'store-super', '2026-06-15', 120000, datetime('now')),
  ('purch-3', '11111111-2222-3333-4444-555555555555', 'store-indo', '2026-06-28', 45000, datetime('now'));

INSERT INTO purchase_items (id, purchase_id, item_id, qty, unit, price, created_at) VALUES
  ('pi-1', 'purch-1', 'item-rice', 5.0, 'kg', 65000, datetime('now')),
  ('pi-2', 'purch-1', 'item-oil', 2.0, 'L', 20000, datetime('now')),
  ('pi-3', 'purch-2', 'item-egg', 12.0, 'pcs', 36000, datetime('now')),
  ('pi-4', 'purch-2', 'item-rice', 3.0, 'kg', 39000, datetime('now')),
  ('pi-5', 'purch-2', 'item-milk', 2.0, 'L', 45000, datetime('now')),
  ('pi-6', 'purch-3', 'item-oil', 1.0, 'L', 10000, datetime('now')),
  ('pi-7', 'purch-3', 'item-egg', 10.0, 'pcs', 35000, datetime('now'));
