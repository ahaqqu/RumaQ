# Security

How RumaQ protects household data and credentials. The full system design lives in [`docs/ARCHITECTURE.md`](ARCHITECTURE.md); this page is the security-focused summary and runbook.

## Model & principles

- One deploy target: a single Cloudflare Worker serves the SPA and the API from the same origin, so the session cookie is same-origin in production.
- All household data is scoped by `household_id`; cross-household access returns `404`, not `403` (no resource existence leak).
- Secrets live only in Worker secrets / `backend/.dev.vars` (gitignored). Never commit them, never read or display `.env` files.
- The AI provider is always proxied through the Worker; user AI keys never reach the browser.

## Session & cookies

- Google OAuth 2.0 with `state` + PKCE (email/password auth exists for local testing behind `EMAIL_AUTH_ENABLED`).
- Session is a signed JWT (HMAC-SHA256, 30-day expiry) in a `rumaq_session` cookie that is `HttpOnly`, `SameSite=Lax` everywhere, and on HTTPS `Secure` too. It is deliberately **not** `SameSite=None` (ahaqqu/RumaQ#528): the app and API share one origin in production and previews (a single Worker serves the SPA and the API), and local dev is same-site even though the SPA (`:5173`) and API (`:8787`) are different origins, so no legitimate caller needs a cross-site cookie. `Lax` is what stops a cross-site form/fetch POST from carrying the session at all.
- Sessions issued before #528 keep their old `SameSite=None` attribute until the user's next login/logout (the browser owns that attribute); the server-side CSRF guard below covers them in the meantime.
- Logout clears the cookie with matching attributes. The epoch bump that revokes every session on every device rides `POST /api/auth/logout` (what the SPA calls, and therefore Origin-guarded); the legacy `GET` navigation only clears the cookie, so a cross-site link or redirect cannot force-log-out every device (#528 review A1).
- Rotate `WORKER_JWT_SECRET` to invalidate all sessions (users just sign in again).

## CSRF

Cookie-authenticated state-changing requests are guarded in `backend/src/lib/csrf.ts`, called once from `backend/src/gateway.ts` **before any app/plugin handler runs**, so every domain app (`auth`, `api`, `households`, `tasks`, `calendar`, `plugins`) and every plugin route is covered by construction.

- In scope: `POST`/`PUT`/`PATCH`/`DELETE` on `/api/*`. If the request supplies `Origin` — or `Referer` when `Origin` is absent — and that origin is neither the request's own origin (`getRequestOrigin`, which honours the local stack's proxy `X-Forwarded-*`) nor an origin this deployment is configured on (`isConfiguredOrigin`: `PAGES_ORIGIN` plus branch previews), the Worker answers `403 {"error":"csrf_origin_mismatch"}` without running a handler and without writing anything.
- Local dev's SPA ports (`http://localhost:5173`, `:8788`) are on the CORS **read** list but are trusted for **writes** only when the request itself is loopback (`localhost`/`127.0.0.1`/`[::1]`). A page served from the user's own localhost is not this app, so it must not authorize a production write — exactly the pre-fix-`SameSite=None` window this guard covers (#528 review A2).
- `Origin: null` (sandboxed iframe / opaque origin) and unparseable values are rejected.
- A request with **no** `Origin` and **no** `Referer` is allowed. Browsers always send at least one on these methods, so this is what keeps `curl` and scripted admin flows working.
- Bearer/internal calls are exempt: `/api/internal/*` (the scraper's bearer-secret channel) and any request carrying `Authorization: Bearer …`. They never carry the session cookie, and a browser cannot attach `Authorization` cross-origin without a CORS preflight, which the allow-list refuses.
- Reads (`GET`/`HEAD`/`OPTIONS`) are unaffected, so cross-site link previews, navigations, and the OAuth redirects keep working. No state change rides a `GET`: the one that used to (`GET /api/auth/logout` bumping the session epoch) now only clears the cookie (#528 review A1).

`SameSite=Lax` is the first layer (the browser refuses to attach the cookie to a cross-site request at all); the Origin guard is the server-side second layer — defense in depth, and the only layer that covers sessions still holding a pre-fix `SameSite=None` cookie. Tests: `backend/src/__tests__/csrf.test.ts` (policy branches plus real-SQLite route assertions: cross-origin write → 403 with no row written, same-origin and no-Origin writes allowed, logout guarded, bearer/internal unaffected, GET unaffected, the session cookie minted as `SameSite=Lax`).

## CORS

Defined in `backend/src/cors.ts`, unit-tested in `backend/src/__tests__/cors.test.ts`. The allow-list itself is `isAllowedOrigin()`, shared with the CSRF guard so "the app's own origins" has exactly one definition:

- Reflects only: the configured origin (`PAGES_ORIGIN`), `http://localhost:5173` / `:8788` for local dev, and branch previews under the configured `*.pages.dev` hostname.
- Unknown origins get `Access-Control-Allow-Origin: null`, which fails browser CORS checks for credentialed requests.
- `Access-Control-Allow-Credentials: true`; Hono answers `OPTIONS` preflights.
- In production the app and API share one origin, so CORS only matters for stale clients and previews.

## Rate limiting

- AI endpoints (`/api/purchases/scan`, `/api/plans/generate`, `/api/ai/chat`) are NOT volume-capped: every completed call is recorded in the `ai_usage_events` D1 table for analytics (admin view at `/api/admin/ai/usage`, 1-year retention) and no usage volume ever gates a call (issue #353). Abuse is instead bounded by the general per-IP limiter below.
- A general per-IP fixed-window limiter (60 s / 100 requests by default, env-tunable via `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_REQUESTS`) guards the whole API with `Retry-After` on 429.
- `/api/auth/email-login` has its own, much tighter limiter (QA-F4, #402): **10 attempts per 60 s per client IP in production**, always answered with a 429 carrying `Retry-After` plus `retry_after` seconds in the body. The budget is env-tunable via `LOGIN_RATE_MAX` / `LOGIN_RATE_WINDOW_SEC` (defaults `10` / `60`), and the parser is defensive: missing, non-integer, zero, or negative values fall back to those defaults, so no typo can make the limiter unlimited. Only the local/e2e harness raises it (`automation/docker-compose.yml`, #499) — the production and preview defaults never move.
- Known limitation: both limiters are in-memory (per-isolate); the ingest endpoint (`POST /api/internal/ingest/prices`) is exempt because it authenticates with a bearer secret, not a session.

## Secrets & key material

| Secret                  | Purpose                                              | Generation             |
| ----------------------- | ---------------------------------------------------- | ---------------------- |
| `WORKER_JWT_SECRET`     | HMAC key for session JWTs                            | `openssl rand -hex 32` |
| `WORKER_ENCRYPTION_KEY` | Derives the AES-GCM key that encrypts stored AI keys | `openssl rand -hex 32` |
| `HAQITA_INGEST_SECRET`  | Bearer auth for the internal price-ingest endpoint   | `openssl rand -hex 32` |

Setup steps and the full variable table: [`docs/ARCHITECTURE.md` §8](ARCHITECTURE.md).

**Rotation consequences:** changing `WORKER_ENCRYPTION_KEY` makes previously stored AI keys undecryptable — users must re-enter their key after rotation (plan a notice). Rotating `WORKER_JWT_SECRET` signs everyone out.

`HAQITA_INGEST_SECRET` is operator-owned and rotated out-of-band; the CI deploy deliberately never writes it (ahaqqu/RumaQ#456), so rotating it is a `cf workers secrets update` plus the matching move of the two consumers — the pipeline's box env and the read-only GitHub repo secret the smoke freshness check authenticates with — and never a deploy. [`docs/ARCHITECTURE.md` §8](ARCHITECTURE.md) lists the three copies and the successor-secret (`HAQITA_INGEST_SECRET_NEXT`) path that rotates without a 401 window.

## Data isolation & privacy

- Every D1 query touching household-scoped data filters by `household_id`/`user_id`; final mutations re-check ownership (defense in depth).
- A client-supplied `item_id` is never trusted on the write path: `POST /api/purchases` and the plan check-off path (`PATCH /api/plans/:id/items/:itemId`) resolve it through `items.household_id` first, so a foreign or unknown id answers `404` and writes nothing (#517). This is a write-side guard: rows written before #517 (or restored from a backup) are still rendered through the historical `items` join and are not re-verified on read.
- AI prompts are built from the current household only and pass store **labels**, not internal IDs — covered by `backend/src/__tests__/prompt-isolation.test.ts`.
- Receipt images sit in a private R2 bucket and are only readable through the household-checked proxy `GET /api/purchases/:id/receipt`.
- Document-vault files (ahaqqu/RumaQ#388; multi-file per document since #422) live under the `documents/` prefix of the same private bucket and stream only through the household-scoped, auth-required, per-file `GET /api/documents/{id}/files/{fileId}/content` (`Cache-Control: private, no-store`, view/download audited per request; the file must belong to the named document). No public or presigned URLs exist for them.
- AI keys are encrypted at rest with AES-GCM (PBKDF2-derived 256-bit key, random IV) and never returned by the API — only a `has_ai_key` flag.

## Dependency & vulnerability management

- Dependabot (daily) and the audit workflow (`bun audit`, daily) open PRs for fixes; unfixable/breaking vulnerabilities become `security`-labelled issues that auto-close when a later audit passes.
- Transitive pins live in the root `package.json` `overrides`.

## Reporting

For private reports, open a GitHub security advisory on this repository. For non-sensitive issues, a normal issue with the `security` label works.
