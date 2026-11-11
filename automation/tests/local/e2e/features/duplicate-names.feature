Feature: Admin duplicate-name report
  The admin catalog carries a read-only report of the canonical products that
  share a name case-insensitively (issue #485). A rename racing an ingest, or a
  rename inside the pipeline's cached-index window, can leave two products
  under one name; the report surfaces that to an admin, collapsed until they
  ask for it. Nothing is merged, renamed, or enforced from it.

  Scenario: An admin opens the report and sees the duplicate group
    Given the catalog holds two products sharing a name in different cases and one unique product
    And I am logged in as the seeded test user
    When I navigate to "/admin/catalog"
    Then the duplicate-name report is collapsed
    When I open the duplicate-name report
    Then the report lists the duplicate group with both product keys
    And the report leaves the unique product out
