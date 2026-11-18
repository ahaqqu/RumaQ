---
name: cloudflare-troubleshoot
description: Use when investigating the RumaQ production Cloudflare Worker (`api`) or its D1 database via API — Worker 1101/500 diagnosis, exceededResources/scriptThrewException analysis, invocation analytics, D1 metrics, read-only D1 SQL, or deploy runtime verification. Self-serve through the REST + GraphQL Analytics APIs with the manager's scoped token; the dashboard is the fallback, never the default. Triggers: worker 500, error 1101, exceededResources, scriptThrewException, Workers Logs, D1 metrics, Cloudflare analytics, CF token, "check production logs", "why did the worker crash".
---

# Cloudflare Troubleshoot

Self-serve production evidence for the `api` Worker and its D1 database (`rumaq`), read-only by construction. Everything here was validated live (2026-11-18) during the chunk-9 incident: GraphQL Analytics is the workhorse; the REST query API for telemetry is a dead end; D1 SELECT over REST unblocks counts that are otherwise admin-gated.

## Hard rules

- **Read-only by construction.** Despite the token carrying `D1 : Edit` (REST's query endpoint is POST-shaped, so edit scope is unavoidable), run SELECT only — never INSERT/UPDATE/DELETE/DDL, never Workers scripts writes, never purge/rotate/deploy endpoints.
- **The token is never displayed.** Not echoed, not piped, not printed in errors. Diagnostics show only length and a masked shape. It lives in `~/.bashrc` and is sourced, same discipline as `RUMAQ_REVIEW_TOKEN`.
- **Never read `.env` files** — CF credentials are not in them and reading them is forbidden anyway.

## 1. Source the token (and why the naive way fails)

```bash
set -a; source /dev/stdin <<< "$(grep -E '^export CLOUDFLARE_API_TOKEN=|^CLOUDFLARE_API_TOKEN=' ~/.bashrc)"; set +a
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/user/tokens/verify | jq -c '{success, status: .result.status}'
```

Expect `{"success":true,"status":"active"}` — cheap first call, proves auth before any real query.

Why grep-to-stdin instead of `source ~/.bashrc`: the bashrc line has **no `export` prefix**, and non-interactive shells hit bashrc's early-return guard before reaching it anyway. Grep extracts exactly the one line; `set -a` auto-exports it.

Known failure: curl says `Invalid format for Authorization header` → the variable is **empty**, meaning grep matched nothing (wrong var name, no line). Debug the env (`[ -n "$CLOUDFLARE_API_TOKEN" ] && echo present; echo "${#CLOUDFLARE_API_TOKEN}"`), never the value.

## 2. Identify account, Worker, database

- **Worker**: `api` in production; preview branches deploy as `rumaq-api-{branch}`. Source of truth: `backend/cloudflare.config.ts`.
- **D1 database**: `rumaq` (binding `DB`), same file.
- **Account tag**: not pinned in the repo (env-only at build time). Resolve dynamically:

```bash
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/accounts | jq -c '.result[] | {id, name}'
```

```bash
# D1 database id (needed for d1AnalyticsAdaptiveGroups filtering and REST SELECT)
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database" \
  | jq -c '.result[] | {uuid, name}'
```

## 3. Skip the telemetry query API — go straight to GraphQL

The Workers **telemetry/query REST API requires a server-side `queryId`** (registered server-side by a prior dashboard/API session). A client-generated UUID gets `"Query not found"`. Don't burn time there — the documented **GraphQL Analytics API** covers everything needed for incident diagnosis:

```
POST https://api.cloudflare.com/client/v4/graphql
Authorization: Bearer $CLOUDFLARE_API_TOKEN
Content-Type: application/json
{"query":"…","variables":{…}}
```

## 4. Worker invocations — who threw, when, what class

```graphql
query ($accountTag: String!, $filter: WorkersInvocationsAdaptive_Filter!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(filter: $filter, limit: 10000) {
        dimensions {
          datetimeMinute
          status
          scriptName
        }
        sum {
          requests
          errors
        }
      }
    }
  }
}
```

Variables (times are ISO 8601 UTC; keep windows tight — minutes, not hours):

```json
{
  "accountTag": "…",
  "filter": {
    "scriptName": "api",
    "datetime_geq": "2026-11-17T13:32:00Z",
    "datetime_leq": "2026-11-17T13:34:00Z"
  }
}
```

Field notes (learned the hard way):

- **There is no `errorType` field** on this dataset — don't fight it. `status` carries the fault class: `success`, `clientDisconnected`, `exceededResources`, `scriptThrewException`.
- `exceededResources` = **CPU-limit kill** (the Cloudflare 1101 surface): the request was making progress but blew the CPU budget. Not a bug in user code per se — a workload-shape problem.
- **Double-dispatch signature**: `exceededResources` and `scriptThrewException` rows landing on the _same second_ with doubled request counts = two gateways fired the same work and the loser died mid-flight (fixed in RumaQ #719; reappear only if dispatch logic regresses).

## 5. D1 analytics — did the DB act before/during/after the failure

```graphql
query ($accountTag: String!, $filter: D1AnalyticsAdaptiveGroups_Filter!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(filter: $filter, limit: 10000) {
        dimensions {
          datetimeMinute
        }
        sum {
          readQueries
          writeQueries
          rowsRead
          rowsWritten
        }
      }
    }
  }
}
```

Variables: same shape; add `"databaseId": "<uuid>"` to the filter (uuid from step 2).

Field notes:

- **No `queriesCount`** — use `readQueries`/`writeQueries`/`rowsRead`/`rowsWritten`.
- Interpretation matrix (the chunk-9 verdict came from this):
  - Writes flowing **at** the failure timestamp → **mid-ingest death**: work started and died partway. Expect stranded items needing replay.
  - Zero activity at the failure timestamp → **crash-before-query**: the fault is earlier in the request path.

## 6. D1 read-only SELECT (REST)

```bash
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database/$DB_ID/query" \
  -d '{"sql":"SELECT status, count(*) AS n FROM match_review_items GROUP BY status"}'
```

(The SQL above is a shape example — list real table names via `SELECT name FROM sqlite_master WHERE type='table'` first; the production DB held 146 tables when this recipe was validated.)

Unblocks what is otherwise admin-gated (review-queue pending counts, publish outbox sizes, verification counts). Large scans: always `LIMIT` and count via `GROUP BY`/`count(*)`, never dump rows.

## 7. Error-1101 playbook (ordered)

1. **Pin the window** first from existing evidence (run report, status.json, deploy timestamps) — never diagnose an unbounded window.
2. **Invocations query** (§4) → status distribution per minute; look for `exceededResources`/`scriptThrewException` pairs and doubled counts.
3. **D1 query** (§5) for the same window → before/during/after matrix from §5.
4. **Interpret against known signatures**: double-dispatch (see §4) vs CPU ceiling. The 2026-11-17 chunk-9 case was the ceiling: a tail chunk full of new products (canonical creation is CPU-heavier per item) × doubled fallback work → 1101. Mitigations live in RumaQ #719 (no double-dispatch) and pipeline #169 (per-store smaller invocations); the fallback lever is sub-400-item chunks for canonical-heavy stores.
5. **Neither signature present?** Escalate to the owner for a dashboard read (Workers & Pages → `api` → Logs, live tail) — full stdout logs are the one thing GraphQL Analytics does not expose. Record it in MANUAL_ACTIONS with a numbered owner-action ID.

## 8. Dashboard fallback (when the token is missing or revoked)

Route the owner to `dash.cloudflare.com/profile/api-tokens` (create a custom token: Workers Observability Read + Workers Scripts Read + Account Analytics Read + D1 Edit, account-scoped, no zones) or have them read dash → Workers & Pages → api → Logs/Metrics and D1 → rumaq → Metrics directly. Never ask them for something §4–§6 already covers.
