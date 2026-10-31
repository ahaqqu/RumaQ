Feature: Home Dashboard
  The home dashboard provides an overview of stock status.

  Scenario: Unauthenticated access returns 401
    Given the database has seed data
    When I send a GET request to /api/home
    Then the response status should be 401

  Scenario: Home returns zero stats for a new user
    Given the database has seed data
    And I am authenticated as a test user
    When I send a GET request to /api/home
    Then the response status should be 200
    And the home response should have required stats
    And the total items should be 3
    And the expiring within 7 days should be 0
    And there should be items running out within 7 days

  Scenario: Home low_stock list has items
    Given the database has seed data
    And I am authenticated as a test user
    When I send a GET request to /api/home
    Then the response status should be 200
    And the low_stock array should have items
    And each low stock item should have id, name, qty, unit, and location

  Scenario: Home returns current month spending
    Given the database has seed data
    And I am authenticated as a test user
    When I send a GET request to /api/home
    Then the response status should be 200
    And the home response should have required stats
    And the current month spending should be present

  Scenario: Home has authenticated cache headers
    Given the database has seed data
    And I am authenticated as a test user
    When I send a GET request to /api/home
    Then the response status should be 200
    And the response should have authenticated cache headers
