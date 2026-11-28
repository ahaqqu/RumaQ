# RumaQ v2 — Cloudflare versus VPS, D1 versus PostgreSQL

> Design input for [#758](https://github.com/ahaqqu/RumaQ/issues/758). No infrastructure was changed. Cloudflare figures below link to official documentation and must be rechecked at implementation time. VPS figures are from a read-only live check, not a capacity benchmark.

## 1. Recommendation

Use **PostgreSQL 17 on the existing VPS as the system of record**, with a **Bun/Hono modular monolith on the same VPS**, provided the capacity and restore gates below pass.

- Keep **R2** for immutable brochure/source evidence and encrypted off-box database backups. Keep household/receipt objects private and separate from public brochure evidence.
- Keep **Cloudflare DNS, CDN, and security controls** in front of the public site where compatible with accurate client-IP/rate-limit behavior.
- Keep the scraper's **authenticated, schema-validated, idempotent ingest API**, even when scraper and API share the host. Do not couple scraper code directly to database tables.
- Use a separate PostgreSQL database and least-privilege role on the existing cluster; no other app receives RumaQ credentials.
- Do not adopt Workers -> Hyperdrive -> VPS PostgreSQL as the default. It retains a daily free query ceiling or requires the paid plan while adding a network/tunnel dependency to the same single database.
- Do not rely on D1 Free for the rebuilt product. The owner has already hit free limits, and the new public read/history/evidence model makes those limits an avoidable availability risk.

This is a strong recommendation, not permission to deploy. A failed capacity, backup/restore, or public-load gate triggers an explicit choice between upgrading the VPS and managed PostgreSQL; silently falling back to D1 Free is not an acceptable substitute.

## 2. Current-state facts

### Existing application

- React/Vite SPA and Hono API deploy as one Cloudflare Worker; D1 holds application data and R2 holds objects.
- There are 54 D1/SQLite migrations and a large route/data-access surface. The new design is a fresh schema, not a SQL translation of that migration history.
- Production currently authenticates the price explorer; public promo browsing requires a deliberate public API/shell split.

### Existing VPS

The `ahaqqu/vps` inventory documents Debian 12, nginx, Bun, Postgres 17 + pgvector on loopback, the RumaQ scraper, and several other applications. The box has 2 vCPU / 4 GB RAM and no swap. The scraper has a 1.2 GB memory hard cap.

Live read-only measurement:

| Measure         | Observed                                               |
| --------------- | ------------------------------------------------------ |
| Root filesystem | 125 GB total, 6.6 GB used, **113 GB available**        |
| RAM             | 3,919 MiB total, **3,277 MiB available** at check time |
| Swap            | 0                                                      |
| Load            | 0.14 / 0.09 / 0.03                                     |
| Uptime          | 39 days                                                |

The inventory's “disk is scarce” comment is stale for this check. RAM and single-node availability remain real constraints; a point-in-time reading is not a load test.

## 3. Cloudflare constraints and prices

Official sources: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/), and [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

| Capability          | Free                                                     | Paid / important constraint                                                        |
| ------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| D1 database size    | 500 MB/database; 5 GB/account                            | 10 GB/database on paid; a single database remains single-threaded/single-writer    |
| D1 usage            | 5M rows read/day; 100k rows written/day                  | Workers Paid includes 25B rows read/month and 50M rows written/month, then metered |
| D1 invocation/query | 50 queries per Worker invocation                         | 30 s maximum SQL/API duration; batch and result limits remain                      |
| Workers             | 100k requests/day; 10 ms CPU/invocation; 50 subrequests  | $5/month minimum; higher request/CPU/subrequest allowances                         |
| Hyperdrive          | 100k database statements/day                             | Included with Workers Paid; connection pooling/caching included                    |
| R2                  | 10 GB-month, 1M Class A and 10M Class B operations/month | Standard storage $0.015/GB-month; egress free                                      |

Exceeding D1 Free daily reads/writes makes queries fail until reset. Paid D1 removes those daily ceilings but does not turn it into PostgreSQL or remove its 10 GB/single-writer design. Indexed reads matter because scanned rows—not only returned rows—are billed.

## 4. Options

| Option                                           | Strengths                                                                                                                                                                                     | Weaknesses                                                                                                                                                                                | Decision                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **A. Worker + D1 + R2**                          | Existing deploy path, little host maintenance, static assets free, easy previews.                                                                                                             | Owner already hit free limits; paid still has D1 size/single-writer/query constraints; 54-migration legacy model does not fit the new domain; SQLite-to-v2 semantics remain a compromise. | Reject as the primary fresh build. Retain as rollback until cutover verification ends.                  |
| **B. VPS Bun/Hono + PostgreSQL + R2**            | Full relational constraints/transitions, no daily query ceiling, pgvector available, pipeline and API share a low-latency host, simplest operating topology, existing host/deploy discipline. | Shared 4 GB/no swap; single-node availability; backups, monitoring, security, and capacity are our responsibility.                                                                        | **Recommended pending gates.**                                                                          |
| **C. Worker + Hyperdrive + VPS PostgreSQL**      | Edge compute/static hosting with PostgreSQL semantics.                                                                                                                                        | Free daily statement ceiling or $5 paid; remote DB/tunnel dependency; same VPS capacity/availability; more moving parts.                                                                  | Reject by default; reconsider only if measured edge latency has decisive product value.                 |
| **D. Worker/static + managed PostgreSQL**        | Off-box database backups/capacity, PostgreSQL semantics, global frontend.                                                                                                                     | Additional vendor/account/cost and network path; still needs app compute and secret/network design.                                                                                       | Fallback if the VPS fails capacity/availability gates; compare measured managed price before selection. |
| **E. All-in VPS including local object storage** | Fewer external services.                                                                                                                                                                      | Consumes disk and outbound bandwidth; evidence and backups share one failure domain.                                                                                                      | Reject. R2's free/low-cost off-box storage is useful independently of D1/Workers.                       |

## 5. Target deployment

```text
Public browser
  -> Cloudflare DNS/CDN/security
  -> nginx on VPS
       -> static frontend assets
       -> Bun/Hono API on loopback
            -> PostgreSQL rumaq DB on loopback
            -> R2 public-evidence / private-household / private-backup buckets

RumaQ-pipeline on VPS
  -> immutable source artifacts + content hashes
  -> authenticated ingest/review API
  -> accepted offers transactionally published in PostgreSQL

Backup timer
  -> encrypted PostgreSQL dump -> private R2
  -> independent restore verification
```

Cloudflare proxying must preserve client IP through a documented trusted-proxy/XFF chain before public rate limits rely on it. Existing VPS notes already treat this as a prerequisite for other applications. Do not put every public client into one nginx limiter bucket.

## 6. Required decision gates

### Capacity

1. Record actual PostgreSQL, scraper, API, nginx, and other-service memory during an extraction run plus public-read load.
2. Give the API an explicit systemd memory/CPU budget; retain the scraper's cap. No service may assume all 4 GB is available.
3. Load-test anonymous catalog/product/history reads and authenticated writes while Superindo extraction runs.
4. Verify database indexes and query plans under at least the expected two-campaign corpus plus a synthetic growth multiple.
5. Establish disk/log rotation and an alert threshold. R2 keeps brochure bytes off the database and host.

If the box cannot run the pilot within its budgets, price a VPS upgrade against managed PostgreSQL before more implementation.

### Backup and restore

1. Nightly encrypted PostgreSQL dump to private R2, with bounded retention and failure visibility.
2. Automated integrity/schema/canary checks; scheduled restoration into a scratch database.
3. Prove application boot and representative public/account/admin reads against the restored database.
4. A fresh dump must pass a restore drill before production cutover.
5. Define RPO/RTO explicitly; add WAL archiving/PITR only if the accepted recovery objective requires it.

### Public production

1. Anonymous price/campaign/product APIs expose only approved, valid, published data; private household/admin routes remain deny-by-default.
2. Public responses use short, versioned cache validation; private responses are `private, no-store`/`no-cache` as appropriate.
3. Rate limits, body limits, CSRF, secure cookies, security headers, and audit logs pass tests.
4. No region/member/multi-buy condition is lost in cached public responses.
5. Rollback restores the prior application/Worker route without importing or mutating the old D1 data.

## 7. Cost model

Do not claim the VPS is free merely because it already exists. Report both:

- **Incremental monthly cost:** new AI usage + paid source/proxy/Actor usage + R2 overage + any Cloudflare paid plan + any VPS upgrade/managed database delta.
- **Fully allocated monthly cost:** incremental cost + existing VPS subscription + domain + fixed backup/monitoring costs.

For each store, report AI/platform spend per run, campaign, accepted offer, and correction. For infrastructure, report monthly fixed cost separately from per-item extraction cost. Use provider-reported usage where available and label estimates/missing prices explicitly.

The plan has no arbitrary monthly cap. It requires measured evidence and owner approval before paid model/source expansion or a higher infrastructure tier.
