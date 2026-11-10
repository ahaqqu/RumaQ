Feature: Purchase Creation and History
  The purchase API creates purchases with items, updating stock and history.

  Scenario: Unauthenticated access returns 401
    Given the database has seed data
    When I send a POST request to /api/purchases
    Then the response status should be 401

  Scenario: Create purchase updates stock
    Given the database has seed data
    And I am authenticated as a test user
    When I create a purchase with store "store-indo" and date "2026-07-01" and items
      | name        | qty | unit | price |
      | Milk        | 2   | L    | 25000 |
      | Cooking Oil | 1   | L    | 15000 |
    Then the response status should be 201
    And the response should have a purchase object
    And the response should have items array
    And the response should have stock array
    And the stock for "Milk" should have qty 2
    And the stock for "Cooking Oil" should have qty 1.5

  Scenario: Create purchase with new item creates item and stock
    Given the database has seed data
    And I am authenticated as a test user
    When I create a purchase with store "store-indo" and date "2026-07-01" and items
      | name      | qty | unit | price |
      | Tofu      | 3   | pcs  | 5000  |
      | Tempeh    | 2   | pcs  | 3000  |
    Then the response status should be 201
    And the response should have a purchase object
    And the stock for "Tofu" should have qty 3

  Scenario: Create purchase with existing item updates qty
    Given the database has seed data
    And I am authenticated as a test user
    When I create a purchase with store "store-super" and date "2026-07-01" and items
      | name   | qty | unit | price |
      | Rice   | 5   | kg   | 65000 |
    Then the response status should be 201
    And the stock for "Rice" should have qty 7

  Scenario: Multi-line receipt of one item sums stock once
    Given the database has seed data
    And I am authenticated as a test user
    When I create a purchase with store "store-indo" and date "2026-07-01" and items
      | name | qty | unit | price |
      | Rice | 1   | kg   | 13000 |
      | rice | 2   | kg   | 13000 |
    Then the response status should be 201
    And the response should have items array
    And the response should have stock array
    And the stock for "Rice" should have qty 5

  Scenario: Invalid items schema returns 400
    Given the database has seed data
    And I am authenticated as a test user
    When I send a POST request to /api/purchases with body
      """
      { "date": "2026-07-01", "items": [] }
      """
    Then the response status should be 400

  Scenario: Another household cannot access purchase receipt
    Given the database has seed data
    And I am authenticated as a test user
    When I send a GET request to /api/purchases/nonexistent-id/receipt
    Then the response status should be 404

  Scenario: Unauthenticated access to patterns returns 401
    Given the database has seed data
    When I send a GET request to /api/purchases/patterns
    Then the response status should be 401

  Scenario: List purchases returns history with items
    Given the database has seed data
    And I am authenticated as a test user
    When I send a GET request to /api/purchases
    Then the response status should be 200
    And the response should have purchases array
    And each purchase should have items
    And the response should have month_totals
    And the response should have avg_per_month
    And the purchases list should contain seed purchases

  Scenario: List purchases filtered by store
    Given the database has seed data
    And I am authenticated as a test user
    When I send a GET request to /api/purchases?store=store-indo
    Then the response status should be 200
    And all purchases should be from store "Indomaret"

  Scenario: List purchases filtered by date range
    Given the database has seed data
    And I am authenticated as a test user
    When I send a GET request to /api/purchases?from=2026-06-15&to=2026-06-28
    Then the response status should be 200
    And all purchases should be within date range 2026-06-15 to 2026-06-28

  Scenario: List purchases filtered by text search
    Given the database has seed data
    And I am authenticated as a test user
    When I send a GET request to /api/purchases?q=Rice
    Then the response status should be 200
    And the purchases should contain items matching "Rice"

  Scenario: Get single purchase detail
    Given the database has seed data
    And I am authenticated as a test user
    When I send a GET request to /api/purchases/purch-1
    Then the response status should be 200
    And the purchase detail should be for "purch-1"
    And the purchase detail should have items

  Scenario: Get non-existent purchase returns 404
    Given the database has seed data
    And I am authenticated as a test user
    When I send a GET request to /api/purchases/nonexistent
    Then the response status should be 404

  Scenario: Get purchase patterns
    Given the database has seed data
    And I am authenticated as a test user
    When I send a GET request to /api/purchases/patterns
    Then the response status should be 200
    And the response should have patterns array
    And the patterns should contain "Rice"
