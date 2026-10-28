Feature: Price explorer parity
  Authenticated shoppers browse brochure prices on /prices with server-side
  sort, promo badges, a freshness line, and #productKey deep links
  (issue #291). Price data is pushed through the internal ingest endpoint —
  the same fixtures the API feature suite uses.

  Scenario: Sort select reorders the list
    Given a price snapshot and a promo snapshot have been pushed
    And I am logged in as the seeded test user
    When I navigate to "/prices"
    Then the first product should be "Minyak Goreng Bimoli"
    When I sort the price list by "Expiring soon"
    Then the first product should be "Kopi Kapal Api 165 g"

  Scenario: Promo badges and the Save badge render on promo data
    Given a price snapshot and a promo snapshot have been pushed
    And I am logged in as the seeded test user
    When I navigate to "/prices"
    Then the list should show a "Diskon 12%" promo badge
    And the list should show a "Save 5%" badge

  Scenario: Freshness line reports the latest scrape
    Given a price snapshot and a promo snapshot have been pushed
    And I am logged in as the seeded test user
    When I navigate to "/prices"
    Then the prices page should show the freshness line

  Scenario: Deep link expands and scrolls to the product
    Given a price snapshot and a promo snapshot have been pushed
    And I am logged in as the seeded test user
    When I navigate to "/prices#gula-pasir--gulaku--1-kg"
    Then the expanded detail for "Gula Pasir Gulaku 1 kg" should show the cheapest chip
