Feature: Admin brochure catalog
  Admins browse the brochure pages behind the current prices from
  /admin/catalog?tab=brochures and jump from an example product into the
  admin product lookup (issue #631; the view used to live on
  /prices?view=brochures). One fixture image is uploaded through the internal
  PUT endpoint; the other card's object is deliberately never uploaded so the
  fallback block can be asserted.

  Scenario: The old brochure deep link redirects to the admin catalog
    Given a brochure snapshot has been pushed with one image uploaded
    And I am logged in as the seeded test user
    When I navigate to "/prices?view=brochures"
    Then I should be on the admin catalog brochures tab
    And the catalog tab row should be visible
    And the store sections should appear in order "Lotte Mart,Superindo"
    And the "Lotte Mart" card should show the uploaded brochure image

  Scenario: Expanding a card and clicking an example jumps into the catalog lookup
    Given a brochure snapshot has been pushed with one image uploaded
    And I am logged in as the seeded test user
    When I navigate to "/admin/catalog?tab=brochures"
    And I expand the "Lotte Mart" brochure card
    And I click the "Gula Pasir Gulaku 1 kg" brochure example
    Then I should land on the products view with "Gula Pasir Gulaku 1 kg" expanded
    And the old brochures view param should be gone from the URL

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
