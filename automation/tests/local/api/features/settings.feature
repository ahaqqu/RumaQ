Feature: User Settings
  The settings API manages user preferences and reports the household AI
  configuration. Keys live only on AI provider rows and never in this payload.

  Scenario: Unauthenticated access returns 401
    Given the database has seed data
    When I send a GET request to /api/settings
    Then the response status should be 401

  Scenario: GET settings returns preferences and an empty AI block
    Given the database has seed data
    And I am authenticated as a test user
    When I send a GET request to /api/settings
    Then the response status should be 200
    And the settings should include motion_preference and the AI block
    And every AI capability should be not configured
    And the response should not contain key material

  Scenario: PATCH settings rejects the retired AI key fields
    Given the database has seed data
    And I am authenticated as a test user
    When I send a PATCH request to /api/settings with body
      """
      {"ai_key": "sk-test-key-12345", "ai_provider": "gemini"}
      """
    Then the response status should be 400

  Scenario: PATCH settings updates persona
    Given the database has seed data
    And I am authenticated as a test user
    When I send a PATCH request to /api/settings with body
      """
      {"persona_user_role": "chef", "persona_ai_role": "assistant", "persona_enabled": true}
      """
    Then the response status should be 200
    And setting "persona_user_role" should be "chef"
    And setting "persona_enabled" should be true

  Scenario: A configured provider and capability show up in GET settings
    Given the database has seed data
    And I am authenticated as a test user
    And the user has a provider configured for "reasoning"
    When I send a GET request to /api/settings
    Then the response status should be 200
    And the settings should include motion_preference and the AI block
    And the reasoning capability should resolve to a household provider
    And the response should not contain key material
