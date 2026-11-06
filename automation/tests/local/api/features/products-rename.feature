Feature: Admin canonical product rename
  The backend owns the canonical product name (pipeline contract v2). An admin
  can relabel one product, review the identity and audit trail, and undo the
  latest rename with a compensating receipt — while the metadata version and
  the canonical index version move exactly once per write (issue #423).

  Scenario: The product identity endpoint requires an authenticated session
    Given the API is running
    When I read an admin product identity without a session
    Then the response status should be 401

  Scenario: The product identity endpoint requires an admin
    Given the API is running
    And I am authenticated as a non-admin user
    When I read an admin product identity
    Then the response status should be 403

  Scenario: An invalid rename body is rejected
    Given I am authenticated as an admin
    And the canonical catalog has a product with candidate aliases
    When I send a rename without a canonical name
    Then the response status should be 400

  Scenario: A blank canonical name is rejected
    Given I am authenticated as an admin
    And the canonical catalog has a product with candidate aliases
    When I rename the product to a blank name
    Then the response status should be 400

  Scenario: An unknown product cannot be renamed
    Given I am authenticated as an admin
    When I rename an unknown product
    Then the response status should be 404

  Scenario: A stale metadata version cannot overwrite a newer write
    Given I am authenticated as an admin
    And the canonical catalog has a product with candidate aliases
    When I rename the product with an outdated metadata version
    Then the response status should be 409
    And the error code should be stale_product with the current name and version

  Scenario: A duplicate canonical name is refused
    Given I am authenticated as an admin
    And the canonical catalog has a product with candidate aliases
    And the catalog has another product named "Gula Pasir Gulaku 1 kg"
    When I rename the product to "gula pasir gulaku 1 kg"
    Then the response status should be 409
    And the error code should be duplicate_name with the conflicting product

  Scenario: A similar name warns until the admin acknowledges it
    Given I am authenticated as an admin
    And the canonical catalog has a product with candidate aliases
    And the catalog has another product named "Beras Ramos 5 kg Super"
    When I rename the product to "Beras Ramos 5 kg Super Extra"
    Then the response status should be 409
    And the error code should be similar_name with at least one warning
    When I rename the product to "Beras Ramos 5 kg Super Extra" acknowledging the warnings
    Then the response status should be 200
    And the rename should return the acknowledged warnings

  Scenario: An admin renames a product, then reverts the latest rename
    Given I am authenticated as an admin
    And the canonical catalog has a product with candidate aliases
    When I read the product identity
    Then the identity should carry the product, its aliases, stats, and an empty audit
    When I rename the product with the current metadata version
    Then the rename should return the new name, one rename audit row, and a bumped index version
    And the product status should still be provisional
    When I read the product identity again
    Then the old wording should be an approved alias for each store that observed it
    When I revert the latest rename
    Then the revert should restore the original name and append a compensating revert audit row
    And the canonical index version should have advanced exactly once per write
    When I try to revert the same rename again
    Then the response status should be 409
    And the error code should be stale_revert
