Feature: Admin brochure ingestion QA
  Admins browse the brochure pages behind the current prices from
  /admin/catalog?tab=brochures, select a card, and review every ingested
  product with its full metadata in place (issue #630; the view moved off
  /prices in #631). One fixture image is uploaded through the internal PUT
  endpoint; the other card's object is deliberately never uploaded so the
  fallback block can be asserted.

  Scenario: The old brochure deep link redirects to the admin catalog
    Given a brochure snapshot has been pushed with one image uploaded
    And I am logged in as the seeded test user
    When I navigate to "/prices?view=brochures"
    Then I should be on the admin catalog brochures tab
    And the catalog tab row should be visible
    And the brochure grid should show cards for "Lotte Mart,Superindo"
    And the "Lotte Mart" card should show the uploaded brochure image

  Scenario: Selecting a card reviews every product and expands its metadata in place
    Given a brochure snapshot has been pushed with one image uploaded
    And I am logged in as the seeded test user
    When I navigate to "/admin/catalog?tab=brochures"
    And I select the "Lotte Mart" brochure card
    Then the brochure review should show "Gula Pasir Gulaku 1 kg"
    And I expand the "Gula Pasir Gulaku 1 kg" product row
    Then the ingestion metadata should show the product key, store, and brochure URL
    And I should stay on the admin catalog brochures tab

  Scenario: The hash overrides the tab param (deep-link precedence)
    Given a brochure snapshot has been pushed with one image uploaded
    And I am logged in as the seeded test user
    When I navigate to "/prices?view=brochures#gula-pasir--gulaku--1-kg"
    Then I should land on the products view with "Gula Pasir Gulaku 1 kg" expanded

  Scenario: A missing brochure image degrades to the fallback block
    Given a brochure snapshot has been pushed with one image uploaded
    And I am logged in as the seeded test user
    When I navigate to "/admin/catalog?tab=brochures"
    Then the "Superindo" card should render the fallback block instead of a broken image

  Scenario: Empty brochure catalog renders the empty state with the tabs visible
    Given a promo-free price snapshot has been pushed
    And I am logged in as the seeded test user
    When I navigate to "/admin/catalog?tab=brochures"
    Then the brochures empty state should render with the tabs visible
