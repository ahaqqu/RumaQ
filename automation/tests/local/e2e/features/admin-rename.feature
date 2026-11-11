Feature: Admin canonical rename
  An admin corrects a canonical product's name (issue #423) from the admin
  catalog's product detail or from the match review queue's canonical side.
  Every write is sent with the identity's current metadata version, the
  catalog re-reads the committed name through the server (not just the
  optimistic form cache), and a flagged pair keeps the frozen labels it was
  reviewed with — the pair's pair_data never moves on a rename (issue #488).

  Scenario: Renaming a product from the catalog detail persists across a reload
    Given the price explorer holds a seeded product
    And I am logged in as the seeded test user
    When I navigate to "/admin/catalog"
    And I open the product detail for "Minyak Goreng Bimoli"
    And I open the canonical rename form
    And I rename it to "Bimoli Minyak Goreng Botol 1 L"
    Then the rename is sent with the product's current metadata version
    And the rename succeeds with the success note
    And the rename form still shows the current name "Bimoli Minyak Goreng Botol 1 L"
    And the canonical product's identity carries "Bimoli Minyak Goreng Botol 1 L" at the next metadata version
    And the catalog shows "Bimoli Minyak Goreng Botol 1 L"
    When I reload the catalog
    Then the catalog shows "Bimoli Minyak Goreng Botol 1 L"
    And the product detail shows "Bimoli Minyak Goreng Botol 1 L" as the current canonical name

  Scenario: Renaming the canonical side keeps a flagged pair's frozen labels
    Given the review queue holds a flagged pair for a seeded product
    And I am logged in as the seeded test user
    When I navigate to "/admin/review"
    And I open the pair's canonical rename form
    Then the frozen-pair note explains the labels stay frozen
    And the pair keeps its frozen pair labels
    When I rename the pair canonical side to "Beras Ramos Premium 5 kg"
    Then the rename is sent with the product's current metadata version
    And the rename succeeds with the success note
    And the rename form still shows the current name "Beras Ramos Premium 5 kg"
    And the canonical product's identity carries "Beras Ramos Premium 5 kg" at the next metadata version
    And the pair keeps its frozen pair labels
    When I reload the review queue
    Then the pair keeps its frozen pair labels
    When I open the pair's canonical rename form
    Then the frozen-pair note explains the labels stay frozen
    And the canonical product's identity carries "Beras Ramos Premium 5 kg" at the next metadata version

  Scenario: A rename made outside the tab shows on a cold catalog load
    Given the price explorer holds a seeded product
    And I am logged in as the seeded test user
    When I rename the seeded product through the admin API to "Bimoli Minyak Goreng Botol 1 L"
    Then the canonical product's identity carries "Bimoli Minyak Goreng Botol 1 L" at the next metadata version
    When I navigate to "/admin/catalog"
    Then the catalog shows "Bimoli Minyak Goreng Botol 1 L"
    When I open the product detail for "Bimoli Minyak Goreng Botol 1 L"
    Then the product detail shows "Bimoli Minyak Goreng Botol 1 L" as the current canonical name
