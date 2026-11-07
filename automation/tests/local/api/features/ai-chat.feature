Feature: AI Chat
  The AI chat endpoint provides a conversational assistant for household inventory and planning.

  Scenario: Unauthenticated access returns 401
    Given the database has seed data
    When I send a POST request to /api/ai/chat
    Then the response status should be 401

  Scenario: No AI key returns 402
    Given the database has seed data
    And I am authenticated as a test user
    When I send a chat message "What should I buy?"
    Then the response status should be 402

  Scenario: Chat returns a reply with a configured provider
    Given the database has seed data
    And the test user has a provider configured
    And I am authenticated as a test user
    When I send a chat message "What should I buy?"
    Then the response status should be 200
    And the response should have a chat reply
