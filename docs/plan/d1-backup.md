# D1 Backup / Export Strategy (ahaqqu/RumaQ#342 — Phase 11 residual)

**Status:** Design + partial implementation (restore tooling tested, backup workflow armed)
**Entry phase:** Design — backup strategy is architectural (export target, schedule, restore path).
**Hard acceptance:** a restore path must exist and be **tested**, not just an export.
**Residual not in scope here:** query-performance monitoring — see §12.

---

## 1. Goals and non-goals

**Goals**

1. A scheduled, automated export of the production D1 database (`rumaq`) to a
   private R2 keyspace, with bounded retention.
2. A **tested** restore path: a scripted drill that takes a dump file, restores
   it into a local SQLite (D1 is SQLite), and asserts row-count spot checks.
3. Backup-success visibility: a failed backup raises a GitHub issue
   automatically; a succeeding run closes it (same pattern as `smoke.yml`).
4. Cost ≈ zero; no new production surface (no Worker route, no public object
   access, no VPS involvement).

**Non-goals**

- Cross-bucket / second-region copies of R2 objects (receipts & document bytes
  stay on R2's built-in durability; noted as future work in §10).
- Continuous replication, read replicas, sharding.
- Automated restore *into production* — that stays a human-run runbook (§7).
- R2 lifecycle-rule backstop — the export script prunes; a `backups/`-prefix
  lifecycle rule is listed as an optional owner hardening step (§9).

---

## 2. What already exists (evidence base)

| Fact | Evidence |
| --- | --- |
| D1 has built-in PITR ("Time Travel"): restore to any minute within the last **30 days** (Workers Paid) / **7 days** (Workers Free); restore is **in-place and destructive**, Wrangler CLI only; docs explicitly say "to keep states longer than 30 days, export to R2 via REST API" | Cloudflare D1 docs — Time Travel and backups (`developers.cloudflare.com/d1/reference/time-travel`) |
| D1 export REST API: `POST /accounts/{account_id}/d1/database/{database_id}/export` with `output_format: "polling"`; poll until `status: "complete"`; returns `signed_url` "available for one hour"; caveat: an in-progress export "may take some time for larger DBs, during which your D1 will be unavailable to serve queries", and an un-polled export auto-cancels | Cloudflare API reference — D1 database export |
| R2 objects are writable through the Cloudflare REST API with an API token: `PUT /accounts/{account_id}/r2/buckets/{bucket}/objects/{key}` (returns `etag`, `size`, `version`); list and delete equivalents exist | Cloudflare API reference — R2 bucket objects |
| The production Worker already runs a scheduled cron (`17 3 * * *` — AI-usage retention sweep, #353) | `backend/cloudflare.config.ts` `triggers.scheduled` |
| GitHub scheduled workflows already run in this repo: `smoke.yml` (every 6h, auto-opens/closes `smoke-failure` issues) and `audit.yml` (daily 07:00 UTC, same ticket pattern) | `.github/workflows/smoke.yml`, `.github/workflows/audit.yml` |
| Production R2 access exists: private bucket `rumaq-receipts` with `RECEIPTS`/`DOCUMENTS` bindings sharing the bucket under dedicated key prefixes ("no new infrastructure" precedent), plus a separate `rumaq-brochures` bucket for a different retention law | `backend/cloudflare.config.ts` (#388 vault, #293 brochures) |
| Deploys run `cf d1 list / d1 create / d1 migrations apply` (D1 Edit) and `cf r2 buckets list / create` (R2 Edit) with `CLOUDFLARE_API_TOKEN` — in GitHub Actions *and* locally | `scripts/deploy.sh` (`setup_database_remote`, `ensure_r2_bucket`), `.github/workflows/deploy.yml` |
| Local restore-drill engine precedent: the migration chain is exercised against real SQLite (`node:sqlite`) because "D1 is SQLite" | `backend/src/__tests__/migrations.test.ts` |

---

## 3. Credential inventory (what exists vs what would be needed)

Everything below is **names only** — no secret values were read (no `.env`,
no `/etc/rumaq/scraper.env`).

**Already stored, usable today:**

| Credential | Where | Proven permissions | Backup-relevant? |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | GitHub secret, ahaqqu/RumaQ (`deploy.yml` ci + deploy jobs) | D1 Edit (`d1 list/create/migrations apply`), R2 Edit (`r2 buckets list/create`), Workers Edit + Secrets Edit (`cf deploy`, `workers secrets update`) | **Yes — export needs D1 Edit; upload needs R2 Edit. Expected sufficient as-is.** |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub secret, ahaqqu/RumaQ | — | Yes (API path prefix) |
| `CLOUDFLARE_DATABASE_ID` | GitHub secret, ahaqqu/RumaQ | — | Yes (export target UUID) |

**Other credentials checked and NOT backup-relevant / not present:**

- RumaQ-pipeline repo (deploys the VPS scraper): `vars.VPS_HOST`,
  `vars.VPS_USER`, secret `VPS_DEPLOY_SSH_KEY` — nothing Cloudflare/R2.
- VPS box (`rumaq-vps`, env template names only): `GEMINI_API_KEY`,
  `RUMAQ_INGEST_URL`, `RUMAQ_INGEST_SECRET` — **no Cloudflare or R2
  credentials on the box**, and the scraper is the wrong place for backups
  anyway (it never talks to D1).
- Worker secrets (`GOOGLE_CLIENT_ID/SECRET`, `WORKER_JWT_SECRET`,
  `WORKER_ENCRYPTION_KEY`, optional `HAQITA_INGEST_SECRET`) — none usable.
- No R2 S3-compatible API credentials (`R2_ACCESS_KEY_ID` /
  `R2_SECRET_ACCESS_KEY`) exist anywhere — an S3-CLI approach would need two
  new secrets; the REST path needs none.
- No dedicated backup token exists.

**Conclusion:** the automated path needs **no new secret** — the same trio
already shipping in `deploy.yml` covers export (D1) and upload (R2). The one
unverifiable-from-repo unknown is the token's exact grant set (a token can
hold D1 + R2 Edit because deploy.sh uses both; but its scope list is not
visible here). Therefore the workflow is **fail-loud**: if a grant is missing,
the first run fails with a GitHub issue that names the missing permission
(§6, §8), and §9 has the minimal owner action list.

---

## 4. Chosen architecture — and the rejected alternatives

**Chosen: GitHub Actions scheduled workflow → D1 export REST API → upload
into the existing private bucket under a dedicated `backups/` prefix.**

- `.github/workflows/backup.yml`, cron `7 20 * * *` (03:07 WIB daily),
  plus `workflow_dispatch` for manual runs/drills.
- The same repo already trusts GitHub Actions with these secrets for
  production deploys (twice daily at minimum via pushes), so a scheduled job
  does not widen the trust boundary.
- Reuses two proven patterns: scheduled workflow (`audit.yml`/`smoke.yml`)
  and issue auto-open/close on failure (`smoke.yml`).

**Rejected alternatives:**

1. **Worker cron (like the 3:17 UTC retention sweep).** The Worker would have
   to call the account-level export API, which requires putting an
   account-wide `CLOUDFLARE_API_TOKEN` (D1 Edit + R2 Edit) into Worker
   secrets — a secret nobody has stored today, in the runtime most exposed to
   request handling. Blast radius strictly worse than CI; rejected.
2. **VPS cron (rumaq-vps).** The box holds no Cloudflare/R2 credentials, and
   `docs/DEPLOY.md` (vps repo) deliberately bounds the `rumaq-deploy` identity
   to scraper deploys. Adding a token there means widening a reviewed host
   contract; rejected.
3. **Rely on Time Travel alone.** It is real (30-day window on Paid / 7-day on
   Free) and is the *first* restore lever for recent accidents (§7, Scenario
   A), but: the window rolls forward silently — a corruption noticed on day 31
   is unrecoverable; restore is in-place/destructive via Wrangler only (no
   file to verify); and Cloudflare's own docs direct long-term retention to
   exports. So: dumps are **not redundant**, they are the >window layer and
   the only dump that can be *tested* end-to-end.
4. **Separate `rumaq-backups` bucket.** Cleaner blast radius, but it is new
   infra the deploy path must create/manage. The vault already established the
   shared-bucket-dedicated-prefix precedent (`DOCUMENTS` on the receipts
   bucket, `documents/` prefix, "no new infrastructure"). Backups follow it:
   `rumaq-receipts` + `backups/` prefix, Worker bindings never touch it
   (§9). Revisit if the vault ever grows to real scale.

---

## 5. Export mechanics and target

- **Endpoint:** `POST /accounts/{account_id}/d1/database/{database_id}/export`
  with `output_format: "polling"`, `dump_options.compatibility: "d1"` (default:
  importable back into D1 — *not* `sqlite3_cli_only`, which cannot be
  re-imported).
- **Poll loop:** repeat the POST with `current_bookmark` until
  `result.status == "complete"` (bounded: 60 attempts × 10 s). An un-polled
  export auto-cancels by design, so the bounded poll *is* the cancel safety.
- **Availability caveat:** export can block queries on the DB while running.
  For this DB (personal-scale) it is seconds; the workflow logs
  `GET /accounts/{account_id}/d1/database/{database_id}` size each run so
  growth that makes daily exports disruptive becomes visible (and §6 schedule
  can drop to weekly).
- **Download:** fetch `signed_url` (valid one hour) — immediately, inside the
  same run. The dump is **never** uploaded as a GitHub Actions artifact and
  never printed (§9 invariants).
- **Upload:** `PUT /accounts/{account_id}/r2/buckets/{bucket}/objects/{key}`
  into the private bucket `rumaq-receipts` (`R2_BUCKET_NAME`, default) —
  **not** the brochures bucket.
- **Keyspace:** `backups/<db>/YYYY-MM-DD/dump.sql`, where `<db>` is
  `D1_DATABASE_NAME` (default `rumaq`). Example:
  `backups/rumaq/2026-11-04/dump.sql`.
- **Implementation:** `scripts/backup/export-d1.sh` (bash + curl + jq; no
  project deps), reusable locally by the owner (`workflow_dispatch` or
  run with the env trio).

---

## 6. Schedule and retention

**Schedule: daily `7 20 * * *` UTC = 03:07 WIB.** Rationale:

- WIB-morning alignment: captures the full previous day of writes (Indonesian
  evening usage peak) *before* the next usage day starts — RPO ≤ 24 h, layered
  on top of Time Travel's minute-level PITR for anything recent.
- Off-peak WIB night; avoids collision with `smoke.yml` (tops of 00/06/12/18
  UTC), the Worker cron (03:17 UTC), and `audit.yml` (07:00 UTC).
- Seven-minute past the hour dodges top-of-hour runner congestion.

**Retention: 14 daily + 4 weekly (Sundays), enforced by the export script
after each successful upload:**

- List objects under `backups/<db>/` (paginated `per_page=1000`).
- Parse the date from each key; **Sundays are weekly slots** — keep the newest
  4; non-Sundays are daily slots — keep the newest 14.
- Everything else is deleted (`DELETE /accounts/{account_id}/r2/buckets/{bucket}/objects/{key}`).
- **Deletion is skipped entirely when the export/upload failed** — a failed
  backup never deletes the previous ones. Worst case the retention drifts up
  by a few objects and self-corrects on the next green run.
- At steady state: 18 objects ≈ 18 days of history (a corruption discovered
  on day 19+ is beyond both PITR and dumps — accepted; weekly-cadence
  restore *drills*, not longer retention, are the guard against silent
  restore-rot, §8).

---

## 7. Restore runbook (the hard acceptance)

Two levers, ordered by speed. **WHO:** the owner (root credential holder —
both need `CLOUDFLARE_API_TOKEN` with D1 Edit; no automation performs a
production restore).

### Scenario A — recent accident (within the Time Travel window: 30 d Paid / 7 d Free)

1. Stop writes: the app is small enough that a brief window is fine; announce
   in the incident issue.
2. Pick the restore point:
   `node node_modules/cf/bin/cf d1 time-travel info rumaq`
   (or with `--timestamp`).
3. Restore (in-place, destructive; in-flight queries error out):
   `node node_modules/cf/bin/cf d1 time-travel restore rumaq --bookmark=<bookmark>`
   — per current docs this is `wrangler d1 time-travel restore` (the repo's
   `cf` CLI mirrors wrangler's d1 surface; verify the subcommand exists with
   `cf d1 time-travel --help` during the first drill).
4. **Verify (the same acceptance as the drill):** hit
   `https://rumaq.ahaqqu.com/api/health`, log in, check a household's stock
   rows match the expected pre-incident state; run the drill script against
   a fresh export (`scripts/backup/restore-drill.sh`, §8) to prove the
   restored DB still round-trips.
5. Undo is possible: a restore returns a bookmark for the pre-restore state
   (docs), so restoring to the prior bookmark reverts a bad restore.

### Scenario B — corruption/disaster older than the Time Travel window (dump restore)

1. **Fetch the dump.** Locate the newest good dump in R2
   (`backups/rumaq/<date>/dump.sql`) — Dashboard → R2 → `rumaq-receipts`, or
   an API `GET .../objects/<key>` with the owner token. Download locally.
2. **Verify offline BEFORE touching production** (the tested path):
   `./scripts/backup/restore-drill.sh <dump.sql>` — restores the dump into a
   local SQLite (node:sqlite — D1 is SQLite), runs `PRAGMA integrity_check`
   and `PRAGMA foreign_key_check`, prints per-table row counts, and asserts
   the canary expectations (§8). **Do not proceed if this fails; try the next
   older dump.**
3. **Create a fresh database** (never import over the corrupted one):
   `node node_modules/cf/bin/cf d1 create --name rumaq-restore-<date>`.
4. **Import the dump:** D1 import REST API
   (`POST /accounts/{account_id}/d1/database/<new-db-id>/import` — same
   polling contract as export) or `cf d1 import` if available in the CLI's
   current version.
5. **Verify on the new DB:** run the drill's row-count spot checks against
   `rumaq-restore-<date>` (via `cf d1 execute --remote --command`), then a
   branch-preview Worker pointed at the new DB id (`BRANCH_NAME=drill
   ./scripts/deploy.sh cloudflare` with `CLOUDFLARE_DATABASE_ID` overridden)
   and log in end-to-end.
6. **Cutover:** update the `CLOUDFLARE_DATABASE_ID` GitHub secret to the new
   database UUID, redeploy main (`./scripts/deploy.sh cloudflare` or the
   deploy workflow's manual run), verify `GET /api/health` and a login.
7. **Close out:** delete `rumaq-restore` scratch resources; note the incident
   in the issue; the old corrupted DB is deleted last, after the observation
   window.

**WHAT verifies success, in one line:** the drill script exits 0 with
`integrity_check: ok`, zero `foreign_key_check` violations, and row counts
matching the canary table (users, households, household_members, stock,
purchases, documents) — then production cutover verifies `api/health` + login.

---

## 8. Restore drill (the tested tooling) and monitoring

**Drill tooling (implemented in this PR, no secrets needed):**

- `scripts/backup/verify-dump.mjs` — core module + CLI:
  `node scripts/backup/verify-dump.mjs <dump.sql> [--expect table=count ...]`.
  Restores the dump into a scratch SQLite (node:sqlite), then verifies:
  dump fully executed (transactional wrapper handled; a mid-statement
  truncation fails loudly), `PRAGMA integrity_check` = `ok`, zero
  `foreign_key_check` rows, and row counts per table — asserted against
  `--expect` when given, always printed otherwise. Exit 1 on any failure.
- `scripts/backup/restore-drill.sh` — the human entrypoint
  (mode=755, `.gitattributes`): wraps `verify-dump.mjs` with the default
  canary expectations and a readable verdict. Monthly cadence: the owner runs
  it against the newest R2 dump; the PR documentation puts it on the ops
  checklist.
- Tests: `backend/src/__tests__/d1-restore.test.ts` builds a dump from the
  **real migration chain** (synthetic canary rows — no real PII, the same
  node:sqlite pattern as `migrations.test.ts`), restores it via the module,
  and asserts counts/integrity; plus a static edge-case fixture and the
  failure modes (truncated dump → non-zero; expectation mismatch → non-zero).
  Runs under `./scripts/test.sh unit backend`.

**Backup-success visibility (implemented):** `.github/workflows/backup.yml`
reuses the `smoke.yml` pattern verbatim, with its own `backup-failure` label:

- run fails → issue `D1 backup failure — <date>` (deduped by title), body
  links the failed run and names the likely cause (missing token grant,
  export timeout, R2 upload rejection).
- run succeeds → open `backup-failure` issues are closed with a comment.
- Each green run logs the DB **size** (`file_size`) and the uploaded object
  key — the freshness/size trail lives in workflow history, searchable, no
  new dashboard needed.

Known residual risk, accepted: GitHub disables schedules after 60 repo-idle
days; `smoke.yml` (6-hourly) keeps the repo active, and the drill's monthly
cadence is the human backstop.

---

## 9. Security invariants and the secret boundary

1. **Backups are PII-bearing** (users, households, documents metadata,
   purchase history). The dump lives only in the private `rumaq-receipts`
   bucket — same bucket the vault already treats as private, but a keyspace
   the Worker never reads: `RECEIPTS`/`DOCUMENTS` bindings are reached only
   through `lib/storage.ts` prefixes (`documents/`, receipt keys); no route
   can address `backups/`. No `r2.dev` public access on the bucket; none
   added.
2. **No dump leaves the Cloudflare perimeter except through the owner's
   authenticated drill.** The workflow downloads the dump from the one-hour
   signed URL straight into the upload step — never to Actions artifacts,
   never into logs (`::add-mask` not needed; nothing is echoed), never to the
   VPS.
3. **Retention is bounded** (14 + 4) — copies of PII are pruned on a fixed
   policy, enforced by the script, skipped on failed backups.
4. **Restore drills gate production cutover** — a dump that has not passed
   the drill may not be imported into production (runbook step 2 is a hard
   gate).
5. **Least privilege today:** the job reuses `CLOUDFLARE_API_TOKEN`, whose
   D1+R2 Edit grants are already exercised by every deploy. **If a run
   fails on a missing grant**, the minimal owner action (no agent can do
   these — the tokens are owner-held):

   ```sh
   # Option A (zero new secrets): rotate the deploy token's grant set to
   # explicitly include D1 Edit + R2 Edit (if the current token predates
   # either), then re-run: Actions > D1 backup > Run workflow.

   # Option B (scoped backup token, if isolation is preferred):
   #   dash.cloudflare.com → My Profile → API Tokens → Create Token
   #   permissions: D1 Edit + Workers R2 Storage Edit (account-scoped)
   #   then, in ahaqqu/RumaQ: gh secret set BACKUP_CLOUDFLARE_API_TOKEN
   #   and add R2_BUCKET_NAME as an Actions variable if the bucket is renamed.
   #   backup.yml prefers BACKUP_CLOUDFLARE_API_TOKEN when present.
   ```

   The workflow gates on the trio being present (fail-loud `::error`,
   mirroring the RumaQ-pipeline `deploy-vps.yml` vars-gating precedent) —
   with the secrets already in place it runs from the first merge; if the
   token grant is incomplete, it fails *into a ticket* instead of silently
   skipping.

---

## 10. Cost

≈ **$0**. 18 objects retained; a personal-scale dump is expected well under
100 MB (first green run logs the real size — if it ever approaches the 10 GB
free tier, §6 cadence drops to weekly first). ~3 Class A API calls + ~2
Class B per day (export POST-polls, PUT, list, occasional delete); the export
poll loop is minutes of wall clock on a runner that already exists. No Worker
CPU, no VPS, no new bucket.

---

## 11. What activates now vs after owner actions

| Piece | State at merge |
| --- | --- |
| Restore drill (`verify-dump.mjs`, `restore-drill.sh`) + tests | **Live** — runs today on any dump file, zero secrets |
| `backup.yml` schedule, export/prune/alerting scripts | **Live** — the trio (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DATABASE_ID`) already exists as repo secrets; first scheduled run is the proof |
| If the stored token's grants are incomplete | First run fails → `backup-failure` issue → owner applies Option A or B from §9 → next run goes green (workflow already prefers `BACKUP_CLOUDFLARE_API_TOKEN` if Option B is chosen) |
| Monthly drill cadence | Owner checklist (§8) — documented, not automatable without a live restore target |
| Optional R2 lifecycle backstop on `backups/` (30-day expire) | Owner one-liner in the dashboard; script pruning already enforces the policy |

---

## 12. Query-performance monitoring (residual note)

The third Phase-11 item stays design-only here (no route/runtime changes in
this PR): D1's dashboard exposes query insights and per-database metrics, and
the nightly export run now logs `file_size` — the first cheap signal. Next
increment, if warranted: an owner-only `/api/admin/db-stats` (phase-11 §6)
plus a monthly `cf d1 insights` review item on the ops checklist.

---

## 13. Test plan (this PR)

- `./scripts/test.sh unit backend` — new `d1-restore.test.ts`: dynamic
  real-migration-chain dump → restore → integrity + row-count assertions;
  static fixture (dump-format wrapper edge cases); failure modes
  (truncated dump, wrong `--expect`).
- `./scripts/github/ci.sh` clean before PR (style, docs, codegen, coverage,
  audit, build, bundle budget, Worker-config dry-run).
- No automation suites touched; no new API surface → no new
  `automation/` scenarios required by `docs/TEST_STRATEGY.md`.
