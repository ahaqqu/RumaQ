Feature: Observation registry merge on approval (#744)
  Approving a flagged pair merges the observation registry in the same
  transaction as the verdict: the entry-side product's observations re-point
  to the item-side survivor, its alias spellings move, its price_products row
  is deleted, one merge receipt is appended and the canonical index bumps
  once. The re-pointed sightings are visible under the survivor's explorer
  page immediately; the absorbed key is gone from the catalog.

  Scenario: An approval re-points the entry's sighting under the survivor
    Given I am authenticated as an admin
    And the agent ingested sightings for two duplicate product keys
    And the agent posted a run report flagging the two keys as one product
    When I approve the flagged pair
    Then the decision response should report the registry merge
    And the survivor's explorer page should list both sightings
    And the absorbed key should be gone from the catalog

  Scenario: A reject records the verdict and touches no catalog row
    Given I am authenticated as an admin
    And the agent ingested sightings for two duplicate product keys
    And the agent posted a run report flagging the two keys as one product
    When I reject the flagged pair
    Then the decision response should report no registry merge
    And both keys should still be in the catalog
