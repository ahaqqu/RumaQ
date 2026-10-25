# Receipt Scan

The receipt-scan feature lets users take or upload a photo of a shopping receipt and automatically create a purchase — parsing items, quantities, prices, store, and date via AI OCR.

## What it changes

- **Scan phase** — camera/gallery capture, upload to R2, AI OCR parses items
- **Review phase** — user can edit item names, qty, unit, price; match parsed items to existing catalog items via dropdown
- **Confirm phase** — creates purchase with all items, updates stock and history
- **TEST_MODE** — when `TEST_MODE=true`, returns mock AI data instead of calling the real AI provider

## How it works

1. User captures a receipt image on the **Add from Receipt** page
2. Image is uploaded to R2 and sent to the configured AI provider (OpenCode, OpenAI, Anthropic, Gemini, Ollama Cloud, or a custom OpenAI-compatible endpoint) for OCR parsing
3. The AI returns a structured list of items, a store guess, and a date guess
4. Existing stores and items are fetched for the review form
5. User reviews and edits parsed data, optionally matching items to existing catalog entries
6. On confirm, a purchase is created with items referencing matched `item_id`s or creating new items

## API endpoints

| Method | Path                          | Auth  | Description                           |
| ------ | ----------------------------- | ----- | ------------------------------------- |
| POST   | `/api/purchases/scan`         | Yes   | Upload receipt, returns parsed items  |
| GET    | `/api/purchases/{id}/receipt` | Yes   | Get receipt image URL                 |
| POST   | `/api/purchases`              | Yes   | Create purchase from parsed items     |
| GET    | `/api/items`                  | Yes   | List items for item-matching dropdown |
| POST   | `/api/__test/direct-sql`      | Yes\* | Admin endpoint for test data setup    |

## Source

- `backend/src/apps/api.ts` — scan, purchase creation, items listing
- `backend/src/lib/ai.ts` — AI provider abstraction and OCR prompt
- `backend/src/lib/receipts.ts` — R2 upload helper
- `frontend/src/pages/AddFromReceipt.jsx` — 4-phase scan UI
- `frontend/src/lib/api.js` — `scanReceipt`, `createPurchase`, `getItems`, `getStores`
- `automation/tests/local/api/features/scan.feature` — 5 API test scenarios
- `automation/tests/local/api/features/purchases.feature` — 6 API test scenarios
