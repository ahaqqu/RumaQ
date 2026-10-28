Feature: Scrape Now
  The allowlisted admin queues an on-demand, store-selectable scrape from
  /admin/scrape and watches the queued command (docs/plan/scrape-now.md §4).
  The local stack has no VPS agent, so a queued command stays pending —
  exactly the state the live view must surface.

  Scenario: Admin sees the store-selectable trigger
    Given I am logged in as the seeded test user
    When I navigate to "/admin/scrape"
    Then the scrape page lists the stores
    And the scrape now button should be disabled

  Scenario: Selecting a store arms the trigger
    Given I am logged in as the seeded test user
    When I navigate to "/admin/scrape"
    And I select the "superindo" store on the scrape page
    Then the scrape now button should be enabled

  Scenario: Queued scrape shows as the active run
    Given I am logged in as the seeded test user
    When I navigate to "/admin/scrape"
    And I select the "superindo" store on the scrape page
    And I queue the selected scrape
    Then the queued scrape should show as the active run
    And the scrape now button should be disabled
