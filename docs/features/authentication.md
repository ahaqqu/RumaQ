# Authentication

RumaQ uses **session-based authentication** with signed JWTs stored in an `httpOnly` cookie. Two methods are supported: Google OAuth 2.0 (primary) and email-password login (fallback).

## What it changes

- **Google OAuth** — users can log in with their Google account via PKCE flow
- **Email login** — optional email/password login gated by `EMAIL_AUTH_ENABLED`
- **Session cookie** — `rumaq_session` JWT cookie is set on login, read by middleware on every request
- **Middleware** — `propsAuthMiddleware` resolves `userId` and `householdId` before protected route handlers
- **Household provisioning** — first-time login auto-creates a household with seed locations and stores

## How it works

### Google OAuth flow

1. User visits `/api/auth/login` → redirected to Google's consent screen
2. Google redirects to `/api/auth/callback` with an authorization code
3. The code is exchanged for an access token; user info is fetched from Google
4. The user is upserted into the `users` table (keyed on `google_id`)
5. If the user has no household, one is created with default locations (Kulkas, Freezer, Lemari, Rak) and stores (Indomaret, Alfamart, Pasar)
6. A `rumaq_session` JWT is signed with `sub` (user ID), `email`, `iat`, and `exp` (30 days)
7. The cookie is set (`httpOnly`, `secure` on HTTPS, `sameSite: Lax` — never `None`; see `docs/SECURITY.md` §CSRF, #528) and the browser redirects to the app

### Email login flow

1. `POST /api/auth/email-login` with `{ email, password }`
2. Password verified against the stored hash via `verifyPassword()`
3. Same JWT and cookie as Google OAuth are issued

Attempts are rate limited per client IP — 10 per 60 s in production (QA-F4, #402). Exhausting the budget answers 429 with `Retry-After` and `retry_after` seconds in the body. The budget is env-tunable via `LOGIN_RATE_MAX` / `LOGIN_RATE_WINDOW_SEC`; only the local/e2e harness raises it (#499), and invalid values fall back to the 10 / 60 s defaults. See [`docs/SECURITY.md` § Rate limiting](../SECURITY.md).

### Session verification (middleware)

1. `propsAuthMiddleware` reads the `rumaq_session` cookie
2. Verifies the JWT signature using `WORKER_JWT_SECRET`
3. Looks up the user's active household (first checks `user_settings.active_household_id`, then falls back to the first `household_members` row)
4. Sets `c.set('userId', ...)` and `c.set('householdId', ...)` for downstream handlers
5. Returns 401 if the cookie is missing, tampered, expired, or the user has no household

### Logout

- `GET /api/auth/logout` — clears the cookie and redirects to `/`
- `POST /api/auth/logout` — clears the cookie and returns `{ ok: true }`

## API endpoints

| Method | Path                    | Auth | Description                                           |
| ------ | ----------------------- | ---- | ----------------------------------------------------- |
| GET    | `/api/auth/login`       | —    | Redirects to Google OAuth consent screen              |
| GET    | `/api/auth/callback`    | —    | Google OAuth callback, sets session cookie            |
| POST   | `/api/auth/email-login` | —    | Email/password login, sets session cookie             |
| GET    | `/api/auth/logout`      | —    | Clears session cookie, redirects (no epoch bump)      |
| POST   | `/api/auth/logout`      | —    | Clears cookie + session epoch, returns `{ ok: true }` |

## Configuration

| Environment variable    | Required | Description                                                                 |
| ----------------------- | -------- | --------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`      | Yes\*    | Google OAuth client ID                                                      |
| `GOOGLE_CLIENT_SECRET`  | Yes\*    | Google OAuth client secret                                                  |
| `WORKER_JWT_SECRET`     | Yes      | Secret used to sign and verify JWTs                                         |
| `EMAIL_AUTH_ENABLED`    | No       | Set to `true` to enable email/password login                                |
| `LOGIN_RATE_MAX`        | No       | Login attempts per IP per window (default `10`; tests raise it, #499)       |
| `LOGIN_RATE_WINDOW_SEC` | No       | Login rate-limit window in seconds (default `60`; invalid values fall back) |
| `PAGES_ORIGIN`          | No       | Frontend origin for OAuth callback redirect                                 |

\*Required only when Google OAuth is used.

## Source

- `backend/src/apps/auth.ts` — auth routes (login, callback, email-login, logout)
- `backend/src/auth.ts` — JWT signing/verification, PKCE helpers, middleware
- `backend/src/__tests__/auth.test.ts` — unit tests for JWT, OAuth callback, email login
