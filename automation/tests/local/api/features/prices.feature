Feature: Price data ingest and explorer
  The rumaq-scraper pushes daily price snapshots to the internal ingest
  endpoint with a bearer secret, and authenticated users browse them
  through the price explorer API.

  Scenario: Ingest rejects pushes without a valid bearer token
    Given the API is running
    When the scraper pushes a price snapshot with a wrong bearer token
    Then the response status should be 401

  Scenario: Ingest accepts a valid daily snapshot
    Given the API is running
    When the scraper pushes a valid price snapshot
    Then the response status should be 200
    And the ingest should report accepted items

  Scenario: Re-pushing the same snapshot is idempotent
    Given the database has seed data
    And a valid price snapshot has been pushed
    When the scraper pushes the same price snapshot again
    Then the response status should be 200
    And the price explorer should still list one observation per product and store

  Scenario: Price explorer requires authentication
    Given the database has seed data
    And a valid price snapshot has been pushed
    When I send a GET request to /api/prices
    Then the response status should be 401

  Scenario: Price explorer lists latest observations with confidence flags
    Given the database has seed data
    And a valid price snapshot has been pushed
    And I am authenticated as a test user
    When I send a GET request to /api/prices
    Then the response status should be 200
    And the response should have prices array
    And the prices should include the ingested products with confidence flags

  Scenario: Price detail returns current prices and history
    Given the database has seed data
    And a valid price snapshot has been pushed
    And I am authenticated as a test user
    When I request the price detail for the ingested product
    Then the response status should be 200
    And the product should have current prices from both stores
    And the product should have history entries

  Scenario: A catalog store's promos land without the OCR flow (issue #322)
    Given the database has seed data
    And a catalog snapshot has been pushed
    And I am authenticated as a test user
    When I request the price detail for the alfamart promo
    Then the response status should be 200
    And the alfamart discount should claim discount_pct at the promo price
    And the alfamart campaign page should appear in no brochure group

  Scenario: Freshness status requires the ingest bearer secret
    Given the API is running
    When the scraper requests the price freshness status with a wrong bearer token
    Then the response status should be 401

  Scenario: Freshness status reports the latest observation
    Given the database has seed data
    And a valid price snapshot has been pushed
    When the scraper requests the price freshness status
    Then the response status should be 200
    And the status should report the latest observation date and count

  Scenario: Run report requires the ingest bearer secret
    Given the API is running
    When the scraper pushes a run report with a wrong bearer token
    Then the response status should be 401

  Scenario: Run report is recorded and visible to an admin
    Given the database has seed data
    And a valid price snapshot has been pushed
    When the scraper pushes a run report
    Then the response status should be 200
    And the admin sees the run in the monitor feed

  Scenario: Price explorer sorts by cheapest, savings, expiry, and name
    Given the database has seed data
    And a valid price snapshot has been pushed
    And a promo snapshot has been pushed
    And I am authenticated as a test user
    When I request the price list sorted by "cheapest"
    Then the response status should be 200
    And the product names should appear in order "Minyak,Kopi,Gula,Beras,Tepung"
    And the gula item should carry effective-price aggregates
    When I request the price list sorted by "savings"
    Then the response status should be 200
    And the product names should appear in order "Minyak,Gula,Beras,Kopi,Tepung"
    When I request the price list sorted by "expiry"
    Then the response status should be 200
    And the product names should appear in order "Kopi,Gula,Beras,Minyak,Tepung"
    When I request the price list sorted by "name"
    Then the response status should be 200
    And the product names should appear in order "Beras,Gula,Kopi,Minyak,Tepung"

  Scenario: Price explorer applies LIMIT after aggregation
    Given the database has seed data
    And a bulk catalogue of 205 single-source products has been pushed
    And I am authenticated as a test user
    When I request the price list sorted by "savings"
    Then the response status should be 200
    And the page should hold the 201st product and flag truncation
    When I search the sorted price list for "Item 3"
    Then the response status should be 200
    And the page should hold 11 complete products without truncation

  Scenario: Price detail orders current offers by the effective price
    Given the database has seed data
    And a valid price snapshot has been pushed
    And a promo snapshot has been pushed
    And I am authenticated as a test user
    When I request the price detail for the promo product
    Then the response status should be 200
    And the first current offer should be the effective-price cheapest store

  Scenario: Price freshness meta requires authentication
    Given the database has seed data
    And a valid price snapshot has been pushed
    When I send an unauthenticated GET request to /api/prices/meta
    Then the response status should be 401

  Scenario: Price freshness meta reports the latest scrape
    Given the database has seed data
    And a valid price snapshot has been pushed
    And I am authenticated as a test user
    When I request the price freshness meta
    Then the response status should be 200
    And the meta should report the latest scrape time and count
    And the meta response should be private and no-cache

  Scenario: Promos catalog requires authentication
    Given the database has seed data
    And a valid price snapshot has been pushed
    When I send an unauthenticated GET request to /api/prices/promos
    Then the response status should be 401

  Scenario: Promos catalog groups current observations with explorer count parity
    Given the database has seed data
    And a valid price snapshot has been pushed
    And I am authenticated as a test user
    When I request the promo catalog
    Then the response status should be 200
    And the promo catalog response should be private and no-cache
    And the promo groups should appear in order "discount_pct,get_free,other"
    And the promo counts should match the explorer per type
    And the Other group should hold the label-only product
    And the promo catalog should not double-count products across stores

  Scenario: Promos catalog is empty without promo observations
    Given the database has seed data
    And a bulk catalogue of 3 single-source products has been pushed
    And I am authenticated as a test user
    When I request the promo catalog
    Then the response status should be 200
    And the promo catalog should have no groups
