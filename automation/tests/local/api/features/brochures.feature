Feature: Brochure image hosting and brochures catalog
  The scraper uploads brochure images through the internal PUT endpoint and
  stores observations pointing at the same-origin object URLs; authenticated
  users browse the groups on /api/prices/brochures and the proxy serves the
  images. The retention sweep piggybacks on the ingest POST (issue #293).

  Scenario: Brochure upload requires the ingest bearer secret
    Given the API is running
    When the scraper uploads a brochure image with a wrong bearer token
    Then the response status should be 401

  Scenario: Uploaded brochure bytes round-trip through the authenticated proxy
    Given the database has seed data
    And a brochure image has been uploaded for the fixture key
    And a brochure snapshot has been pushed
    And I am authenticated as a test user
    When I request the brochure image for the fixture key
    Then the response status should be 200
    And the image body should round-trip with the stored content type and private day caching

  Scenario: Serving a brochure requires authentication
    Given the database has seed data
    And a brochure image has been uploaded for the fixture key
    When I request the brochure image without a session
    Then the response status should be 401

  Scenario: An unknown brochure key answers 404
    Given the database has seed data
    And I am authenticated as a test user
    When I request a brochure image that was never uploaded
    Then the response status should be 404

  Scenario: Brochures listing requires authentication
    Given the database has seed data
    And a brochure snapshot has been pushed
    When I request the brochures catalog without a session
    Then the response status should be 401

  Scenario: Brochures catalog groups current observations with explorer count parity
    Given the database has seed data
    And a brochure snapshot has been pushed
    And I am authenticated as a test user
    When I request the brochures catalog
    Then the response status should be 200
    And the brochure groups should appear in store-then-date order
    And the brochure counts should match the explorer per brochure page
    And the legacy retailer-page URL should appear in no group

  Scenario: Retention sweep deletes unreferenced past-grace objects and keeps the rest
    Given the database has seed data
    And brochure images exist with an old referenced key, an old unreferenced key, and a fresh unreferenced key
    When a brochure snapshot referencing the old referenced key has been pushed
    Then the ingest should succeed and the sweep should keep the referenced and fresh objects and delete the old unreferenced one
