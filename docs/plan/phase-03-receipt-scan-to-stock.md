# Phase 03 — Receipt Scan to Stock

**Status:** Done (PR #63 — receipt scan to stock with AI OCR, R2 upload, and purchase creation)  
**Priority:** P0 (MVP blocker)  
**Source PR:** PR 4 — Receipt Scan → Stock (from `docs/PROJECT_PLAN.md`)  
**Estimated effort:** High (R2 + AI OCR + multi-table transaction)

---

## Objective

Let a user photograph or upload a receipt, have an AI read it, review the parsed line items, and confirm to update stock and purchase history. The user impact is: _the core RumaQ promise — low-friction stock tracking from receipts_.

This phase touches R2, AI provider proxy, multi-table D1 writes, and the full AddFromReceipt UI flow.

---

## Acceptance Criteria

1. `POST /api/purchases/scan` accepts a receipt image, uploads it to R2 under a household-scoped key, calls the user's AI provider with an OCR prompt, and returns parsed line items plus a signed image URL.
2. `POST /api/purchases` accepts confirmed purchase data (store, date, items with qty/price) and creates `purchases`, `purchase_items`, `items` (if new), and `stock` rows in a single D1 batch or transaction.
3. After purchase creation, the affected stock rows have updated quantities and recalculated `run_out_days`.
4. The AddFromReceipt page implements the full 4-phase flow: capture → scanning → review → done.
5. The frontend receives signed R2 URLs for receipt preview instead of direct bucket access.
6. AI prompts only include data from the current household.
7. All endpoints use Valibot validation and household-scoped queries.
8. API integration tests cover scan endpoint, purchase creation, and R2 upload handling.
9. Frontend tests cover the 4-phase flow and review edits.
10. `vp test` and `vp check --no-fmt --no-lint` pass.

---

## Dependencies

- Phase 01 (Settings) is merged so the AI provider/key is stored and decryptable.
- Phase 02 (Inventory) is merged so stock/run-out logic exists.
- R2 bucket is created and bound as `RECEIPTS` in Wrangler config.
- D1 schema has `purchases`, `purchase_items`, `items`, `stock`, `stores`, `locations`.
- Existing AddFromReceipt page is mocked in `frontend/src/pages/AddFromReceipt.jsx`.

---

## Scope

### Backend

1. **R2 receipt upload helper** (`backend/src/lib/receipts.ts`):
   - `uploadReceipt(image: File | ArrayBuffer, householdId: string, userId: string): Promise<{ key: string, url: string }>`.
   - Generate key pattern: `receipts/{householdId}/{yyyy}/{mm}/{uuid}.{ext}`.
   - Validate file type (JPEG, PNG, HEIC, WEBP) and size (max 5 MB for MVP).
   - Return a signed URL valid for e.g., 15 minutes using `R2Bucket.createSignedUrl` or similar API. If unavailable, return the key and add a separate `GET /api/purchases/:id/receipt` endpoint that streams from R2.

2. **AI OCR helper** (`backend/src/lib/ai.ts`):
   - `extractReceiptItems(imageUrlOrBase64: string, provider: string, key: string, systemPrompt: string): Promise<ParsedItem[]>`.
   - Support OpenAI (`gpt-4o-mini` vision), Gemini (`gemini-1.5-flash`), Anthropic (`claude-3-haiku`), OpenCode (if available).
   - Build a prompt that asks for JSON output: `{ store_name?: string, date?: string, items: [{ name, qty, unit, price, total? }] }`.
   - Handle provider-specific message formats (OpenAI chat vs Gemini content).
   - Return normalized items.

3. **Scan endpoint** (`POST /api/purchases/scan` in `backend/src/apps/api.ts`):
   - Accept `multipart/form-data` with an `image` field.
   - Read the user's encrypted AI key from `user_settings`, decrypt it.
   - Upload image to R2.
   - Call the AI provider with the image URL or a base64 data URI.
   - Try to match the returned store name to an existing store in the household; if not found, return `store: null` and let the user pick.
   - Return `{ items: [...], imageKey, imageUrl, storeGuess, dateGuess }`.
   - Do not write to `purchases` yet; this is the scanning phase.
   - Increment `ai_usage.used` for this user today.
   - Validate AI usage limit (default 20/day). If exceeded, return 429.

4. **Purchase creation endpoint** (`POST /api/purchases`):
   - Valibot schema: `store_id` (optional), `date` (ISO date), `items` array of `{ name, qty, unit, price, item_id? }`.
   - If `item_id` is missing, canonicalize name and create a new `items` row for the household (or match an existing one by normalized name).
   - A supplied `item_id` is client-controlled: it must resolve within the caller's household (`item_id` + `household_id`). Foreign and unknown ids are indistinguishable — `404`, no write (#517). The plan check-off path that copies `plan_items.item_id` into `purchase_items`/`stock` carries the same guard.
   - Insert into `purchases` with `receipt_image_key` from scan if provided.
   - Insert into `purchase_items`.
   - Update or insert `stock` rows:
     - If stock row exists for item + location, add qty.
     - If not, create a new stock row with a default location (e.g., the first location by sort_order).
   - Recalculate `run_out_days` for affected stock rows using the Phase 02 helper.
   - Use D1 `batch` to group writes; note that D1 batch is not a true transaction but is atomic for a single batch. If a true transaction is needed, use a raw SQL `BEGIN TRANSACTION` ... `COMMIT` if D1 supports it.
   - Return the created purchase with items and updated stock rows.

5. **Manual purchase entry endpoint** (`POST /api/purchases` is shared with scan confirmation; the scan result can be confirmed through the same endpoint):
   - The scan endpoint returns a draft; the frontend confirms via `POST /api/purchases` with the draft items.

6. **Receipt image endpoint** (`GET /api/purchases/:id/receipt`) — if signed URLs are not available:
   - Verify the purchase belongs to the household.
   - Stream the R2 object through the Worker with the correct `Content-Type`.
   - Set `Cache-Control: private, no-cache`.

7. **Household-scoped AI prompts**:
   - Never include other households' items, locations, or stores in the prompt.
   - Only include the household's location labels and store labels as context if needed.

### Frontend

1. **API client additions** (`frontend/src/lib/api.js`):
   - `scanReceipt(file)` → `POST /api/purchases/scan` with `FormData`.
   - `createPurchase(payload)` → `POST /api/purchases`.
   - `getReceiptUrl(purchaseId)` → `GET /api/purchases/${purchaseId}/receipt` (optional).

2. **AddFromReceipt page refactor** (`frontend/src/pages/AddFromReceipt.jsx`):
   - Capture phase: actual file input (camera on mobile) and drag-and-drop.
   - Scanning phase: show progress, call `scanReceipt`, handle errors (AI key missing, usage limit, parsing failure).
   - Review phase: display parsed items, allow editing name, qty, unit, price; allow picking store/date; show receipt preview image.
   - Done phase: call `createPurchase`, show success, navigate to Inventory or Home.
   - Add error handling for each phase with retry options.
   - Handle the case where the user has no AI key configured (prompt to go to Settings).

3. **Receipt image component**:
   - Display the signed URL or fetched blob.
   - Handle loading and error states.

4. **Persona copy**:
   - Use `personaText` for scanning descriptions and success messages.

---

## Out of Scope

- Price memory and price alerts (Phase 10).
- Cheapest-store recommendation (Phase 10).
- Multiple receipt upload or batch scanning.
- HEIC conversion (accept only common formats; HEIC support can be added later).
- Automatic store learning from GPS or repeated patterns.
- Purchase history UI (Phase 05).

---

## Database Changes

No schema changes are required. Consider adding an index if purchase history queries by item become slow:

```sql
CREATE INDEX IF NOT EXISTS idx_purchase_items_item_id ON purchase_items(item_id);
```

If you want to store AI parsing metadata (model used, raw response), add a `scan_metadata` JSON column to `purchases` later. Not needed for MVP.

---

## Testing Strategy

### Backend unit tests

1. `ai-ocr.test.ts` — mock fetch responses for each provider and assert normalized output.
2. `receipt-upload.test.ts` — mock R2 and assert key format and signed URL generation.
3. `purchase-create.test.ts` — test item canonicalization, stock update, and run-out recalculation.

### Backend integration tests

Add to `automation/tests/local/api/`:

1. `scan.feature` — scenarios:
   - Upload a small image and receive parsed items (use a mock AI response to avoid real API calls).
   - Missing AI key returns 400/402 with a clear message.
   - AI usage limit reached returns 429.
   - Uploading a non-image file returns 400.
2. `purchases.feature` — scenarios:
   - Create a purchase updates stock and purchase history.
   - Creating a purchase with a new item creates the item and stock.
   - Creating a purchase with an existing item updates qty.
   - Another household cannot access the purchase.

### Frontend tests

1. Update `AddFromReceipt.test.jsx` to test the 4-phase flow with mocked API calls.
2. Test file input change triggers scan.
3. Test editing items in review phase.
4. Test confirming purchase navigates to the next state.

### Manual verification

1. Take a photo of a real receipt (or upload a test image).
2. Verify the scan phase shows AI-parsed items.
3. Edit a parsed item, confirm, and verify stock updates in Inventory.
4. Verify the receipt image is visible in review phase.
5. Verify AI usage meter increments.

---

## Deployment & Secrets

- Ensure R2 bucket is created and bound to the Worker as `RECEIPTS` in `wrangler.cloudflare.toml` and `wrangler.local.toml`.
- The AI key is decrypted in the Worker and used to call the provider. The provider receives the receipt image; this is expected behavior.
- R2 objects must be private. Never expose the bucket directly; always use signed URLs or the Worker proxy.
- Review R2 free-tier limits: 10 GB storage, 10 M reads/month. Receipt images are small; this should be fine.

---

## Risks & Mitigations

| Risk                                                   | Impact | Mitigation                                                                                                         |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------ |
| AI OCR fails or returns bad JSON                       | High   | Validate JSON with Valibot, show a clear "AI couldn't read this" state, and allow manual entry.                    |
| AI key is missing or invalid                           | High   | Return a 402/400 with a message pointing to Settings. Frontend redirects to Settings.                              |
| R2 upload or signed URL fails                          | High   | Catch errors and show retry UI; fallback to base64 data URI for AI if R2 is unavailable.                           |
| D1 batch fails mid-write and leaves inconsistent state | High   | Use D1 batch for atomicity; if batch fails, return 500 and do not commit partial writes. Test with malformed data. |
| Another household's image is accessed                  | High   | Key includes `householdId`; the Worker verifies purchase ownership before serving images.                          |
| AI usage is not tracked correctly                      | Medium | Increment `ai_usage.used` in the same scan endpoint and enforce the limit before calling the provider.             |
| Receipt images are large/heic                          | Medium | Limit file size to 5 MB and accept common formats; document that HEIC may need conversion.                         |
| AI cost surprises for users                            | Medium | The user brings their own key; the app only shows usage. This is acceptable.                                       |

---

## Open Questions

1. **Should the scan endpoint use the signed URL or a base64 data URI for the AI prompt?** Signed URL is preferred if supported by R2 and the provider. If R2 signed URLs are not available, base64 works but increases request size. Recommendation: try signed URL first; document base64 fallback.
2. **What should the AI model be if the user picks OpenCode?** OpenCode may have a different API shape. If unsupported, return a clear error and disable it for scan.
3. **Should the user be able to choose a location for each item during review?** MVP: assign to default location (first by sort_order). Add per-item location selection later.
4. **Should we store the full AI raw response for debugging?** Not in MVP; adds storage. Consider adding later.
5. **Should we auto-create a store if the AI guesses a new one?** For MVP, return `storeGuess: null` and let the user pick from existing stores. Auto-create later if desired.
6. **Should the scan count as one AI usage if it fails?** No, only count successful calls or calls that reached the provider. Or count when the provider is called; if it fails, the usage still increments. Document the behavior.
7. **Should the purchase date default to today or the receipt date?** Use receipt date if AI returns it; otherwise today.

---

## Alternatives Considered

- **Client-side AI OCR:** Rejected because the user's key would be exposed in the browser and the image upload/R2 flow is more secure and flexible on the backend.
- **Store receipt images as base64 in D1:** Rejected because D1 is not designed for large blobs and R2 is cheaper for images.
- **Use a third-party OCR service (Tesseract, Google Vision):** Rejected because the project uses the user's AI key; adding another provider adds complexity and cost.
- **Skip the review phase and auto-add stock:** Rejected because OCR is not perfect and users need a chance to correct errors.

---

## Implementation Notes for a Future Session

1. Confirm R2 bucket is set up and bound in Wrangler configs.
2. Write the AI provider helper with a mockable fetch and test it.
3. Write the R2 upload helper and test it.
4. Implement `POST /api/purchases/scan` with usage tracking.
5. Implement `POST /api/purchases` with item canonicalization and stock update.
6. Wire the AddFromReceipt page through the 4-phase flow.
7. Run the full test suite and open the PR.

After this phase, the core receipt-to-stock loop is functional and the user can track stock by photographing receipts.
