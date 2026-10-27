Feature: Settings
  The settings page manages storage locations and recorded stores with
  immediate create/delete.

  Background:
    Given I am logged in as the seeded test user

  Scenario: Seeded locations and stores are listed
    When I navigate to "/settings"
    Then the location "Kitchen" should be listed
    And the location "Fridge" should be listed
    And the store "Indomaret" should be listed

  Scenario: Adding and removing a location
    When I navigate to "/settings"
    And I add the location "Bathroom"
    Then the location "Bathroom" should be listed
    When I delete the location "Bathroom"
    Then the location "Bathroom" should not be listed

  Scenario: Adding and removing a store
    When I navigate to "/settings"
    And I add the store "Giant"
    Then the store "Giant" should be listed
    When I delete the store "Giant"
    Then the store "Giant" should not be listed
