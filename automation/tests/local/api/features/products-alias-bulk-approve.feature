Feature: Admin bulk exact-name alias approval
  The catalog carries raw store spellings as candidate aliases (pipeline
  contract v2), and only approved rows enter the canonical index. Most
  candidates simply restate their product's canonical name in another case, so
  one safe bulk action approves exactly those and leaves every variant for a
  manual decision (issue #515). Each approval is receipted with the acting
  admin, the canonical index version advances exactly once per run with
  approvals, and a second run approves nothing and does not bump.

  Scenario: The bulk endpoints require an authenticated session
    Given the API is running
    When I read the alias candidate counts without a session
    Then the counts read answers 401
    When I bulk-approve aliases without a session
    Then the bulk approve answers 401

  Scenario: The bulk endpoints require an admin
    Given the API is running
    And I am authenticated as a non-admin user
    When I bulk-approve aliases
    Then the bulk approve answers 403

  Scenario: One run approves only the exact-name candidates and bumps once
    Given I am authenticated as an admin
    And the canonical catalog has exact-name and variant candidate aliases
    When I read the alias candidate counts
    Then the counts read answers 200
    And the counts report 5 candidate aliases with 3 exact-name matches
    And the counts response is private and uncached
    When I bulk-approve the exact-name candidate aliases
    Then the bulk run answers 200
    And the run reports 3 exact-name matches and 3 approvals with 2 candidates left
    And the canonical index version should be 1
    When I read the first product's identity
    Then its exact-name aliases should be approved and its variant still a candidate
    When I read the second product's identity
    Then its own exact-name alias should be approved and the other product's spelling still a candidate
    When I bulk-approve the exact-name candidate aliases again
    Then the second bulk run answers 200
    And the second run reports nothing to approve
    And the canonical index version should still be 1
