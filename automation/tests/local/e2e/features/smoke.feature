Feature: App Shell Smoke
  The frontend application loads, authenticates against the local test stack,
  and renders the dashboard shell.

  Scenario: Main page loads, logs in, and renders shell
    Given I visit the app
    Then the page should have a title
    And the root element should be mounted
    And the login form should be visible
    When I log in with the seeded test user
    Then the topbar should be visible
    And a heading should be visible

  Scenario: Logout clears the session and shows the login page
    Given I visit the app
    And the login form should be visible
    When I log in with the seeded test user
    Then the topbar should be visible
    When I log out via the logout URL
    Then the login form should be visible again
