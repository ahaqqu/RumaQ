# Phase 06 — Security & Production Hardening

**Status:** Mostly done (PR #260 — dedicated CORS unit tests + docs/SECURITY.md + checklist sync; one manual step outstanding: live OAuth verification with real credentials on the deployed domain)  
**Priority:** P0/P1  
**Source sections:** Sections 3, 5, 7 of `docs/PROJECT_PLAN.md`  
**Estimated effort:** Small–Medium

---

## Objective

Close the remaining security gaps before the MVP ships. The heavy-lifting controls (Google OAuth, JWT session cookies, AES-GCM AI key encryption, per-household R2 receipt proxy, and AI usage rate limiting) are already in place. This phase now focuses on tightening the edges: CORS strictness, general API rate limiting, row-level security completeness, AI prompt isolation tests, and a finished security checklist.

The user impact is: _trust that the app handles data and credentials safely_.

---

## Acceptance Criteria

1. Google OAuth login/callback/logout is verified end-to-end with real credentials on the deployed domain. — **Manual / not yet executed**
2. Session cookies are `HttpOnly`, `Secure`, `SameSite=None` in production and work cross-origin between Pages and Workers. — **Implemented** (`backend/src/apps/auth.ts`)
3. CORS allows only the configured Pages origin and localhost in local/test environments, and rejects unknown origins in production. — **Partial** (allowed-origin logic exists; unknown origins currently receive the configured origin instead of being rejected)
4. AI API keys are encrypted with AES-GCM using `WORKER_ENCRYPTION_KEY` at rest and decrypted only in the Worker. — **Implemented** (`backend/src/lib/crypto.ts`)
5. R2 receipt images are served only via the Worker proxy (`GET /api/purchases/:id/receipt`), and the bucket is not public. — **Implemented via proxy; signed URLs deferred**
6. AI prompts and context never include another household's data. — **Implemented by construction; missing explicit isolation test**
7. Every D1 query that reads or writes household-scoped data includes `household_id = ?` (or equivalent `user_id` filter). — **Mostly implemented; a few DELETE/UPDATE/SELECT id lookups need tightening**
8. Rate limiting is implemented per user for AI endpoints, and a general per-user/per-IP API limit is implemented. — **AI limit implemented via `ai_usage`; general API limit and `Retry-After` header not yet implemented**
9. A security checklist is added to `docs/ARCHITECTURE.md` or a separate `docs/SECURITY.md` and all items are marked complete. — **Partial** (`docs/ARCHITECTURE.md` section 10 exists but is inconsistent with code and has open items)
10. `scripts/test.sh unit frontend` / `unit backend` and `scripts/test.sh automation-local` pass. — **To be verified**

---

## Dependencies

- Phases 01-05 for the features that need hardening (settings, stock, receipts, plans, history).
- `WORKER_ENCRYPTION_KEY` is set in all environments.
- R2 bucket is created and bound.
- Google OAuth credentials are configured.
- Existing `backend/src/auth.ts`, `backend/src/cors.ts`, `backend/src/apps/api.ts`.

---

## Scope

### 1. Finish Google OAuth integration and live test

- Configure real `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in Cloudflare secrets.
- Set `PAGES_ORIGIN` to the real Pages URL (e.g., `https://rumaq.pages.dev`).
- Deploy and test the full flow: login → callback → `GET /api/me` → logout.
- Verify the `rumaq_session` cookie is set correctly and sent on subsequent requests.
- Fix any issues with `SameSite=None` + `Secure` cross-origin behavior.
- Document the OAuth setup steps in `docs/ARCHITECTURE.md` or a new `docs/SECURITY.md`.

> **Current state:** Code and unit tests are complete (`backend/src/apps/auth.ts`, `backend/src/__tests__/auth.test.ts`). The gateway already validates required secrets on startup when `RUN_SECRETS_CHECK=true` (`backend/src/gateway.ts`). Only live-domain manual verification remains.

### 2. Session/JWT hardening

- Ensure `WORKER_JWT_SECRET` is a strong, random 256-bit value.
- Verify session duration is 30 days and the cookie expires accordingly.
- Ensure logout clears the cookie in both same-origin and cross-origin scenarios.
- Add a `GET /api/auth/session` or extend `/api/me` to return session metadata (optional).

> **Current state:** JWT uses HMAC-SHA256, expiration and cookie `maxAge` are both 30 days, and logout clears the cookie with matching attributes. No `kid`/rotation support or session-metadata endpoint exists (acceptable for MVP). Update `docs/ARCHITECTURE.md` checklist, which currently says `SameSite=Lax` while code uses `None`.

### 3. AI key encryption

- Verify the AES-GCM implementation uses a 256-bit key derived from `WORKER_ENCRYPTION_KEY`.
- Never return the encrypted or plain key in API responses.
- Add a test that confirms the GET settings response does not contain key material.
- Document key rotation: if `WORKER_ENCRYPTION_KEY` changes, old keys cannot be decrypted. Plan a migration before rotating.

> **Current state:** `backend/src/lib/crypto.ts` derives a 256-bit AES-GCM key with PBKDF2 and a random IV. Settings GET/PATCH return only `has_ai_key`. `backend/src/__tests__/crypto.test.ts` covers round-trips and tamper detection; the integration suite (`settings.feature`) covers the API response. Add a dedicated backend unit test if desired, and document rotation consequences.

### 4. R2 signed URLs and receipt privacy

- Keep R2 bucket private (no public access policy).
- Serve receipts through the Worker proxy (`GET /api/purchases/:id/receipt`) with `household_id` verification.
- Consider implementing `R2Bucket.createSignedUrl` time-limited signed URLs later; for MVP the proxy is sufficient.
- Add tests that another household cannot fetch the receipt.

> **Current state:** Proxy endpoint exists and filters by `household_id` (`backend/src/apps/api.ts:1214-1251`). `backend/src/lib/receipts.ts:getSignedUrl()` is intentionally a stub. Tech debt is tracked in `docs/ARCHITECTURE.md` section 13.

### 5. AI prompt data isolation

- Audit every AI prompt construction in `backend/src/lib/ai.ts`, `backend/src/lib/plans.ts`, and `backend/src/lib/chat.ts`.
- Ensure only current household items, locations, stores, and history are included.
- Avoid passing internal DB IDs such as `store_id` to the LLM where possible.
- If debugging logs are added, never log prompts with household data in production.
- Add a unit test that builds a prompt from a mock household and asserts no other household's data appears.

> **Current state:** Inputs are household-scoped, but `buildPlanPrompt` currently includes raw `store_id` values in the store list passed to the LLM. Replace with labels-only or document why the IDs are acceptable. Add `prompt-isolation.test.ts` as planned.

### 6. Row-level security review

- Audit every D1 query in `backend/src/apps/api.ts`.
- Checklist per query:
  - Does it filter by `household_id`?
  - Does it join to another table that also filters by `household_id`?
  - Does it use `id` lookups that also verify `household_id`?
  - Does it return 404 (not 403) for resources outside the household?
- Tighten the following lookups to include `household_id` explicitly:
  - `DELETE FROM locations WHERE id = ?`
  - `DELETE FROM stores WHERE id = ?`
  - `UPDATE stock SET ... WHERE id = ?`
  - `UPDATE plan_items SET status = ? ... WHERE id = ?`
  - `UPDATE plans SET status = ? ... WHERE id = ?`
  - post-create `SELECT ... WHERE id = ?` for locations and stores
- Add integration tests that attempt cross-household access for every resource type.

> **Current state:** The vast majority of reads and writes already filter by `household_id` or `user_id`. The gaps above rely on earlier lookups that did verify ownership, but the defense-in-depth principle requires the final mutation query itself to be scoped.

### 7. Rate limiting

- Keep AI endpoint limits via the existing `ai_usage` table (default 20/day per user) for `/api/purchases/scan`, `/api/plans/generate`, and `/api/ai/chat`.
- Add a `Retry-After` header to 429 responses from AI endpoints.
- Implement a simpler per-user or per-IP rate limit for all API endpoints (e.g., 100 requests/minute). Decide between Cloudflare KV, D1, or an in-memory sliding window.
- Add tests for rate limiting behavior.

> **Current state:** AI endpoints return 429 when `used >= daily_limit`. No `Retry-After` header is set. No general API rate limit exists. Cloudflare KV is not currently bound or used.

### 8. CORS and cookie security

- Update `backend/src/cors.ts` so that in production unknown origins are rejected (`null` or 403) rather than mirrored to the configured origin.
- Keep `http://localhost:5173` allowed for local dev and preview `.pages.dev` subdomains allowed for branch previews.
- Verify `Access-Control-Allow-Credentials: true` is set for authenticated requests.
- Ensure `OPTIONS` preflight is handled correctly.
- Add tests that unauthorized origins are rejected.

> **Current state:** `credentials: true` is set and Hono handles preflight. Unknown-origin fallback is too permissive. Existing `backend/src/__tests__/index.test.ts` only tests allowed origins.

---

## Out of Scope

- Formal security audit by a third party.
- SOC 2 compliance.
- Advanced threat detection.
- Bot protection (Cloudflare Turnstile could be added later).
- Penetration testing (manual testing only).
- R2 time-limited signed URLs (deferred; proxy covers MVP privacy requirement).

---

## Database Changes

No schema changes are required. Consider adding an index if rate-limit queries are slow:

```sql
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_date ON ai_usage(user_id, date);
```

This index already exists in `0001_schema.sql`.

---

## Testing Strategy

### Unit tests

1. `backend/src/__tests__/crypto.test.ts` — encryption/decryption round-trip, tamper detection, wrong key.
2. `backend/src/__tests__/auth.test.ts` — JWT sign/verify, password hashing, OAuth route behavior.
3. `backend/src/__tests__/index.test.ts` — CORS allowed origins, cache headers, auth middleware.
4. **New:** `backend/src/__tests__/prompt-isolation.test.ts` — mock two households and assert prompt only contains one household's data.
5. **New:** `backend/src/__tests__/cors.test.ts` — test allowed and rejected origins, including production rejection behavior.

### Integration tests

Existing BDD features in `automation/tests/local/api/features/` already cover auth, settings AI-key leakage, scan 429, and a single cross-household 404. Expand to:

1. `automation/tests/local/api/features/security.feature` — scenarios:
   - User A cannot read User B's stock, locations, stores, purchases, plans, or settings.
   - User A cannot modify User B's resources.
   - Receipt image is not accessible without a valid session.
   - Settings response does not contain AI key material.
2. `automation/tests/local/api/features/rate-limit.feature` — scenarios:
   - Exceeding the AI daily limit returns 429.
   - General API rate limit returns 429.

### Manual verification

1. Deploy to production.
2. Test OAuth login/logout with a real Google account.
3. Inspect cookies: `HttpOnly`, `Secure`, `SameSite=None`.
4. Inspect CORS headers from a non-allowed origin and confirm rejection.
5. Upload a receipt and verify the R2 object cannot be accessed directly without the Worker proxy.
6. Verify another user's data is not visible.

---

## Deployment & Secrets

- Ensure all required secrets are set in Cloudflare for every environment.
- Worker startup already checks `WORKER_JWT_SECRET`, `WORKER_ENCRYPTION_KEY`, and `GOOGLE_CLIENT_ID` when `RUN_SECRETS_CHECK=true`.
- Document how to generate a strong `WORKER_JWT_SECRET` and `WORKER_ENCRYPTION_KEY` (`openssl rand -hex 32`).
- Document the OAuth redirect URI format (`https://api.rumaq.workers.dev/api/auth/callback`).

---

## Risks & Mitigations

| Risk                                                               | Impact | Status    | Mitigation                                                                             |
| ------------------------------------------------------------------ | ------ | --------- | -------------------------------------------------------------------------------------- |
| Cross-origin cookies fail in production                            | High   | Mitigated | Test `SameSite=None` + `Secure` early; use `credentials: 'include'` in frontend fetch. |
| AI key leaked in logs or responses                                 | High   | Mitigated | Add explicit tests; never log keys; return only `has_ai_key`.                          |
| Bucket is accidentally made public                                 | High   | Mitigated | Verify bucket policy; use Worker proxy.                                                |
| Rate limiter uses in-memory state and is bypassed across instances | Medium | Open      | Use Cloudflare KV for general API rate limits; use `ai_usage` for AI limits.           |
| Missing `household_id` filter in a new endpoint                    | High   | Open      | Code review checklist; integration tests for every resource.                           |
| CORS too permissive or too restrictive                             | Medium | Open      | Reject unknown origins in production; keep localhost + branch previews for dev.        |
| JWT secret is weak                                                 | High   | Mitigated | Document generation command using `openssl rand -hex 32`.                              |

---

## Open Questions

1. **Should general API rate limiting use KV, D1, or in-memory?** Recommendation: KV for per-second TTL counters if available; otherwise D1 or in-memory with documented limitations.
2. **Should we add a `nonce` or `jti` claim to JWTs to prevent replay?** Not necessary for MVP; the session is long-lived and the cookie is HttpOnly. Consider later.
3. **Should we log all AI prompts for abuse detection?** No, because prompts contain household data. Log only metadata (provider, token count, user_id, timestamp) if needed.
4. **Should rate limits be configurable per user?** Not for MVP; use a global default (20 AI requests/day, 100 API requests/minute).
5. **Should we add CSRF protection beyond OAuth state/PKCE?** For cookie-based API, `SameSite=None` + CORS origin check is the current model. Document this decision.

---

## Alternatives Considered

- **Cloudflare Access instead of custom OAuth:** Rejected earlier because it would complicate local dev and user onboarding. Reconsider only if OAuth maintenance becomes burdensome.
- **Storing AI keys in KV instead of D1:** Rejected because D1 is the source of truth for user settings; KV would add another system.
- **Returning the AI key to the frontend for client-side calls:** Rejected for security; the Worker proxies all AI calls.
- **Public R2 bucket with obfuscated keys:** Rejected; Worker proxy is the current pattern, with signed URLs deferred.

---

## Implementation Notes for a Future Session

1. Start by updating `docs/ARCHITECTURE.md` security checklist to match current code (`SameSite=None`, AI key encryption done, R2 proxy done, prompt isolation open, general rate limit open).
2. Tighten CORS fallback to reject unknown origins in production; add `backend/src/__tests__/cors.test.ts`.
3. Add `Retry-After` to AI 429 responses and implement general API rate limiting.
4. Add `backend/src/__tests__/prompt-isolation.test.ts` and remove internal IDs from prompts where possible.
5. Add `household_id` to the identified DELETE/UPDATE/SELECT id lookups.
6. Add `security.feature` and `rate-limit.feature` integration tests.
7. Run `scripts/test.sh unit frontend`, `scripts/test.sh unit backend`, and `scripts/test.sh automation-local`.
8. Deploy to a branch and run the manual OAuth / cookie / CORS / receipt verification checklist.

After this phase, the app has a defensible security posture for an MVP and is safe for production use.
