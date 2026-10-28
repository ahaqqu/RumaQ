Feature: Price promos view
  Shoppers browse the promo catalog on /prices?view=promos and jump from an
  example product into the explorer (issue #292). Price data is pushed
  through the internal ingest endpoint — the same fixtures the API feature
  suite uses, so the card counts mirror the explorer's on the same data.

  Scenario: Promos segment renders the groups in the fixed order
    Given a price snapshot and a promo snapshot have been pushed
    And I am logged in as the seeded test user
    When I navigate to "/prices?view=promos"
    Then the promos segment row should be visible
    And the promo cards should appear in order "Discount %,Buy One Get One,Other"
    And the "Discount %" card should show the "Lotte Mart 2" store badge

  Scenario: Expanding a card and clicking an example jumps into the explorer
    Given a price snapshot and a promo snapshot have been pushed
    And I am logged in as the seeded test user
    When I navigate to "/prices?view=promos"
    And I expand the "Discount %" promo card
    And I click the "Gula Pasir Gulaku 1 kg" promo example
    Then I should land on the products view with "Gula Pasir Gulaku 1 kg" expanded
    And the view param should be gone from the URL

  Scenario: The hash overrides the view param (deep-link precedence)
    Given a price snapshot and a promo snapshot have been pushed
    And I am logged in as the seeded test user
    When I navigate to "/prices?view=promos#gula-pasir--gulaku--1-kg"
    Then I should land on the products view with "Gula Pasir Gulaku 1 kg" expanded

  Scenario: Empty promo catalog renders the empty state with the segment visible
    Given a promo-free price snapshot has been pushed
    And I am logged in as the seeded test user
    When I navigate to "/prices?view=promos"
    Then the promos empty state should render with the segment visible
