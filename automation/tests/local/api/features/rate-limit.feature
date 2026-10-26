Feature: Rate limiting
  AI and general API requests are throttled to prevent abuse. The daily AI
  usage cap only applies to the shared server key: requests made with the
  user's own stored key are uncapped by design (backend/src/lib/ai-access.ts),
  so exceeding the daily counter must not block BYO-key traffic.

  Scenario: AI scan with a user key is uncapped when the daily limit is exceeded
    Given the database has seed data
    And I am authenticated as a test user
    And the user has an AI key configured
    And the user has exceeded the AI usage limit
    When I send a POST request to /api/purchases/scan with a test image
    Then the response status should be 200

  Scenario: AI plan generation with a user key is uncapped when the daily limit is exceeded
    Given the database has seed data
    And I am authenticated as a test user
    And the user has an AI key configured
    And the user has exceeded the AI usage limit
    When I send a POST request to /api/plans/generate
    Then the response status should be 200

  Scenario: AI chat with a user key is uncapped when the daily limit is exceeded
    Given the database has seed data
    And I am authenticated as a test user
    And the user has an AI key configured
    And the user has exceeded the AI usage limit
    When I send a POST request to /api/ai/chat with body
      """
      {"message": "hello", "history": []}
      """
    Then the response status should be 200
