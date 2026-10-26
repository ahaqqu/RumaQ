Feature: Accessibility
  Every main page is scanned with axe-core. CI fails on critical or serious
  violations; moderate and minor findings are surfaced as warnings.

  Scenario: Login page has no critical or serious violations
    Given I visit the app
    Then the login page should have no critical or serious axe violations

  Scenario: Home page has no critical or serious violations
    Given I am logged in as the seeded test user
    Then the "Home" page should have no critical or serious axe violations

  Scenario: Inventory page has no critical or serious violations
    Given I am logged in as the seeded test user
    Then the "Inventory" page should have no critical or serious axe violations

  Scenario: Plan page has no critical or serious violations
    Given I am logged in as the seeded test user
    Then the "Plan" page should have no critical or serious axe violations

  Scenario: History page has no critical or serious violations
    Given I am logged in as the seeded test user
    Then the "History" page should have no critical or serious axe violations

  Scenario: Settings page has no critical or serious violations
    Given I am logged in as the seeded test user
    Then the "Settings" page should have no critical or serious axe violations
