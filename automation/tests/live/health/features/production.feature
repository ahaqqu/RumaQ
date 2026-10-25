Feature: Production Smoke
  The live production site responds correctly.

  Scenario: Public endpoints work
    Given the production site is at https://rumaq.ahaqqu.com
    And the API is at https://rumaq.ahaqqu.com
    When I GET /
    Then the response status should be 200

    When I GET /api/health
    Then the response status should be 200
    And the body should contain ok

  @needs-session
  Scenario: Authenticated endpoints work
    Given the production site is at https://rumaq.ahaqqu.com
    And the API is at https://rumaq.ahaqqu.com
    And I have a valid session cookie
    When I GET /api/me
    Then the response status should be 200
    And the body should contain a user object

    When I GET /api/stock
    Then the response status should be 200
    And the body should contain a stock array
