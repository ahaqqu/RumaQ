# Product metadata: how it is owned, filled, and read

> This page explains the product metadata contract between the scraper and RumaQ. It is
> the product-level view; implementation details are not part of this page.

A product has one permanent identity. Its customer-facing details belong to RumaQ. The
store wording and prices belong to the scraper. An admin is the final check on the
customer-facing details.

## Who owns what

| What                                                                    | Owner   | Why                                                  |
| ----------------------------------------------------------------------- | ------- | ---------------------------------------------------- |
| Permanent identity                                                      | RumaQ   | One product keeps one identity when its name changes |
| Confirmed name, brand, type, variant, size, description, category       | RumaQ   | Customer-facing and stable                           |
| Approved store names                                                    | RumaQ   | Other wording that means the same product            |
| Store wording, brand, size, price, promotion, store, date, and evidence | Scraper | What the store actually showed                       |
| Confirmation of customer-facing details and store names                 | Admin   | A human check before customer use                    |
| Product page and price view                                             | App     | Reads from RumaQ                                     |

Price, promotion, store, date, and evidence are store-record details. They do not change
the product's identity or confirmed details.

## How metadata is filled

1. The scraper reads a store page or brochure. It records the wording, brand, size,
   price, promotion, store, date, and evidence.
2. The scraper sends the record to RumaQ. If the product is new, RumaQ creates a
   provisional product with a permanent identity.
3. The store wording is kept as a possible store name. It is not treated as the confirmed
   product name.
4. An admin confirms the customer-facing details and approves the store names that refer
   to the same product.
5. Confirmed details and approved store names are used for display and matching. A
   provisional product is visible and can be matched, but it is clearly marked as not yet
   confirmed.

## How metadata is read

1. The app asks RumaQ for products and prices. It receives product details — marked
   confirmed or provisional — and the store prices attached to them.
2. Before matching a new store record, the scraper asks RumaQ for the current product
   list. It uses confirmed names and approved store names, and can see which products are
   provisional.
3. The scraper never edits confirmed details. It only adds store records and possible
   store names for an admin to review.

## Show me: one product

| Step          | What happens                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------- |
| Store page    | “FILMA MINYAK GORENG PCH 2L”                                                                    |
| Scraper       | Records the wording, Filma, 2 L, the price, the store, and the date                             |
| RumaQ         | Creates a permanent identity, a provisional product, and a possible store name from the wording |
| Admin         | Confirms “Filma Minyak Goreng Pouch 2 L”, the brand, type, and size; approves the store name    |
| App           | Shows the confirmed product, size, and the store price                                          |
| Another store | Uses different wording; it matches the approved store name, so no duplicate product is created  |

## How to keep this page and the code in step

This page describes the current contract. When a rule changes:

1. Change the contract and this page first.
2. Change RumaQ and the scraper together.
3. Check one product from the store wording through to the app.
4. Remove anything that is no longer true.
