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
