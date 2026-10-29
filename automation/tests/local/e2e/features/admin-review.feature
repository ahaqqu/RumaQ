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
