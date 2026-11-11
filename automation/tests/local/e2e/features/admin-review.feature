Feature: Admin review queue
  The admin triages the matcher's flagged candidate pairs at /admin/review:
  side-by-side compare, decide, reload-persistent verdicts, undo, and the
  versioned decisions export — while the monitor cross-links here (issue
  #294). The queue is seeded through the same bearer channel the real
  scraper reports on.

  Scenario: Deciding a flagged pair persists across a reload
    Given the queue holds one flagged pair
    And I am logged in as the seeded test user
    When I navigate to "/admin/review"
    Then the queue shows the flagged pair side by side
    When I approve the flagged pair
    Then the pair shows the approved verdict
    When I reload the review page
    Then the verdict is still approved
    When I undo the verdict
    Then the pair is pending again

  Scenario: Filtering the queue by flag reason
    Given the queue holds one pair for each flag reason
    And I am logged in as the seeded test user
    When I navigate to "/admin/review"
    Then the pending split shows one pair per reason
    When I filter the queue by the taxonomy reason
    Then only the taxonomy pair is listed
    And the pending counts stay whole-queue

  Scenario: The AI review mode switch persists across a reload
    Given I am logged in as the seeded test user
    When I navigate to "/admin/review"
    And I switch the AI review mode to full auto
    Then the full-auto review mode is selected
    When I reload the review page as-is
    Then the full-auto review mode is selected

  Scenario: Agreeing with a cached AI verdict records AI-assisted provenance
    Given I am logged in as the seeded test user
    And the queue holds one flagged pair with a cached AI verdict
    When I navigate to "/admin/review"
    Then the queue shows the cached AI verdict
    When I agree with the AI verdict
    Then the pair records AI-assisted provenance

  Scenario: Exporting decisions downloads the versioned file
    Given the queue holds one flagged pair
    And I am logged in as the seeded test user
    When I navigate to "/admin/review"
    And I approve the flagged pair
    And I export the decisions
    Then the download is named review_decisions.json
    And the export body contains the decided row with schema 1

  Scenario: The monitor links flagged counts to the review queue
    Given the queue holds one flagged pair
    And I am logged in as the seeded test user
    When I navigate to "/admin/prices"
    And I expand the first run
    Then the flagged count links to the review queue

  Scenario: Non-admins are turned away from the review queue
    Given the queue holds one flagged pair
    And I am logged in as a non-admin user
    When I navigate to "/admin/review"
    Then the review page shows the forbidden state
