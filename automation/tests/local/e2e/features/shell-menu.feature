Feature: App shell menu
  The desktop sidebar is exactly viewport-height with its own scroll region
  (#675): the menu scrolls independently of the page while the brand row and
  the household card stay pinned, and every item stays clickable at any page
  scroll position on tall pages.

  Scenario: Scrape Now is clickable at the bottom of a tall page
    Given a tall price snapshot has been pushed
    And I am logged in as the seeded test user
    When I navigate to "/prices"
    And I scroll the page to the bottom
    Then the sidebar "Scrape Now" item navigates to "/admin/scrape"

  Scenario: AI Usage is clickable at the bottom of a tall page
    Given a tall price snapshot has been pushed
    And I am logged in as the seeded test user
    When I navigate to "/prices"
    And I scroll the page to the bottom
    Then the sidebar "AI Usage" item navigates to "/admin/ai-usage"

  Scenario: Catalog is clickable at the top of the page
    Given a tall price snapshot has been pushed
    And I am logged in as the seeded test user
    When I navigate to "/prices"
    Then the sidebar "Catalog" item navigates to "/admin/catalog"
