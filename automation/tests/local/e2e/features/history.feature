Feature: Purchase History
  The history page lists purchases grouped by month with totals, and
  supports search and store filtering.

  Background:
    Given I am logged in as the seeded test user

  Scenario: Seeded purchases are grouped by month with totals
    When I navigate to "/history"
    Then the month group "Jun 2026" should be visible
    And the history total should show "250000"
    And the purchase item "Cooking Oil" should be visible
    And the purchase item "Milk" should be visible

  Scenario: Store filter narrows purchases
    When I navigate to "/history"
    And I filter history by the store "Indomaret"
    Then the purchase item "Cooking Oil" should be visible
    And the purchase item "Milk" should not be visible

  Scenario: Search returns the purchases containing the item
    # The API search matches whole purchases, so every item of a matched
    # purchase stays visible: "milk" selects the Superindo purchase, which
    # also contains Rice, but no purchase with Cooking Oil.
    When I navigate to "/history"
    And I search history for "milk"
    Then the purchase item "Milk" should be visible
    And the purchase item "Rice" should be visible
    And the purchase item "Cooking Oil" should not be visible
