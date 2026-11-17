Feature: Admin catalog promos tab
  Admins review the promo chips on /admin/catalog?tab=promos (issue #717: the
  Review sub-view lists every captured chip verbatim per item with
  presentation-only class tags) and browse the promo catalog cards (issue #673
  moved the surface off /prices), jumping from an example product into the
  user explorer. Price data is pushed through the internal ingest endpoint —
  the same fixtures the API feature suite uses, so the card counts mirror the
  explorer's on the same data.

  Scenario: The Review sub-view lists every promo chip verbatim per row (#717)
    Given a price snapshot and a promo snapshot have been pushed
    And I am logged in as the seeded test user
    When I navigate to "/admin/catalog?tab=promos"
    Then the promos tab row should be visible
    And the promo review table should list 6 rows
    And the "Diskon 5%" promo chip should render verbatim
    And the "Harga" promo chip should not render
    And the promo review should tag the "Discount %" class
    And the promo review should tag the "Buy-get" class

  Scenario: The review narrows by store (#717)
    Given a price snapshot and a promo snapshot have been pushed
    And I am logged in as the seeded test user
    When I navigate to "/admin/catalog?tab=promos"
    And I select "Lotte Mart" in the promo review store filter
    Then the promo review table should list 3 rows

  Scenario: Promos tab renders the catalog groups in the fixed order behind the sub-view
    Given a price snapshot and a promo snapshot have been pushed
    And I am logged in as the seeded test user
    When I navigate to "/admin/catalog?tab=promos"
    And I open the promos "Catalog" sub-view
    Then the promo cards should appear in order "Discount %,Buy One Get One,Other"
    And the "Discount %" card should show the "Lotte Mart 2" store badge

  Scenario: Expanding a card and clicking an example jumps into the explorer
    Given a price snapshot and a promo snapshot have been pushed
    And I am logged in as the seeded test user
    When I navigate to "/admin/catalog?tab=promos"
    And I open the promos "Catalog" sub-view
    And I expand the "Discount %" promo card
    And I click the "Gula Pasir Gulaku 1 kg" promo example
    Then I should land on the products view with "Gula Pasir Gulaku 1 kg" expanded
    And the promos tab param should be gone from the URL

  Scenario: The hash overrides the tab param (deep-link precedence)
    Given a price snapshot and a promo snapshot have been pushed
    And I am logged in as the seeded test user
    When I navigate to "/admin/catalog?tab=promos#gula-pasir--gulaku--1-kg"
    Then I should land on the products view with "Gula Pasir Gulaku 1 kg" expanded

  Scenario: Empty promo data renders both sub-views' empty states
    Given a promo-free price snapshot has been pushed
    And I am logged in as the seeded test user
    When I navigate to "/admin/catalog?tab=promos"
    Then the promo review empty state should render with the tab visible
    When I open the promos "Catalog" sub-view
    Then the promos empty state should render with the tab visible
