# Security

How RumaQ protects household data and credentials. The full system design lives in [`docs/ARCHITECTURE.md`](ARCHITECTURE.md); this page is the security-focused summary and runbook.

## Model & principles

- One deploy target: a single Cloudflare Worker serves the SPA and the API from the same origin, so the session cookie is same-origin in production.
- All household data is scoped by `household_id`; cross-household access returns `404`, not `403` (no resource existence leak).
- Secrets live only in Worker secrets / `backend/.dev.vars` (gitignored). Never commit them, never read or display `.env` files.
- The AI provider is always proxied through the Worker; user AI keys never reach the browser.

## Session & cookies

- Google OAuth 2.0 with `state` + PKCE (email/password auth exists for local testing behind `EMAIL_AUTH_ENABLED`).
- Session is a signed JWT (HMAC-SHA256, 30-day expiry) in a `rumaq_session` cookie that is `HttpOnly`, and on HTTPS `Secure` + `SameSite=None` (`Lax` on local plain-HTTP dev).
- Logout clears the cookie with matching attributes.
- Rotate `WORKER_JWT_SECRET` to invalidate all sessions (users just sign in again).

## CORS

Defined in `backend/src/cors.ts`, unit-tested in `backend/src/__tests__/cors.test.ts`:

- Reflects only: the configured origin (`PAGES_ORIGIN`), `http://localhost:5173` / `:8788` for local dev, and branch previews under the configured `*.pages.dev` hostname.
- Unknown origins get `Access-Control-Allow-Origin: null`, which fails browser CORS checks for credentialed requests.
- `Access-Control-Allow-Credentials: true`; Hono answers `OPTIONS` preflights.
- In production the app and API share one origin, so CORS only matters for stale clients and previews.

## Rate limiting

- AI endpoints (`/api/purchases/scan`, `/api/plans/generate`, `/api/ai/chat`) are limited per user per day via the `ai_usage` D1 table (default 20/day) — but only when the request is served with RumaQ's shared server key (`RUMAQ_SERVER_AI_PROVIDER`/`RUMAQ_SERVER_AI_KEY`). Users who configure their own provider key are unmetered; usage is still counted for the meter. 429 responses include `Retry-After`.
- A general per-IP fixed-window limiter (60 s / 100 requests by default, env-tunable via `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_REQUESTS`) guards the whole API with `Retry-After` on 429.
- Known limitation: the general limiter is in-memory (per-isolate); the ingest endpoint (`POST /api/internal/ingest/prices`) is exempt because it authenticates with a bearer secret, not a session.

## Secrets & key material

| Secret                  | Purpose                                              | Generation             |
| ----------------------- | ---------------------------------------------------- | ---------------------- |
| `WORKER_JWT_SECRET`     | HMAC key for session JWTs                            | `openssl rand -hex 32` |
| `WORKER_ENCRYPTION_KEY` | Derives the AES-GCM key that encrypts stored AI keys | `openssl rand -hex 32` |
| `HAQITA_INGEST_SECRET`  | Bearer auth for the internal price-ingest endpoint   | `openssl rand -hex 32` |

Setup steps and the full variable table: [`docs/ARCHITECTURE.md` §8](ARCHITECTURE.md).

**Rotation consequences:** changing `WORKER_ENCRYPTION_KEY` makes previously stored AI keys undecryptable — users must re-enter their key after rotation (plan a notice). Rotating `WORKER_JWT_SECRET` signs everyone out.

## Data isolation & privacy

- Every D1 query touching household-scoped data filters by `household_id`/`user_id`; final mutations re-check ownership (defense in depth).
- AI prompts are built from the current household only and pass store **labels**, not internal IDs — covered by `backend/src/__tests__/prompt-isolation.test.ts`.
- Receipt images sit in a private R2 bucket and are only readable through the household-checked proxy `GET /api/purchases/:id/receipt`.
- AI keys are encrypted at rest with AES-GCM (PBKDF2-derived 256-bit key, random IV) and never returned by the API — only a `has_ai_key` flag.

## Dependency & vulnerability management

- Dependabot (daily) and the audit workflow (`bun audit`, daily) open PRs for fixes; unfixable/breaking vulnerabilities become `security`-labelled issues that auto-close when a later audit passes.
- Transitive pins live in the root `package.json` `overrides`.

## Reporting

For private reports, open a GitHub security advisory on this repository. For non-sensitive issues, a normal issue with the `security` label works.
