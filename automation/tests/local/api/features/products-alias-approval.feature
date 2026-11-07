Feature: Admin candidate alias approval
  The backend owns candidate aliases (pipeline contract v2): ingest writes the
  raw store spellings and only approved rows enter the canonical index. An
  admin approves or rejects each candidate, and the decision is a CAS on the
  alias's own status — no product metadata version moves. Approval bumps the
  canonical index version exactly once so the pipeline picks the alias up on
  its next fetch; rejection records the decision and bumps nothing (issue
  #489).

  Scenario: The alias decision endpoints require an authenticated session
    Given the API is running
    When I approve a candidate alias without a session
    Then the response status should be 401

  Scenario: The alias decision endpoints require an admin
    Given the API is running
    And I am authenticated as a non-admin user
    When I reject a candidate alias
    Then the response status should be 403

  Scenario: An unknown product cannot decide an alias
    Given I am authenticated as an admin
    When I approve an alias of an unknown product
    Then the response status should be 404
    And the error code should be product-not-found

  Scenario: An alias of another product cannot be decided through this product
    Given I am authenticated as an admin
    And the canonical catalog has a product with candidate aliases
    And another product has a candidate alias
    When I approve the other product's alias using this product key
    Then the response status should be 404
    And the error code should be alias-not-found

  Scenario: An admin approves a candidate alias
    Given I am authenticated as an admin
    And the canonical catalog has a product with candidate aliases
    When I approve a candidate alias
    Then the response status should be 200
    And the alias should be approved and carry its id
    And the canonical index version should have advanced exactly once
    And the product's metadata version should be unchanged
    When I read the product identity
    Then the approved alias should appear with its id and approved status

  Scenario: A decided alias cannot be approved twice
    Given I am authenticated as an admin
    And the canonical catalog has a product with candidate aliases
    When I approve a candidate alias
    Then the canonical index version should have advanced exactly once
    When I approve the same alias again
    Then the response status should be 409
    And the error code should be alias_state with current status "approved"
    And the canonical index version should be unchanged
    And no second decision receipt should exist

  Scenario: An admin rejects a candidate alias without bumping the index
    Given I am authenticated as an admin
    And the canonical catalog has a product with candidate aliases
    When I reject a candidate alias
    Then the response status should be 200
    And the alias should be rejected
    And the canonical index version should be unchanged
    And a rejection receipt should exist
    When I fetch the canonical index
    Then the rejected alias should not be present
