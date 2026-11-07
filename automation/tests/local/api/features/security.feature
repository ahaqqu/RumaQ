Feature: Cross-household security
  Authenticated users must only see and modify resources in their own household.

  Scenario: User A cannot read User B's stock
    Given the database has seed data
    And I am authenticated as a second test user
    When I send a GET request to /api/stock
    Then the response status should be 200
    And the stock array should be empty

  Scenario: User A cannot modify User B's stock
    Given the database has seed data
    And I am authenticated as a second test user
    When I send a PATCH request to /api/stock/stock-rice with body
      """
      {"qty": 99}
      """
    Then the response status should be 404

  Scenario: User A cannot read User B's locations
    Given the database has seed data
    And I am authenticated as a second test user
    When I send a GET request to /api/locations
    Then the response status should be 200
    And the locations array should be empty

  Scenario: User A cannot read User B's stores
    Given the database has seed data
    And I am authenticated as a second test user
    When I send a GET request to /api/stores
    Then the response status should be 200
    And the stores array should be empty

  Scenario: User A cannot read User B's purchases
    Given the database has seed data
    And I am authenticated as a second test user
    When I send a GET request to /api/purchases
    Then the response status should be 200
    And the purchases array should be empty

  Scenario: User A cannot read User B's purchase receipt
    Given the database has seed data
    And I am authenticated as a second test user
    When I send a GET request to /api/purchases/purch-1/receipt
    Then the response status should be 404

  Scenario: User A cannot read User B's plans
    Given the database has seed data
    And I am authenticated as a second test user
    When I send a GET request to /api/plans
    Then the response status should be 200
    And the plans array should be empty

  Scenario: Settings response never contains AI key material
    Given the database has seed data
    And I am authenticated as a test user
    And I send a PATCH request to /api/settings with body
      """
      {"ai_key": "sk-test-key-12345"}
      """
    When I send a GET request to /api/settings
    Then the response status should be 200
    And the response should not contain encrypted_ai_key
    And the response should not contain ai_key

  # ahaqqu/RumaQ#528: the CSRF Origin guard runs in the gateway before any
  # handler, against the real proxy path the browser uses.
  Scenario: A cross-origin cookie write is rejected
    Given the database has seed data
    And I am authenticated as a test user
    And the request Origin is "https://evil.example"
    When I send a POST request to /api/locations with body
      """
      {"label": "Forged"}
      """
    Then the response status should be 403
    And the response body should match
      """
      {"error": "csrf_origin_mismatch"}
      """
    When I send a GET request to /api/locations
    Then the response status should be 200
    And the locations list should not contain "Forged"

  Scenario: A cookie write from the app's own origin still works
    Given the database has seed data
    And I am authenticated as a test user
    And the request Origin is "http://localhost:3000"
    When I send a POST request to /api/locations with body
      """
      {"label": "Rak Atas"}
      """
    Then the response status should be 201

  Scenario: A cookie write with no Origin (scripted admin) still works
    Given the database has seed data
    And I am authenticated as a test user
    When I send a POST request to /api/locations with body
      """
      {"label": "Rak Bawah"}
      """
    Then the response status should be 201
