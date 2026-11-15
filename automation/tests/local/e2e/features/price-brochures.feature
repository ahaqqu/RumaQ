Feature: User brochure gallery and the admin QA tab
  Users browse the brochure pages behind the current prices from
  /prices?view=brochures — a lean card gallery with store/date filters and
  none of the ingestion-QA fields (issue #673). Each card carries an
  explicit View link (#674) that opens the chrome-less full-mode viewer in a
  new browser tab: no left menu, no site header, just the RumaQ logo, the
  brochure title, a Share button, and the page image. The #630 QA browser
  stays admin-side as the /admin/catalog Brochures QA tab: selecting a card
  opens the full product table and a row expands its metadata in place. One
  fixture image is uploaded through the internal PUT endpoint; the other
  card's object is deliberately never uploaded so the fallback block can be
  asserted.

  Scenario: The user gallery renders the brochure grid without QA fields
    Given a brochure snapshot has been pushed with one image uploaded
    And I am logged in as the seeded test user
    When I navigate to "/prices?view=brochures"
    Then the prices segment row should be visible
    And the brochure grid should show cards for "Lotte Mart,Superindo"
    And the "Lotte Mart" card should show the uploaded brochure image
    And the gallery should show no ingestion-QA metadata

  Scenario: A missing brochure image degrades to the fallback block
    Given a brochure snapshot has been pushed with one image uploaded
    And I am logged in as the seeded test user
    When I navigate to "/prices?view=brochures"
    Then the "Superindo" card should render the fallback block instead of a broken image

  Scenario: The hash overrides the view param (deep-link precedence)
    Given a brochure snapshot has been pushed with one image uploaded
    And I am logged in as the seeded test user
    When I navigate to "/prices?view=brochures#gula-pasir--gulaku--1-kg"
    Then I should land on the products view with "Gula Pasir Gulaku 1 kg" expanded

  Scenario: The admin Brochures QA tab reviews products and metadata in place
    Given a brochure snapshot has been pushed with one image uploaded
    And I am logged in as the seeded test user
    When I navigate to "/admin/catalog?tab=brochures-qa"
    And I select the "Lotte Mart" brochure card
    Then the brochure review should show "Gula Pasir Gulaku 1 kg"
    And I expand the "Gula Pasir Gulaku 1 kg" product row
    Then the ingestion metadata should show the product key, store, and brochure URL
    And the brochure QA view should have no critical or serious axe violations
    And I should stay on the admin catalog brochures QA tab

  Scenario: Empty brochure catalog renders the gallery empty state
    Given a promo-free price snapshot has been pushed
    And I am logged in as the seeded test user
    When I navigate to "/prices?view=brochures"
    Then the brochures empty state should render with the segments visible

  Scenario: Viewing a brochure opens the full mode in a new tab (#674)
    Given a brochure snapshot has been pushed with one image uploaded
    And I am logged in as the seeded test user
    When I navigate to "/prices?view=brochures"
    And I open the "Lotte Mart" brochure viewer from its card
    Then the viewer tab should render the full mode for "Lotte Mart"
    And the viewer tab should render no app shell chrome

  Scenario: The viewer URL is deep-linkable on a fresh load (#674)
    Given a brochure snapshot has been pushed with one image uploaded
    And I am logged in as the seeded test user
    When I open the brochure viewer deep link directly
    Then the viewer tab should render the full mode for "Lotte Mart"
    And the viewer tab should render no app shell chrome

  Scenario: The viewer share button falls back to copy-link (#674)
    Given a brochure snapshot has been pushed with one image uploaded
    And I am logged in as the seeded test user
    When I open the brochure viewer deep link directly
    And I share the brochure without a native share sheet
    Then the clipboard should hold the viewer link and the copied status should confirm it
