Feature: AI Persona copy rewrite
  POST /api/ai/generate/persona rewrites the app's interface copy behind the
  door (#523 P5). The local stack runs TEST_MODE, so a configured household
  gets its own strings echoed back and no vendor is reached.

  Scenario: Unauthenticated access returns 401
    Given the database has seed data
    When I rewrite the persona copy
    Then the response status should be 401

  Scenario: No reasoning assignment returns 402
    Given the database has seed data
    And I am authenticated as a test user
    When I rewrite the persona copy
    Then the response status should be 402

  Scenario: A configured household gets its own copy echoed back
    Given the database has seed data
    And the test user has a provider configured
    And I am authenticated as a test user
    When I rewrite the persona copy
    Then the response status should be 200
    And the rewritten copy should echo the built-in strings
    And the response should be private and uncached
