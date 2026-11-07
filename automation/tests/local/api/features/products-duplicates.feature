Feature: Admin duplicate-name report
  Canonical products that share a name case-insensitively are surfaced to an
  admin by a bounded, read-only report (issue #485). Nothing is merged or
  renamed: a racing rename or a rename inside the pipeline's cached-index
  window can leave a duplicate behind, and this is how an admin sees it.

  Scenario: The report groups products that share a name case-insensitively
    Given I am authenticated as an admin
    And the catalog has two products sharing a name in different cases and one unique product
    When I read the duplicate-name report
    Then the response status should be 200
    And the report should contain one group with both duplicate product keys
    And the report should not contain the unique product

  Scenario: The report is bounded by the limit parameter
    Given I am authenticated as an admin
    And the catalog has three duplicate-name groups
    When I read the duplicate-name report with limit 1
    Then the response status should be 200
    And the report should contain exactly one group marked truncated
