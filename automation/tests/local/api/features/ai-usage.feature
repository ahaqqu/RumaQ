Feature: AI Usage
  Every completed AI call records one ai_usage_events row and usage never
  caps a call — the daily limit was removed unconditionally (issue #353).
  The user endpoint sums today's events; the admin endpoint exposes totals
  and a per-user breakdown over a recent range.

  Scenario: Unauthenticated access returns 401
    Given the database has seed data
    When I send a GET request to /api/ai/usage
    Then the response status should be 401

  Scenario: GET usage returns zeroed uncapped totals for a new user
    Given the database has seed data
    And I am authenticated as a test user
    When I send a GET request to /api/ai/usage
    Then the response status should be 200
    And usage should show zeroed totals with no daily limit

  Scenario: A completed chat call is recorded exactly once
    Given the database has seed data
    And I am authenticated as a test user
    And the user has an AI key configured
    When I send a chat message "What should I buy?"
    Then the response status should be 200
    And GET usage shows 1 recorded call today

  Scenario: Heavy recorded usage never blocks AI calls
    # Cap-removal guard (issue #353): volume is recorded but must never gate
    # a call, on the user key or the shared server key alike.
    Given the database has seed data
    And I am authenticated as a test user
    And the user has an AI key configured
    And the user already has 5 usage events today
    When I send a chat message "What should I buy?"
    Then the response status should be 200
    When I send a POST request to /api/plans/generate
    Then the response status should be 200
    When I upload a receipt image for scanning
    Then the response status should be 200

  Scenario: Admin usage endpoint returns totals and per-user rows for an admin
    Given the database has seed data
    And I am authenticated as a test user
    And the user already has 3 usage events today
    When I send a GET request to /api/admin/ai/usage?range=24h
    Then the response status should be 200
    And the admin usage shows 3 calls for the test user

  Scenario: Admin usage endpoint returns 403 for a non-admin
    Given the database has seed data
    And I am authenticated as a test user
    And the test user is not an admin
    When I send a GET request to /api/admin/ai/usage?range=7d
    Then the response status should be 403
