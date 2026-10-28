Feature: Price brochures view
  Shoppers browse the brochure pages behind the current prices on
  /prices?view=brochures and jump from an example product into the explorer
  (issue #293). One fixture image is uploaded through the internal PUT
  endpoint; the other card's object is deliberately never uploaded so the
  fallback block can be asserted.

  Scenario: Brochures segment renders store sections with dates newest-first
    Given a brochure snapshot has been pushed with one image uploaded
    And I am logged in as the seeded test user
    When I navigate to "/prices?view=brochures"
    Then the brochures segment row should be visible
    And the store sections should appear in order "Lotte Mart,Superindo"
    And the Lotte Mart card should show the uploaded brochure image

  Scenario: Expanding a card and clicking an example jumps into the explorer
    Given a brochure snapshot has been pushed with one image uploaded
    And I am logged in as the seeded test user
    When I navigate to "/prices?view=brochures"
    And I expand the "Lotte Mart" brochure card
    And I click the "Gula Pasir Gulaku 1 kg" brochure example
    Then I should land on the products view with "Gula Pasir Gulaku 1 kg" expanded
    And the view param should be gone from the URL

  Scenario: The hash overrides the view param (deep-link precedence)
    Given a brochure snapshot has been pushed with one image uploaded
    And I am logged in as the seeded test user
    When I navigate to "/prices?view=brochures#gula-pasir--gulaku--1-kg"
    Then I should land on the products view with "Gula Pasir Gulaku 1 kg" expanded

  Scenario: A missing brochure image degrades to the fallback block
    Given a brochure snapshot has been pushed with one image uploaded
    And I am logged in as the seeded test user
    When I navigate to "/prices?view=brochures"
    Then the "Superindo" card should render the fallback block instead of a broken image

  Scenario: Empty brochure catalog renders the empty state with the segment visible
    Given a promo-free price snapshot has been pushed
    And I am logged in as the seeded test user
    When I navigate to "/prices?view=brochures"
    Then the brochures empty state should render with the segment visible
