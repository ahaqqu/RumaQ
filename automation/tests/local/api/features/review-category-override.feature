Feature: Admin category override on taxonomy review flags
  The human category override (ahaqqu/RumaQ#728): from a taxonomy flag, an
  admin sets the product's category from the sealed 49-bucket vocabulary. ONE
  round trip writes price_products.category (+ category_source='human', the
  sealed category_version), appends one price_product_category_audit receipt,
  bumps the canonical index version once, and settles THIS flag approved with
  decided_source='human'. The revert is the compensating receipt for the
  LATEST unreverted set — it never touches flag rows.

  Scenario: The override and vocabulary routes require an authenticated session
    Given the API is running
    When I read the taxonomy buckets without a session
    Then the response status should be 401
    When I set a category on a review item without a session
    Then the response status should be 401

  Scenario: The override and vocabulary routes require an admin
    Given the API is running
    And I am authenticated as a non-admin user
    When I read the taxonomy buckets
    Then the response status should be 403
    When I set a category on a review item
    Then the response status should be 403

  Scenario: The vocabulary route serves the sealed 49-bucket list
    Given I am authenticated as an admin
    When I read the taxonomy buckets
    Then the response status should be 200
    And the buckets should be the sealed v0.4 list with 49 slugs

  Scenario: A slug outside the sealed vocabulary is refused
    Given I am authenticated as an admin
    And the catalog has a product with a pending taxonomy flag
    When I set the category to "beras-ramos"
    Then the response status should be 400
    And the error code should be category_unknown
    And the product category should be untouched

  Scenario: Confirming the assigned category is refused — that is the ack's job
    Given I am authenticated as an admin
    And the catalog has a product with a pending taxonomy flag
    When I set the category to its current value
    Then the response status should be 400
    And the error code should be category_unchanged

  Scenario: An unknown review item cannot be overridden
    Given I am authenticated as an admin
    When I set a category on an unknown review item
    Then the response status should be 404

  Scenario: The override re-reads the product fresh, so a moved category is not stale
    Given I am authenticated as an admin
    And the catalog has a product with a pending taxonomy flag
    And the product's category moved after the flag was raised
    When I set the category to "beras"
    Then the response should settle the flag approved with decided_source human
    And the moved-from category should be the receipt's old value

  Scenario: An admin overrides the category from a taxonomy flag
    Given I am authenticated as an admin
    And the catalog has a product with a pending taxonomy flag
    When I read the product identity
    Then the identity should carry the pipeline category and an empty category audit
    When I set the category to "beras"
    Then the response should settle the flag approved with decided_source human
    And the identity should carry the human category, one set receipt, and a bumped index version
    And the product status and name should be untouched

  Scenario: Re-overriding the same product is legal — a new receipt, not a stale error
    Given I am authenticated as an admin
    And the catalog has a product with a pending taxonomy flag
    When I set the category to "beras"
    Then the response should settle the flag approved with decided_source human
    When I set the category to "snack" on the same flag again
    Then the re-override should commit a second receipt while the decision stands

  Scenario: An override on an already-decided flag moves the category and keeps the decision
    Given I am authenticated as an admin
    And the catalog has a product with a decided taxonomy flag
    When I set the category to "beras"
    Then the response should keep the decided flag's decision while the category moves

  Scenario: The admin reverts the latest override, and only once
    Given I am authenticated as an admin
    And the catalog has a product with a pending taxonomy flag
    When I set the category to "beras"
    Then the response should settle the flag approved with decided_source human
    When I revert the category with the current metadata version
    Then the revert should restore the pipeline category and append a compensating revert receipt
    And the flag decision should be untouched by the revert
    When I try to revert the category again
    Then the response status should be 409
    And the error code should be stale_revert
    When I revert the category with an outdated metadata version
    Then the response status should be 409
    And the error code should be stale_product
