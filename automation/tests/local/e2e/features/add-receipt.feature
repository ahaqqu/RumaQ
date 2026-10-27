Feature: Add From Receipt
  The receipt flow scans an uploaded receipt image, shows the parsed items
  for review, and adds them to stock on confirm. The local test stack
  returns a fixed parse result when TEST_MODE is on.

  Background:
    Given I am logged in as the seeded test user
    And the test user has an AI key configured

  Scenario: Scan, review, and confirm adds items to stock
    When I navigate to "/add"
    And I upload the receipt fixture image
    Then the review should show the scanned item "Susu cair 1L"
    And the review should show the scanned item "Roti tawar"
    And the review should show the scanned item "Telur 10pcs"
    When I confirm the scanned purchase
    Then the confirmation should say 3 items were added
    And the inventory should list the new stock item "Susu cair 1L"

  Scenario: Unsupported file type is rejected
    When I navigate to "/add"
    And I upload a non-image file
    Then the unsupported file type error should be shown
