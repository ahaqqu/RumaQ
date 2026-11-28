# RumaQ v2 — Phase 2 design addendum

> Parent: [#763](https://github.com/ahaqqu/RumaQ/issues/763) (Phase 2 — fresh platform core) · Plan: [v2-ground-up-plan.md](v2-ground-up-plan.md) · Design: [v2-design.md](v2-design.md) · Program state: [v2-program-state.md](v2-program-state.md)
>
> **Status: confirmed by the owner on 2026-11-28.** The addendum was [posted for review on #763](https://github.com/ahaqqu/RumaQ/issues/763#issuecomment-7238118165) and confirmed by the owner the same day. It governs Phase 2 wherever it differs from the plan or the design.

This reconciles a product pass and an architecture pass, each written after the two read-only research passes. §1 and §9 record the owner's decisions, §10 the deviations from the written plan that they cover, §11 the decisions taken after the host research, the owner actions and what is still open, and §12 the slice issues and waves.

## 1. Already decided by the owner (2026-11-28)

| #   | Decision                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The first contract work is the domain vocabulary only. The pipeline-facing wire contract is cut once, after R9 and before Phase 4.                                                                                                                      |
| D2  | v2 lives in a new top-level `server/` (final name). `web/` arrives in Phase 3. Legacy `backend/` and `frontend/` stay frozen until Phase 10.                                                                                                            |
| D2b | Contract location **C**: legacy `contract/` is untouched. The kernel starts as a pure TypeScript + Valibot subtree of `server/`, behind a purity test, and is promoted to a package at the wire-contract cut.                                           |
| G1  | Test gate **`./scripts/test.sh unit server`**: a real PostgreSQL 17 with pgvector and pg_trgm, connected as the real `rumaq_app` and `rumaq_migrator` roles. It fails rather than skips without a database, and it runs inside the required `ci` check. |
| G2  | Capacity gate: a **bounded synthetic-load baseline on the host in Phase 2**. The combined API + worker + PostgreSQL + pipeline + resident-apps stress test moves to Phases 6–7, where the plan already repeats it.                                      |
| G3  | Backup scope: a **nightly encrypted dump and an isolated restore drill in Phase 2**; WAL archiving is a separate decision before Phase 6. No cluster-wide PostgreSQL change in Phase 2 (§11).                                                           |
| —   | Session autonomy: work; hold every merge and deploy for approval.                                                                                                                                                                                       |

## 2. Topology (`server/`)

- **Package.** `@rumaq/server`, private, exact pins, three entrypoints that each validate their own environment: `web-api`, `worker`, `migrate`. A unit handed a variable it must not have fails at boot. Delete-capable storage code is not in the `web-api` bundle at all (asserted by a test).
- **Install topology (decided, §9.2).** `server/` is a standalone Bun package with its own `bun.lock`; the root `workspaces` list does not change. A v2 dependency, or its Dependabot bump, can then never re-resolve or redeploy the frozen v1 Worker. A root `postinstall` keeps `bun install` at the repository root installing everything. R2 is the gate: if `vp check` cannot type-check a nested package after one bounded attempt, `server/` becomes a root workspace member instead and nothing else changes.
- **Layout.** `src/contract` (vocabulary kernel; imports `valibot` only) · `src/domain` (pure) · `src/platform` (`db`, `storage`, `config`, `http`, `log`) · `src/core/<feature>` (each feature owns its tables and all of its SQL; `index.ts` is its only importable surface) · `src/modules/<audience>` (`public`, `account`, `household`, `admin`, `internal`, `worker`: routes only, no tables) · `src/entrypoints`. Migrations in `server/migrations/`, OpenAPI documents in `server/openapi/`.
- **Layering, enforced.** `entrypoints → modules → core → platform → domain → contract`, one direction. Pinned on top: SQL only in `core/*/repository.ts` and `platform/db`; the S3 SDK only in `platform/storage`; object deletion only in a retention module that only `worker` imports; `Bun.env` only in `platform/config`; nothing under `server/` imports `backend/`, `frontend/` or legacy `contract/`. The enforcement is `server/src/architecture.test.ts` on the pattern of `backend/src/__tests__/ai-boundary.test.ts`: it proves every rule fires on synthetic sources, so a deaf checker fails the suite.
- **Building blocks.** postgres.js **3.4.9** (the four-week-old v4 rewrote the pool and carries a Bun DNS hang in v4-only code) · `Bun.randomUUIDv7()` behind one `newId()` (`crypto.randomUUID({ version: 7 })` silently returns v4 on Bun 1.4.0, so it is banned) · `@aws-sdk/client-s3` · `openid-client` behind a provider port, after the spike · `hono/csrf`, `hono/secure-headers` · a zero-dependency JSON logger on stdout · `/healthz` and `/readyz`, the latter also asserting the database's privilege shape and migration head · graceful `SIGTERM`, bounded pool.
- **Test database.** `server/compose.yaml` pins the test database image `pgvector/pgvector:0.8.0-pg17-trixie` — by tag, no digest. It is deliberately not `0.8.7-pg17-bookworm`: this image runs the same pgvector minor and the same Debian line as the host, so CI tests what production runs. `vector` is not a trusted extension, neither there nor on the host, so only a superuser creates it — the test admin URL in CI, the one-time `ahaqqu/vps` bootstrap on the host. `pg_trgm` is trusted.
- **OpenAPI.** Generated inside `server/` with hono-openapi into two committed, drift-checked documents (`web-api.json`, `internal.json`), through `scripts/docs.sh`. Wired in R2 with a health-only app. The v1 generator, `frontend/openapi.json`, `sdk.gen.ts` and `docs/API.md` are not touched.

## 3. Slices

| Slice                                | Purpose                                                                                                                                                                                                                                 | Touches                                                                                                                         | v1 Worker deploy | Needs from `ahaqqu/vps`                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------ |
| **R1** scope rule                    | `server/**` becomes a known path: it runs the v2 suite, skips v1-only suites, and never deploys the v1 Worker. Anything else behaves as today.                                                                                          | `scripts/github/{needs-deploy,unit-test-scope,reaches}.sh`, `skippable-paths.txt`, five guard tests, a new `deploy-scope` guard | yes, once        | none                                                   |
| **R2** `server/` + real-PG gate      | v2's home; `unit server` means something from day one; health-only entrypoints; architecture test; OpenAPI wiring.                                                                                                                      | `server/**`, CI/test scripts, workflows, `.dockerignore`, root `postinstall`                                                    | yes, once        | none                                                   |
| **R3** vocabulary kernel             | The truth contract as code the owner reads in one sitting: run, campaign-revision, offer-version and publication state machines, source modes, price bases, disposition codes, each with a positive and a negative test per transition. | `server/src/contract/**`                                                                                                        | no               | none                                                   |
| **R4a** runner, roles, enums         | Migration runner inside the artifact, first migrations (schemas, enums, `state_transitions`), the enum sync test, the append-only guard.                                                                                                | `server/migrations`, `src/entrypoints/migrate`, `src/platform/db`, `scripts/test/migrations.sh`                                 | no               | V1 opened in parallel                                  |
| **R4b** tenancy core                 | `users`, `auth_identities`, `households`, `household_members` with composite keys, RLS, and the structural tenancy tests.                                                                                                               | `private` schema tables, `platform/db` tenant helper, `schema-shape.test.ts`                                                    | no               | none                                                   |
| **R5** identity + sessions           | Opaque hashed sessions, `(issuer, subject)` identity, expiry, revocation, server-resolved roles, Origin/CSRF. The session spine first; the OIDC adapter is its own PR after the spike.                                                  | `private.sessions`, `core/accounts`, `modules/account`                                                                          | no               | none; the real sign-in run needs a staging OIDC client |
| **R6** evidence storage              | Content-addressed storage with public and private namespaces, no overwrite, verify-then-record, pin-aware retention.                                                                                                                    | `evidence_assets`, `evidence_pins`, `platform/storage`, `core/evidence`                                                         | no               | none; one owner-gated check against the real bucket    |
| **R7** runs, ingest, outbox          | Durable, replayable ingest; leased at-least-once delivery with exactly-once effects; crash-point tests.                                                                                                                                 | `pipeline_runs`, `run_events`, `ingest_requests`, `outbox_*`, `core/{runs,ingest}`, `modules/{internal,worker}`                 | no               | none                                                   |
| **R8** source registry + publication | Store what may be published, who approved it, and what is current — without publishing anything.                                                                                                                                        | `sources`, `campaigns`, `offers`, `publication`, `review`, `audit` tables and modules                                           | no               | none                                                   |
| **R9** public read repositories      | One query decides what is publicly current; history and as-of; the full case matrix.                                                                                                                                                    | `core/publication` queries                                                                                                      | no               | none                                                   |
| **R10** v2 deploy entrypoint         | One way to ship v2 to the host through `scripts/deploy.sh`, manual-only in Phase 2.                                                                                                                                                     | `scripts/deploy.sh`, `scripts/deploy/server-vps.sh`, a dispatch-only job                                                        | yes, once        | V4                                                     |
| **Wire-contract cut**                | Promote the kernel to a package and freeze the tested internal schemas with fixtures. The first item after Phase 2 exit.                                                                                                                | `server/src/contract`                                                                                                           | no               | none                                                   |
| **V1–V5** (`ahaqqu/vps`)             | Database and roles · three units with ceilings · nginx routing and trusted client IP · deploy contract with rollback · backup and isolated restore.                                                                                     | `ahaqqu/vps` only                                                                                                               | never            | —                                                      |

Order: R1 → R2 → R3 → R4a → R4b → R5 and R6 (either order) → R7 → R8 → R9 → R10. V1, V2, V4 and R10 start right after R2 so the deploy path is proven with a health-only artifact. A merge to `ahaqqu/vps` `main` is a host change within 15 minutes, so there is never more than one vps pull request per approval.

## 4. Data model — the three calls, and the rules around them

**Decided (§9.1).** Each call is stated with its visible consequence; the owner confirmed all three and accepted the consequence.

1. **`source_tiles` is a table.** A tile has a lifecycle (detected, extracted, then accepted, human-rejected or a visible blocker), the page manifest is immutable, and "every printed priced tile is accounted" becomes a constraint instead of a convention. The exact ingest document survives as the immutable `campaign_revisions.manifest`.
2. **`published_current` is a pointer table** whose primary key is `offer_id`. The manager first argued for a partial unique index on `publication_items`; the architecture pass showed that would put liveness on the receipt row and make the publication ledger mutable. With the pointer, the ledger stays append-only and "one live version per offer" is a primary key. Consequence: a failed refresh never replaces the last valid revision — a refresh is a new revision with new tiles and publishes only through an approved batch.
3. **`offers` are keyed by source lineage `(source_tile_id, source_line)`, not by product.** The manager first proposed (store, product, campaign); the architecture pass showed that key contains a reviewable fact — identity — and a corrected identity would have to move versions between offers. **Visible consequence: the same product at the same store in two overlapping campaigns is two offers, two cards and two validity windows, each tied to its own brochure. The product page shows both and never picks one.** Price history is a projection over accepted versions keyed by (product, store, region, price basis, conditions).

Rules that make the truth contract structural (design §2.1):

- Exactly one `accepted` version per offer, by partial unique index; accepting a correction supersedes the old version in the same transaction. Between accepting a correction and publishing it, the offer is not public: fail closed rather than show a price a reviewer has just called wrong.
- A version cannot become `accepted` without a bounded validity window, at least one price row, one region row and one evidence row for a verified asset.
- Price bases are relational rows (`member` and `shelf` stay separate evidenced bases). Region scope is explicit rows per version.
- Validity is a `daterange` of retailer-local dates; an accepted version cannot be open-ended. The next transition is the next `Asia/Jakarta` midnight, computed from tzdata, never a fixed offset.
- Identity is keyed on `(issuer, subject)`; email is display-only.
- Publication is one transaction per approved batch: lock the batch, assert every version is acceptable and its revision complete and its source public, write the ledger rows, move the pointers, write the events and the outbox event together.
- RLS on every tenant-scoped table with composite household keys (foreign-key checks bypass row security, so a single-column parent key would accept another household's parent). The app role is not superuser, cannot bypass RLS, owns no table. Tenant context is set per transaction, so a pooled connection cannot leak it.
- `version` on every mutable root, bumped by trigger; append-only tables are protected by grants and a trigger, and a catalog test keeps all of this true for future tables.
- The kernel is the reviewed statement; PostgreSQL stores and enforces it. A test asserts set equality between every kernel vocabulary and its PostgreSQL enum, in both directions.

**Not created in Phase 2:** extraction, identity-candidate, taxonomy, prompt/model, cost and review-time tables (Phase 5, C2-gated); `user_settings` (Phase 3); watchlist, list and plugin tables (Phase 8).

## 5. The plan's six gates

| Gate                                                                                 | Slices         | Proof of record                                                      |
| ------------------------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------- |
| Real PostgreSQL, not a mock                                                          | R2, R4–R9      | `unit server` on real PostgreSQL inside `ci`, run from merged `main` |
| Replay, same-key/different-body 409, in-flight retry, crash after an external effect | R7             | Real-PostgreSQL tests with fault injection                           |
| Cross-household composite-FK/RLS/IDOR; app role cannot bypass RLS                    | R4b, R5        | Tests connected as `rumaq_app`, asserting SQLSTATE codes             |
| Host resource envelope                                                               | V2, V3, R2, R9 | Bounded baseline report (G2); combined stress in Phases 6–7          |
| Fresh backup restores in isolation; reads and evidence hashes verify                 | V5, R6, R9     | Restore drill report                                                 |
| Previous artifact rollback rehearsed                                                 | V4, R10        | Rehearsal: N → N+1 → N, which also proves the migration rule         |

## 6. Phase 2 exit

Close #763 only with: every slice merged with the owner's approval or deferred in writing; one exit-evidence comment on #763 with a run URL or drill report per gate, produced from merged `main`; the acceptance boxes ticked with links; docs current; **v1 re-proven** (`git diff --stat 650d598..main -- backend frontend contract` empty, `rumaq-v1.ahaqqu.com/api/health` 200, canonical host unchanged); and a clean owner inbox. The owner signs a **Phase 2 Exit** review — the six gate rows, every as-built deviation from this addendum, the deferred list, the wire-contract cut plan, and the merge/deploy posture for Phase 3. It is not a new C-gate: nothing user-visible or irreversible is approved here. The wire-contract cut gets its issue at Phase 2 exit.

## 7. v1 safety contract

- **Off-limits for the whole phase:** `backend/**`, `frontend/**`, `contract/**`, `frontend/openapi.json`, `frontend/src/lib/api-client/**`, `docs/API.md`.
- **Merges that redeploy v1, and why each is boring:** R1, R2 and R10 each once (CI plumbing, the workspace bootstrap, a new deploy target); any later change to `scripts/**` or root files. A `server/**`-only merge does not deploy v1. A mixed pull request runs both suites and deploys v1.
- **Deploy inputs frozen:** the Cloudflare GitHub secrets and the Worker's managed secrets do not change. **Dependency updates during the freeze:** Dependabot auto-merges patch-level and security updates; minor and major bumps of the frozen v1 wait for the owner's approval (§11). **Action T is closed** (§9.4): the prepared `rumaq-v2` D1 is unused; deleting that empty database is a separate, later decision (Phase 10).
- **No DNS change for either RumaQ hostname, no new Worker, new bucket names, tokens scoped to the v2 buckets.** Legacy D1 `rumaq` and `rumaq-v2` are neither read nor deleted before Phase 10. The v2 API gets one new, DNS-only name in Phase 2 (§11).
- **After every v1 deploy of the phase:** check both health URLs at once, run the smoke workflow, post the links on #763. Record a ref for every approved v1 deploy; a bad one is reverted through a pull request or by dispatching the deploy workflow on that ref, or immediately through the Worker's own rollback: Cloudflare dashboard → Workers & Pages → the Worker → Deployments → Rollback (CLI equivalent `wrangler rollback`; the repository's deploy CLI (`cf`) has no Workers rollback command). A rollback restores code only and leaves bindings untouched. No Phase 2 merge adds a D1 migration, so a code rollback is lossless.
- **Adjacent invariants:** the scraper timer stays disabled after every vps apply; the v2 session cookie has a different name from v1's `rumaq_session`; no provider key and no provider-client dependency in any Phase 2 slice.

## 8. Held-merge sequencing

One stack per repository: slice N+1 branches from N and targets N's branch, so each pull request shows only its own diff. At most three held pull requests per repository (one awaiting approval, one in review, one in progress). The stack is rebased whenever `main` moves. Each approval request names the head SHA and its effect: "no v1 deploy", "v1 deploy, boring", or "vps: host change within 15 minutes". R1 and R2 are approved as a pair and merged back to back.

## 9. Decisions (owner, 2026-11-28)

Every decision in this addendum is the owner's, taken on 2026-11-28, except the test database image (§2), a refinement decided by the manager. The first four were requested by the review copy of this addendum and confirmed the same day; each keeps the reason it was asked and ends with its outcome. The rest were decided the same day and are stated in §1 and §11.

1. **The three data-model calls and the rules of §4** — they had to be settled before any migration is written, so they gated R4a. **Confirmed:** `source_tiles` is a table; `published_current` is a pointer table whose primary key is `offer_id`; `offers` are keyed by source lineage `(source_tile_id, source_line)`. The visible consequence is accepted: the same product at the same store in two overlapping campaigns is two offers and two cards, and the product page shows both.
2. **Install topology** — it stood against the word "workspace" in D2 and the one-lockfile convention, and it shapes R1 and R2. **Confirmed:** `server/` is a standalone Bun package with its own `bun.lock`; the root `workspaces` list does not change (§2). R2 is the gate, with the root-workspace-member fallback.
3. **Migration runner and how it runs** — two deviations from the written plan, which gate R4a and vps V2. **Confirmed, both:**
   - a migration runner of about 120 lines inside the server artifact instead of a library, because no light runner verifies checksums of applied migrations and dbmate would add a second binary supply channel to the host;
   - a third systemd unit, `rumaq-migrate` (one-shot), with its own OS user and env file, which both app units require and order after. The schema-change password is then unreadable by the Internet-facing process, and ordering is systemd's rather than a convention.
   - One rule follows from the second and is the manager's (2026-11-28, from the host deploy research): a rolled-back artifact meets a ledger ahead of it, because a rollback restarts the app units on the previous tree and never the database. The runner therefore accepts applied migrations above its own head with a warning, and refuses only a checksum mismatch or a gap inside its own range. R4a's plan carries it; the N → N+1 → N rehearsal proves it.
4. **Action T** — close it now, or keep it on hold until Phase 2 exit. **Closed.** The prepared `rumaq-v2` D1 is recorded as unused; deleting that empty database is a separate, later decision (Phase 10) (§7).

Decided earlier the same day (§1): D1, the domain vocabulary first and the wire contract cut once before Phase 4; D2 and D2b, `server/` as v2's home with legacy `contract/` untouched (contract location C); G1, `./scripts/test.sh unit server` as the PostgreSQL gate; G2, a bounded capacity baseline in Phase 2 with the combined stress in Phases 6–7. Four further decisions, taken after the host research, are recorded in §11. The slice issues and waves that follow from these decisions are in §12.

## 10. Deviations from the written plan, all covered above

`unit backend` → `unit server` (decided) · capacity gate split (decided) · contract major first → kernel first, cut once later (decided) · standalone lockfile (§9.2) · custom migration runner and a third unit (§9.3) · v2 OpenAPI generated from R2 rather than at the first real routes · V1, V2, V4 and R10 brought forward instead of the plan's tail-heavy order · database bootstrap owned by `ahaqqu/vps` and run once by the owner, because the pgvector extension is not trusted and the applier cannot run SQL · the test database comes from `server/compose.yaml`, not the v1 compose stack · WAL archiving is not in Phase 2: the owner decided a nightly dump and an isolated restore drill now, and WAL archiving as a separate decision before Phase 6 (§11).

## 11. After the host research: decisions, owner actions, and what is still open

Decided after the host research (owner, 2026-11-28) — open in the review copy:

- **Backup scope** (`ahaqqu/vps` V5): a nightly encrypted dump and an isolated restore drill in Phase 2. WAL archiving is a separate decision before Phase 6, when scheduled operation gives it a real recovery-point objective. No cluster-wide PostgreSQL change in Phase 2.
- **Database bootstrap** (`ahaqqu/vps` V1): a one-time runbook step — a reviewed, idempotent SQL file in `ahaqqu/vps`, a runbook section and a CI test on a throwaway database — run once by the owner. No applier feature. This is a confirmed deviation from "host config in a manifest row".
- **v2 API hostname for Phase 2** (`ahaqqu/vps` V3): a new DNS-only name (working name `rumaq-v2.ahaqqu.com`; the owner may still rename it before V3's plan). Neither existing RumaQ hostname changes in Phase 2. It is not Cloudflare-proxied in Phase 2, so the real-client-IP rule is not deployed by V3; it is rehearsed before the main-host cutover, which the plan places in Phase 6.
- **Dependabot during the freeze:** auto-merge for patch-level and security updates only; minor and major bumps of the frozen v1 wait for the owner's approval. Its own small workflow PR, [#792](https://github.com/ahaqqu/RumaQ/pull/792), touches only `.github/` and `docs/` — both in the deploy skip set, so merging it does not deploy the v1 Worker (§7). The security half needs the repository secret `DEPENDABOT_ALERT_LOOKUP_TOKEN`; until the owner creates it, the workflow is patch-only (fail-safe).

Still open — do not act unilaterally:

- **v2 buckets and scoped token** — before R6's live check.

Owner actions ahead (not design decisions):

- **The AutQ staging client** — one owner step on the host, before R5's real-provider run.
- **The v2 deploy key and its Actions secret** — before R10, with `ahaqqu/vps` V4.
- **Approving R1 and R2 as a pair** — wave A.
- **The `DEPENDABOT_ALERT_LOOKUP_TOKEN` repository secret** — optional; without it Dependabot is patch-only during the freeze.

Closed since the review copy, by the research:

- **Worker rollback path** — recorded in §7.
- **AutQ client creation and instance** — AutQ, the identity provider, needs no change for R5: RumaQ is a public client of its authorization-code flow. Creating the RumaQ client is one owner step on the host per instance, staging first. Loopback redirect URIs are accepted, so R5's real-provider run needs no v2 hostname. Sessions, revocation, expiry and roles are entirely RumaQ's, and logout is RumaQ-local.
- **`pg_trgm` on the host** — it is installed and trusted; `vector` is installed but not trusted (§2).

## 12. Slices, issues and waves

Every RumaQ slice is a sub-issue of [#763](https://github.com/ahaqqu/RumaQ/issues/763). The `ahaqqu/vps` slices are cited by issue number only: a merge to that repository's `main` is a host change within 15 minutes, so there is never more than one vps pull request per approval (§3).

| Slice                                        | Issue                                              | Wave                                                                                          |
| -------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| R1 — scope rule                              | [#781](https://github.com/ahaqqu/RumaQ/issues/781) | A                                                                                             |
| R2 — `server/` + real-PG gate                | [#782](https://github.com/ahaqqu/RumaQ/issues/782) | A                                                                                             |
| R3 — vocabulary kernel                       | [#783](https://github.com/ahaqqu/RumaQ/issues/783) | B                                                                                             |
| R4a — runner, roles, enums                   | [#784](https://github.com/ahaqqu/RumaQ/issues/784) | B                                                                                             |
| R4b — tenancy core                           | [#785](https://github.com/ahaqqu/RumaQ/issues/785) | B                                                                                             |
| R5 — identity + sessions                     | [#786](https://github.com/ahaqqu/RumaQ/issues/786) | C                                                                                             |
| R6 — evidence storage                        | [#787](https://github.com/ahaqqu/RumaQ/issues/787) | C                                                                                             |
| R7 — runs, ingest, outbox                    | [#788](https://github.com/ahaqqu/RumaQ/issues/788) | D                                                                                             |
| R8 — source registry + publication           | [#789](https://github.com/ahaqqu/RumaQ/issues/789) | D                                                                                             |
| R9 — public read repositories                | [#790](https://github.com/ahaqqu/RumaQ/issues/790) | D                                                                                             |
| R10 — v2 deploy entrypoint                   | [#791](https://github.com/ahaqqu/RumaQ/issues/791) | B: starts when R2 is merged; its rollback rehearsal is repeated after R9 with real migrations |
| Wire-contract cut                            | issue at Phase 2 exit                              | first item after E                                                                            |
| vps V1 — database and roles                  | `ahaqqu/vps` #53                                   | B: starts when R2 is merged                                                                   |
| vps V2 — three units with ceilings           | `ahaqqu/vps` #54                                   | B: follows V1                                                                                 |
| vps V3 — nginx routing and trusted client IP | `ahaqqu/vps` #55                                   | D: after V4                                                                                   |
| vps V4 — deploy contract with rollback       | `ahaqqu/vps` #56                                   | B: starts when R2 is merged, with R10                                                         |
| vps V5 — backup and isolated restore         | `ahaqqu/vps` #57                                   | E: after V4                                                                                   |

- **A** — R1 and R2. Approved as a pair and merged back to back.
- **B** — R3, R4a, R4b. Once R2 is merged, the host side starts so the deploy path is proven early with a health-only artifact (§3): vps V1, then V2, then V4 together with R10.
- **C** — R5 and R6.
- **D** — R7, R8, R9. vps V3 lands once V4 is applied and the v2 hostname and certificate exist.
- **E** — the exit evidence: the rollback rehearsal N → N+1 → N is repeated with real migrations, then vps V5.
