Feature: Inventory
  The inventory page lists household stock with search, location filtering,
  and quick quantity updates.

  Background:
    Given I am logged in as the seeded test user

  Scenario: Seeded stock items are listed
    When I navigate to "/inventory"
    Then I should see the stock item "Rice"
    And I should see the stock item "Cooking Oil"
    And I should see the stock item "Eggs"

  Scenario: Search filters stock items
    When I navigate to "/inventory"
    And I search for "rice"
    Then I should see the stock item "Rice"
    And I should not see the stock item "Eggs"

  Scenario: Search with no match shows the empty state
    When I navigate to "/inventory"
    And I search for "xyzzy-nothing"
    Then the inventory should show the empty state

  Scenario: Location filter narrows the list
    When I navigate to "/inventory"
    And I filter by the location "Fridge"
    Then I should see the stock item "Eggs"
    And I should not see the stock item "Rice"

  Scenario: Quantity can be increased and decreased
    When I navigate to "/inventory"
    And I increase the quantity of "Rice"
    Then the stock item "Rice" should show quantity "3 kg"
    When I decrease the quantity of "Rice"
    Then the stock item "Rice" should show quantity "2 kg"
