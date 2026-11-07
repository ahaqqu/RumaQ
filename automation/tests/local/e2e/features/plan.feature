Feature: Shopping Plan
  The plan page generates an AI shopping plan grouped by store and lets the
  user save it and check off items. The local test stack mocks the AI
  generate endpoint when TEST_MODE is on, so no real AI key is needed.

  Background:
    Given I am logged in as the seeded test user

  Scenario: Plan page shows the connect-key state without an AI key
    When I navigate to "/plan"
    Then the plan page should ask to connect an API key

  # #523 P1: the resolver reads the household's ai_providers/ai_capabilities and
  # the legacy PATCH /api/settings ai_key write is DEAD until P3 (design §3.4,
  # §4.3), so there is no access to generate with. Pending, NOT deleted: P3
  # reactivates it once the provider/capability endpoints land.
  @skip
  Scenario: Generate produces draft items grouped by store
    Given the test user has an AI key configured
    When I navigate to "/plan"
    And I generate a plan
    Then the generated draft should list "Susu cair 1L"
    And the generated draft should list "Roti tawar"

  # #523 P1: the resolver reads the household's ai_providers/ai_capabilities and
  # the legacy PATCH /api/settings ai_key write is DEAD until P3 (design §3.4,
  # §4.3), so there is no access to generate with. Pending, NOT deleted: P3
  # reactivates it once the provider/capability endpoints land.
  @skip
  Scenario: Saving the draft creates the active plan
    Given the test user has an AI key configured
    When I navigate to "/plan"
    And I generate a plan
    And I save the draft plan
    Then the active plan should list "Susu cair 1L"

  # #523 P1: the resolver reads the household's ai_providers/ai_capabilities and
  # the legacy PATCH /api/settings ai_key write is DEAD until P3 (design §3.4,
  # §4.3), so there is no access to generate with. Pending, NOT deleted: P3
  # reactivates it once the provider/capability endpoints land.
  @skip
  Scenario: Checking off a plan item marks it bought and persists
    Given the test user has an AI key configured
    When I navigate to "/plan"
    And I generate a plan
    And I save the draft plan
    And I check off the item "Susu cair 1L"
    Then the item "Susu cair 1L" should be marked bought
    When I reload the page
    Then the item "Susu cair 1L" should still be marked bought
