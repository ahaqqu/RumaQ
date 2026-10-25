# Backend Conventions

High-level objectives and defaults for backend work. Prefer these over one-off custom solutions unless there is a clear reason to deviate.

## Structure and routing

- Keep the Hono app structure: one app per domain, wired through the gateway.
- Add new domain apps alongside the existing ones and route them in the gateway.
- Keep route handlers focused on HTTP concerns; extract business logic and repeated data access into services or helpers.

## Validation

- Use Valibot for all request inputs: params, query, and body.
- Return consistent validation error shapes.
- Validate environment variables at startup to fail fast on missing configuration.

## Database

- Access D1 through the bound environment.
- Use parameterized queries with placeholders and binding to avoid SQL injection.
- Batch multiple writes in a single transaction when they belong together.
- Prefer typed query results over loose casting.

## Auth

- Rely on the existing session/JWT middleware and auth helpers; do not re-implement auth checks.
- Keep the OAuth PKCE flow and state validation intact.
- Gate email/password auth behind the feature flag.

## Caching

- Set cache headers through shared helpers for public, private, and error responses.
- Public routes are cacheable; authenticated routes are private, no-cache.

## Errors

- Use a consistent error shape and a shared error handler across apps.
- Do not expose raw internal error messages to clients in production.

## Testing

- Write route-level tests with Vitest and Hono's request helper.
- Use a shared mock environment factory to reduce test boilerplate.
- Keep tests close to the code they test.

## Security

- Restrict CORS to known origins.
- Keep cookies `httpOnly`, `secure`, and with an appropriate `sameSite` policy.
- Do not read or expose `.env` files.
- Parameterize all SQL queries.
- Add rate limiting on auth and sensitive endpoints.
- Add security headers middleware for production responses.

## API documentation

- `docs/API.md` is auto-generated from route definitions via `./scripts/docs.sh`.
- Do not edit `docs/API.md` manually — regenerate it after adding, removing, or changing routes.
- Use `describeRoute` from `hono-openapi` to annotate each handler with a description, response schemas, and security requirements so the generated doc is accurate.
- Run `./scripts/docs.sh` before committing backend route changes that affect the public API surface.

## Dependencies

- Prefer public, trusted libraries for external integrations and common logic (e.g., JWT, SQL type safety).
- Avoid introducing heavy dependencies on the Workers runtime where a small helper or built-in Web API suffices.

## Quick-start checklist for new backend changes

1. Schema changes: add `backend/migrations/NNNN_description.sql` (next free number); never edit applied migrations.
2. Declare new bindings/env vars in `backend/src/types.ts` and `backend/cloudflare.config.ts`.
3. Add routes in the domain app under `backend/src/apps/`, annotate with `describeRoute`, validate inputs with Valibot, keep every D1 query household-scoped.
4. Extract logic into `backend/src/lib/`; write route-level tests in `backend/src/__tests__/` and an automation scenario in `automation/tests/local/api/`.
5. Run `./scripts/docs.sh` and commit the regenerated `docs/API.md`; then `./scripts/style.sh --check` and `./scripts/test.sh unit backend`.
