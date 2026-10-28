Feature: Scrape Now command queue
  The admin queues an on-demand, store-selectable scrape; the VPS agent
  claims it over the bearer-secret channel, streams the run's log lines as
  events, and posts a terminal finish — and the admin reads the live log
  and the command history back (docs/plan/scrape-now.md §3).

  Scenario: Queueing a scrape requires an authenticated session
    Given the API is running
    When I queue a scrape of the superindo store without a session
    Then the response status should be 401

  Scenario: Queueing a scrape requires an admin
    Given the API is running
    And I am authenticated as a non-admin user
    When I queue a scrape of the superindo store
    Then the response status should be 403

  Scenario: The agent needs the bearer secret to claim commands
    Given the API is running
    When the agent polls for the next scrape command with a wrong bearer token
    Then the response status should be 401

  Scenario: An unknown store slug is rejected
    Given I am authenticated as an admin
    When I queue a scrape of an unknown store
    Then the response status should be 400

  Scenario: The full agent lifecycle from queue to live log
    Given I am authenticated as an admin
    When I queue a scrape of the superindo and astro stores
    Then the response status should be 201
    And the stores endpoint should list every contract store
    When a second scrape is queued while the first is pending
    Then the response status should be 409
    And a second queue attempt while running should also return 409
    When the agent claims the next scrape command
    Then the claimed command should carry the requested stores
    And a second claim should return no command
    When the agent pushes the scrape log events
    Then the response status should be 200
    When the agent pushes the same log events again
    When the agent finishes the scrape command successfully
    When the admin reads the command feed
    Then the feed should show one successful command for the requested stores
    And the admin reading the incremental log after seq 0 should see only the tail
    And the full event log should hold exactly two events

  Scenario: A finished command refuses new events
    Given I am authenticated as an admin
    And a scrape command ran through the full agent lifecycle
    When the agent pushes events after the finish
    Then the response status should be 409

  Scenario: Repeating the finish never changes the recorded outcome
    Given I am authenticated as an admin
    And a scrape command ran through the full agent lifecycle
    When the agent repeats the finish with a conflicting outcome
    Then the feed should still show the original successful outcome
