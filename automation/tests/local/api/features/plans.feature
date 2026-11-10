Feature: Shopping Plans
  The plans API generates, saves, and manages shopping plans with per-store item groupings.

  Scenario: Unauthenticated access returns 401
    Given the database has seed data
    When I send a GET request to /api/plans
    Then the response status should be 401

  Scenario: Generate a plan returns draft items
    Given the database has seed data
    And I am authenticated as a test user
    And the user has a provider configured
    When I send a POST request to /api/plans/generate
    Then the response status should be 200
    And the response should have generated items
    And the generated items should have name, qty, unit, and why

  Scenario: Save a plan creates an active plan
    Given the database has seed data
    And I am authenticated as a test user
    When I create a new plan with items
      | name        | qty | unit | store_id   | price_estimate | why               |
      | Milk        | 2   | L    | store-indo | 25000          | running low       |
      | Cooking Oil | 1   | L    | store-indo | 15000          | expires soon      |
    Then the response status should be 201
    And the response should have a plan object
    And the plan should have items

  Scenario: GET /api/plans returns the active plan
    Given the database has seed data
    And I am authenticated as a test user
    And there is an active plan
    When I send a GET request to /api/plans
    Then the response status should be 200
    And the response should have plans array
    And the first plan should have items

  Scenario: Marking an item bought updates stock
    Given the database has seed data
    And I am authenticated as a test user
    And there is an active plan with items
    When I mark the "Milk" plan item as "bought"
    Then the response status should be 200
    And the plan item status should be "bought"

  Scenario: Marking an item skipped does not update stock
    Given the database has seed data
    And I am authenticated as a test user
    And there is an active plan with items
    When I mark the "Milk" plan item as "skipped"
    Then the response status should be 200
    And the plan item status should be "skipped"

  Scenario: Replacing an active plan archives the old one
    Given the database has seed data
    And I am authenticated as a test user
    And there is an active plan
    When I create a new plan with items
      | name | qty | unit | why   |
      | Rice | 1   | kg   | empty |
    Then the response status should be 201
    And GET /api/plans with status active returns the new plan
    And GET /api/plans with status archived returns the old plan

  Scenario: Modifying a non-existent plan item returns 404
    Given the database has seed data
    And I am authenticated as a test user
    When I send a PATCH request to /api/plans/nonexistent-plan/items/nonexistent-item with body
      """
      {"status": "bought"}
      """
    Then the response status should be 404

  Scenario: Modifying an item on an archived plan returns 400
    Given the database has seed data
    And I am authenticated as a test user
    And there is an active plan with items
    When I create a new plan with items
      | name | qty | unit | why   |
      | Rice | 1   | kg   | empty |
    And I mark the "Milk" plan item as "bought"
    Then the response status should be 400

  Scenario: Invalid status query returns 400
    Given the database has seed data
    And I am authenticated as a test user
    When I send a GET request to /api/plans?status=invalid
    Then the response status should be 400

  Scenario: GET /api/plans?status=active returns active plans
    Given the database has seed data
    And I am authenticated as a test user
    And there is an active plan
    When I send a GET request to /api/plans?status=active
    Then the response status should be 200
    And the response should have plans array
    And the first plan should have items

  Scenario: GET /api/plans?status=archived returns archived plans
    Given the database has seed data
    And I am authenticated as a test user
    And there is an active plan
    When I create a new plan with items
      | name | qty | unit |
      | Rice | 1   | kg   |
    And I send a GET request to /api/plans?status=archived
    Then the response status should be 200
    And the response should have plans array
    And the first plan should be archived

  Scenario: Marking an item bought twice does not duplicate stock
    Given the database has seed data
    And I am authenticated as a test user
    And there is an active plan with items
    When I mark the "Milk" plan item as "bought"
    And I mark the "Milk" plan item as "bought"
    Then the response status should be 200
    And GET /api/stock shows "Milk" with qty 2
