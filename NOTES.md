# #318 Investigation Notes (WIP — harness cold-start 500 vs 401)

Branch: fix/harness-cold-start-401 (worktree RumaQ-318). Issue: first
unauthenticated request in the automation harness returns 500 instead of 401.
Two occurrences: scheduled run 40905259261 (purchases.steps.js) and PR #307
review run (ai-chat.steps.js). Both were the FIRST test of a file.

## Boot path (verified)

- `scripts/test.sh automation-local --build` -> `automation/scripts/test-local.sh`
  -> docker compose `api` (node worker-server.mjs) + `web` (nginx) + `proxy`
  (nginx :3000) + `test-runner` (compose run).
- api container: `automation/tests/support/worker-server.mjs` builds the worker
  (vite cloudflare plugin bundle), starts Miniflare with real D1 (`rumaq-test`)
  and R2 buckets, applies ALL migrations + reset.sql + seed.sql BEFORE
  `server.listen(8787)`. So D1 is migrated/seeded before the port opens.
- compose healthcheck curls `localhost:8787/api/health` every 2s (retries 30,
  start_period 15s); proxy `depends_on: api: service_healthy`; test-runner
  `depends_on: proxy: service_started`. `ensure_stack()` additionally polls
  `localhost:3000/api/health` (30x1s).
- => by the time vitest runs, workerd has served MANY /api/health dispatches.
  "Workerd cold start" as classically understood is already warmed away.

## Evidence from failed scheduled run 40905259261 (log downloaded to /tmp/run318-failed.log)

- vitest project `integration` has `fileParallelism: false` => test files run
  SEQUENTIALLY. prices.steps.js (18 tests), plans (13), brochures (7) all PASSED
  before purchases.steps.js started. So the 500 was NOT the first request to the
  worker globally; it was the first test of the purchases FILE.
- Failure: `expectStatus(401)` got 500, test took 42ms. Body not captured
  (helpers only assert status). onError in apiApp does console.error(err) but
  api container was torn down (compose down --volumes) so logs are gone.
- No playwright artifacts were produced (suite aborted before e2e).

## Middleware chain for unauthenticated request (verified)

gateway.fetch: TEST_MODE=true skips secrets check; /api/purchases is not an
AUTH_ROUTE; ctx.exports.CachedApi path or direct apiApp.fetch.

apiApp: `logger()` -> `createCors()` (hono cors, origin fn, no I/O) ->
rate-limit middleware (in-memory Map, X-Forwarded-For synthetic IP per
ApiContext instance) -> route -> `propsAuthMiddleware`:
- `c.env.props` (undefined in Miniflare), then getCookie -> no cookie -> 401
  IMMEDIATELY. The 401 path NEVER touches D1.

=> A 500 on this path cannot originate in propsAuthMiddleware. Remaining 500
sources:
1. worker-server.mjs outer catch: ANY throw inside the request try-block
   (dispatchFetch, arrayBuffer, etc.) => 500 {error: err.message}.
2. apiApp.onError from logger/cors/rate-limit (all pure JS, unlikely).
3. nginx proxy 500 (nginx returns 502/504 for upstream errors, 500 unusual).

## Working hypotheses (to verify by reproduction)

H1: dispatchFetch throws transiently when a burst of first requests from a
fresh vitest worker process races something in Miniflare/workerd (D1 open
handles during reset/seed from the previous file? SQLite WAL checkpoint?).
H2: the `db.exec` reset/seed (direct Node -> D1) interleaving with worker-side
D1 requests causes a one-off SQLITE_BUSY surfaced through dispatchFetch.
H3: something in the vitest worker process start (undici fresh pool) hits the
proxy at the same moment as a healthcheck curl, and one gets an error.

Key missing datum: the 500 BODY ({error: err.message} tells us exactly which
layer threw). Reproduction must capture it.

## Reproduction plan

R1: fresh stack (down -v, up --build), fire unauthenticated POST /api/purchases
    immediately in a tight loop, capture bodies.
R2: full automation-local run with temporary instrumentation to dump responseBody
    on 500 (revert before final diff).
R3: if nondeterministic, add the harness-level guard (readiness probe hitting an
    UNAUTHENTICATED auth-protected endpoint expecting 401, retry-once on
    cold-start signature) which is the mandated fix anyway; the guard itself
    provides the evidence trail in CI logs.
