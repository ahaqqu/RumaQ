Feature: Match review queue
  The matcher reports flagged candidate pairs on the run report (bearer
  channel); the admin triages them in the review queue — list with exact
  counts, decide, undo, and a full versioned export (issue #294).

  Scenario: The review queue requires an authenticated session
    Given the API is running
    When I read the review queue without a session
    Then the response status should be 401

  Scenario: The review queue requires an admin
    Given the API is running
    And I am authenticated as a non-admin user
    When I read the review queue
    Then the response status should be 403

  Scenario: The agent needs the bearer secret to post run reports
    Given the API is running
    When the agent posts a run report with a wrong bearer token
    Then the response status should be 401

  Scenario: An invalid verdict is rejected
    Given I am authenticated as an admin
    And the agent posted a run report carrying two flagged pairs
    When I try to decide with an invalid verdict
    Then the response status should be 400

  Scenario: An unknown review item refuses decisions
    Given I am authenticated as an admin
    When I decide on an unknown review item
    Then the response status should be 404

  Scenario: Flagged pairs flow from the run report through decide, undo, and export
    Given I am authenticated as an admin
    And the agent posted a run report carrying two flagged pairs
    When I read the review queue
    Then the queue should list two pending pairs with exact counts
    When I approve the first pair
    Then the pair should carry the approved verdict and the admin id
    And the counts should show one approved and one pending
    When I read the review queue again
    Then the verdict should still be approved
    When I undo the verdict
    Then the pair should be pending again with the decision cleared
    When I export the decisions
    Then the export should contain no decided rows
    When I approve the first pair again
    When I export the decisions again
    Then the export should contain the decided row with schema 1

  Scenario: A decided pair is never reopened by a re-flag
    Given I am authenticated as an admin
    And the agent posted a run report carrying two flagged pairs
    And I approved the first pair
    When the agent posts a later run report re-flagging the same pair
    And I read the review queue
    Then the pair should still be approved with a higher flag count

  Scenario: A replayed report is a no-op (the scraper's report retry is safe)
    Given I am authenticated as an admin
    And the agent posted a run report carrying two flagged pairs
    When the agent replays the exact same report (same runStartedAt)
    And I read the review queue
    Then the pairs should still show one flag each with unchanged counts

  Scenario: A run report without review pairs still records (old scraper)
    Given I am authenticated as an admin
    When the agent posts a run report without review pairs
    Then the response status should be 200
    And the review queue should be empty
