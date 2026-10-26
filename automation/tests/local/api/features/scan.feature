Feature: Receipt Scan
  The scan API parses receipt images via AI OCR.

  Scenario: Unauthenticated access returns 401
    Given the database has seed data
    When I send a POST request to /api/purchases/scan
    Then the response status should be 401

  Scenario: Scan returns parsed items with AI key configured
    Given the database has seed data
    And I am authenticated as a test user
    And the user has an AI key configured
    When I upload a receipt image for scanning
    Then the response status should be 200
    And the response should contain parsed items
    And the response should contain an imageKey
    And the store guess should be "Indomaret"

  Scenario: Scan without AI key returns 402
    Given the database has seed data
    And I am authenticated as a test user
    And the user has no AI key configured
    When I send a POST request to /api/purchases/scan with a test image
    Then the response status should be 402

  Scenario: Scan with a user key is uncapped when the daily limit is exceeded
    # The daily AI cap only applies to the shared server key; a user's own
    # key is uncapped by design (backend/src/lib/ai-access.ts).
    Given the database has seed data
    And I am authenticated as a test user
    And the user has exceeded the AI usage limit
    When I send a POST request to /api/purchases/scan with a test image
    Then the response status should be 200

  Scenario: Scan with non-image file returns 400
    Given the database has seed data
    And I am authenticated as a test user
    When I upload a non-image file for scanning
    Then the response status should be 400
