# RumaQ v2 — ground-up implementation plan

> Parent: [#758](https://github.com/ahaqqu/RumaQ/issues/758). Design: [v2-design.md](v2-design.md). Evidence: [pipeline audit](v2-pipeline-audit.md), [Actions audit](v2-actions-audit.md), and [infrastructure evaluation](v2-infrastructure-evaluation.md).
>
> **Status: approved — C0 signed by the owner on 2026-11-28** (docs PR [#759](https://github.com/ahaqqu/RumaQ/pull/759), merged). Program state and the cross-harness resume point: [v2-program-state.md](v2-program-state.md). Gates C1–C6 remain unsigned, so no work outside Phase 2, paid evaluation, workflow disablement, deployment, or live scrape is authorized by this document alone.
>
> **Phase 2 amended 2026-11-28:** the owner-confirmed [design addendum](v2-phase2-design-addendum.md) governs Phase 2 wherever this plan differs from it: topology, data model, slice order, the test and scope gates, held-merge sequencing, backup scope and the v1 safety contract. §6 carries the amended sequence.

## 1. Locked scope

- Replace the whole UI with a promo-first, public-by-default experience.
- New site occupies **`rumaq.ahaqqu.com` immediately when its first shell is released**; legacy moves to **`rumaq-v1.ahaqqu.com`**.
- The new site may launch with an honest empty catalog. It never uses demo offers to look populated.
- Fresh PostgreSQL schema, accounts, products, evidence, and pipeline state; no legacy migration, dual-write, or compatibility layer.
- VPS PostgreSQL 17 + Bun/Hono modular monolith; R2 immutable public brochure evidence, private raw artifacts, and encrypted off-box backups; Cloudflare DNS/CDN/WAF.
- Superindo only, current Jabodetabek-Palembang scope, manual collection and human-approved publication.
- Every new/ambiguous identity is human-approved; category may remain null. During the two pilot campaigns every public offer is human-approved.
- Two distinct complete campaigns pass before scheduled Superindo operation and before enabling the next store.
- Guests get local watchlist + one shopping list with explicit import after sign-in. Household modules are optional and default off.
- Accuracy/design first. Measure cost before ordinary budgets; every paid experiment still needs explicit owner authorization and an emergency gross-spend stop.
- Reduce Actions across all owned repositories without deleting meaningful deploy/test/backup/security evidence.

## 2. Delivery strategy

Use short vertical slices, not one large rewrite PR. Two lanes may run concurrently after the platform contract is stable:

```text
Lane A — trusted data
contract → discovery/evidence → extraction/registry → review → publication
                                                              │
Lane B — product                                                ▼
tokens/SSR proof → public shell → guest state/accounts → approved offers on main
```

The lanes join at real contract fixtures. No production UI reads pipeline-local files, and no pipeline stage calls public consumer APIs.

## 3. Phases and blocking gates

| Phase                                | Deliverable                                                                                                                    | Blocking gate                                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. Plan and safety**               | Approved docs, child issues, legacy freeze tag, scraping paused, billing blocker assigned.                                     | **C0:** owner approves design/plan. No destructive action or paid run.                                                                                                                             |
| **1. Actions spend stop**            | Highest-value schedule/trigger reductions across the portfolio.                                                                | Active deploy/test/security paths still work; no direct-to-main edits.                                                                                                                             |
| **2. Fresh platform core**           | PG schema/roles, Hono module skeleton, R2 storage, sessions, idempotent ingest, outbox, VPS service contracts.                 | Concurrent replay, crash recovery, IDOR/RLS, artifact rollback, isolated restore, and a bounded capacity baseline pass (amended 2026-11-28: the combined stress test moves to Phases 6–7; see §6). |
| **3. Public design foundation**      | Responsive tokens/components, selective SSR proof, guest/public shell, honest empty/error/stale states.                        | **C1:** owner approves responsive screens/copy; SSR/accessibility/cache tests pass.                                                                                                                |
| **4. Superindo discovery**           | Complete campaign/page manifest, immutable evidence, explicit region/validity/coverage, replay from frozen bytes.              | Both hubs and all in-scope pages accounted; zero/overflow/drift fail closed; no OCR/publish implied.                                                                                               |
| **5. Extraction and review core**    | Structured extraction, prompt/model registry, gold dataset, cost ledger, identity/review/publication admin.                    | **C2:** owner authorizes paid pilot. Offline tests prove no auto-solo/unresolved attach, null category, atomic publish, and corrupt-spool quarantine.                                              |
| **6. New-site release + Campaign A** | Main hostname serves v2; legacy serves v1 subdomain; first complete Superindo campaign reviewed and approved offers published. | **C3:** owner signs Campaign A quality/cost/UX report. Main may show empty before approval; scheduling and next store stay disabled.                                                               |
| **7. Campaign B and scheduling**     | Distinct fresh campaign, expiry/freshness rollover, regression/cost comparison, final capacity/restore proof.                  | **C4:** owner signs Campaign B. Only now enable Superindo schedule and unlock one next store.                                                                                                      |
| **8. Accounts and household value**  | Synced watch/list and explicit import; optional modules one at a time.                                                         | **C6 per module:** privacy, permissions, retention/export/purge, cost, navigation, and accessibility approved.                                                                                     |
| **9. Next-store certification**      | One deliberately selected store repeats the complete program.                                                                  | **C5:** prior store remains healthy; new store passes two complete campaigns before another follows.                                                                                               |
| **10. Legacy retirement**            | Remove unused D1/Worker paths and obsolete workflows/docs after owner chooses deletion.                                        | New backup/restore/deploy/rollback evidence is current; no runtime v2 dependency on legacy remains.                                                                                                |

Phases 2–5 contain ordered PRs below. Phase 6 does not wait for a second campaign merely to keep the old UI on the main hostname.

## 4. Phase 0 — approval, tracking, and safety

1. Docs-only PR with the five research/design/plan documents and the program state file: [#759](https://github.com/ahaqqu/RumaQ/pull/759). Link every research/design/plan comment to it.
2. Create child issues under #758 for the phases below, with entry step `Plan` and dependencies recorded. Move only the active issue to `In Progress` after approval.
3. Freeze legacy with an annotated tag/commit record. Its Worker remains deployed for the v1 hostname; no ongoing feature work is planned there.
4. Stop legacy scheduled scraping through the controlled VPS/config path before fresh collection. Do not delete old data.
5. Keep the GitHub billing owner action open until private pipeline CI actually starts and runs steps. Do not mistake zero-step billing failures for code failures.
6. Reconcile, rather than blindly finish, current work:
   - PR #748 remains the visual prototype; incorporate the uncommitted Belanja iteration only through its own reviewed PR.
   - Pipeline #219/#223 reset/pause work is held or reshaped into discover/extract/reprocess/publish controls.
   - RumaQ #753/#754 remains legacy history; destructive wipe is not the routine v2 quality loop.
   - The prepared `rumaq-v2` D1 cutover action was closed by the owner on 2026-11-28: its entry is removed and the database is unused. Deleting it is a separate Phase 10 decision.

**Exit:** owner says “approve plan”; docs PR and active child issues are visible; no scrape/deploy has occurred.

## 5. Phase 1 — GitHub Actions reduction

Execute each repository independently with its own PR/settings verification. Full evidence and per-repo inventory are in [v2-actions-audit.md](v2-actions-audit.md).

### Wave 1A — immediate waste

| Repository                         | Action                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| BayiQ                              | Disable the 15-minute Dependabot polling schedule (~2,880 runs/30 days). Replace with event-driven auto-merge if the repo remains active. |
| `no-mistakes`, `laradock-sidemaya` | Disable Actions repository-wide; retain upstream YAML/history and avoid fork-sync drift.                                                  |
| `agentic-project-template`         | Guard/disable scheduled self-sync in the upstream template repository; retain distributable scaffolding where needed.                     |
| BayiQ                              | Disable the older failing template-sync schedule until updated/fixed.                                                                     |
| `wni-series`                       | Disable the never-run deploy scaffold until Phase 0 exists; no schedule currently consumes spend.                                         |

### Wave 1B — dedupe without weakening gates

- AutQ: run push CI on `main` only; retain PR CI and separate staging/manual-production deploys.
- Template/KajianQ/BayiQ: converge on RumaQ's event-driven Dependabot auto-merge; require the relevant checks and least privilege.
- RumaQ-pipeline: routine Bun version updates daily -> weekly; retain security updates.
- RumaQ: evaluate routine Bun version updates daily -> weekly without changing security alert behavior.
- Template/BayiQ/KajianQ/RumaQ scanners: triage existing failures, then consolidate routine scans to weekly/manual plus lockfile CI where appropriate. Do not remove a failing scanner before knowing whether it found a vulnerability or suffered a tool error.
- KajianQ: make workflow-token permissions explicitly least privilege during the next edit.

### Preserve

RumaQ PR CI/scoped smoke/full automation/production smoke/backup/preview/test images; pipeline CI/contract drift/VPS deploy; DokumenQ real integration; AutQ staging/prod separation; vps untrusted-plan/write-comment separation; KajianQ E2E/staging/restore; gunbatte/homepage/TepuQ deploy and smoke chains.

### Gate

- No 15-minute polling remains.
- No active production deployment path is removed.
- Auto-merge still waits for checks and does not silently drop production deploys.
- Backup/restore/security signals remain visible.
- No workflow-run history is deleted for cost reduction.

## 6. Phase 2 — fresh platform core

> **Amended 2026-11-28 (owner-confirmed; see [v2-phase2-design-addendum.md](v2-phase2-design-addendum.md)).** The sequences below replace the plan's original Phase 2 list — eight RumaQ PRs starting with the contract vocabulary major, then six `ahaqqu/vps` PRs at the tail. The addendum governs wherever the two differ. What changed: the first work is no longer the contract major — v2 starts with its scope rule and its `server/` home, the domain vocabulary kernel comes third, and the pipeline-facing wire contract is cut once, after R9 and before Phase 4, as a projection of the real schema; `server/` is a standalone Bun package with its own lockfile, not a root workspace member, and legacy `contract/` stays untouched; the PostgreSQL gate is `./scripts/test.sh unit server`; the host-side slices come forward so the deploy path is proven with a health-only artifact instead of at the tail, and their open points are decided (a one-time runbook bootstrap, a new DNS-only v2 hostname, a nightly encrypted dump with an isolated restore drill); and Dependabot auto-merges patch-level and security updates only during the freeze.

### RumaQ slices

| Wave | Slice                                              | Issue                                                                              | Delivers                                                                                                                                                     | v1 Worker deploy on merge |
| ---- | -------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| A    | R1 — scope rule                                    | [#781](https://github.com/ahaqqu/RumaQ/issues/781)                                 | `server/**` becomes a known path: it runs the v2 suite, skips v1-only suites, and never deploys the v1 Worker                                                | yes, once                 |
| A    | R2 — `server/` + real-PG gate                      | [#782](https://github.com/ahaqqu/RumaQ/issues/782)                                 | v2's home as a standalone package; `unit server` from day one; health-only entrypoints; architecture test; OpenAPI wiring                                    | yes, once                 |
| B    | R3 — vocabulary kernel                             | [#783](https://github.com/ahaqqu/RumaQ/issues/783)                                 | The truth contract as code: run, campaign-revision, offer-version and publication state machines, source modes, price bases and disposition codes            | no                        |
| B    | R4a — runner, roles, enums                         | [#784](https://github.com/ahaqqu/RumaQ/issues/784)                                 | Migration runner inside the artifact, first migrations, the enum sync test, the append-only guard                                                            | no                        |
| B    | R4b — tenancy core                                 | [#785](https://github.com/ahaqqu/RumaQ/issues/785)                                 | `users`, `auth_identities`, `households`, `household_members` with composite keys and RLS; structural tenancy tests                                          | no                        |
| C    | R5 — identity + sessions                           | [#786](https://github.com/ahaqqu/RumaQ/issues/786)                                 | Opaque hashed sessions, `(issuer, subject)` identity, expiry, revocation, server-resolved roles, Origin/CSRF; the OIDC adapter is its own PR after the spike | no                        |
| C    | R6 — evidence storage                              | [#787](https://github.com/ahaqqu/RumaQ/issues/787)                                 | Content-addressed storage with public and private namespaces, no overwrite, verify-then-record, pin-aware retention                                          | no                        |
| D    | R7 — runs, ingest, outbox                          | [#788](https://github.com/ahaqqu/RumaQ/issues/788)                                 | Durable, replayable ingest; leased at-least-once delivery with exactly-once effects; crash-point tests                                                       | no                        |
| D    | R8 — source registry + publication                 | [#789](https://github.com/ahaqqu/RumaQ/issues/789)                                 | What may be published, who approved it, and what is current — without publishing anything                                                                    | no                        |
| D    | R9 — public read repositories                      | [#790](https://github.com/ahaqqu/RumaQ/issues/790)                                 | One query decides what is publicly current; history and as-of; the full case matrix                                                                          | no                        |
| B\1  | [#791](https://github.com/ahaqqu/RumaQ/issues/791) | One way to ship v2 to the host through `scripts/deploy.sh`, manual-only in Phase 2 | yes, once                                                                                                                                                    |
| —    | Wire-contract cut                                  | issue at Phase 2 exit                                                              | The kernel is promoted to a package; the tested internal schemas are frozen with fixtures. The first item after Phase 2 exit                                 | no                        |

Order: R1 → R2 → R3 → R4a → R4b → R5 and R6 (either order) → R7 → R8 → R9. R1 and R2 are approved as a pair and merged back to back. R10 starts as soon as R2 is merged, on its own branch from R2, so the deploy path is proven early with a health-only artifact; its rollback rehearsal is repeated after R9 with real migrations. Every slice pull request is held for the owner's approval before it merges (addendum §8).

Outside the slice sequence, one small workflow PR, [#792](https://github.com/ahaqqu/RumaQ/pull/792), narrows Dependabot auto-merge to patch-level and security updates for the frozen v1 — minor and major bumps wait for the owner. It touches only `.github/` and `docs/`, both in the deploy skip set, so merging it does not deploy the v1 Worker (addendum §7).

### `ahaqqu/vps` slices

Host-side work belongs in `ahaqqu/vps`, never in this repository. Its issues are cited by number only: a merge to that repository's `main` is a host change within 15 minutes, so there is never more than one vps pull request per approval.

| Slice             | Issue | Delivers                                                                                               | Wave                        |
| ----------------- | ----- | ------------------------------------------------------------------------------------------------------ | --------------------------- |
| V1                | #53   | Database and roles — a one-time runbook step, run once by the owner                                    | B: starts when R2 is merged |
| \1B: follows V1\2 |
| \1D: after V4\2   |
| \1B: with R10\2   |
| V5                | #57   | Nightly encrypted dump and isolated restore drill; WAL archiving is a separate decision before Phase 6 | E: after V4                 |

The `rumaq-v1.ahaqqu.com` legacy hostname has been live since Phase 0 (#772); the main-host cutover stays a separate reviewed change in Phase 6.

### Required gates

- `./scripts/test.sh unit server` and relevant automation-local suites use real PostgreSQL 17 with pgvector and pg_trgm — connected as the real `rumaq_app` and `rumaq_migrator` roles — not a D1 mock. The gate fails rather than skips without a database and runs inside the required `ci` check. (Confirmed by the owner on 2026-11-28: the plan first named `unit backend`, which runs only `backend/src/**/*.test.ts` and cannot reach v2 code under `server/`. The suite exists from R2.)
- Idempotency replay, same-key/different-body 409, in-flight retry, and crash-after-external-effect tests pass.
- Cross-household composite-FK/RLS/IDOR tests pass; application role cannot bypass RLS.
- API + worker + PG + pipeline + resident-apps load stays inside the host resource envelope (Amended 2026-11-28: Phase 2 proves a bounded synthetic-load baseline on the host; the combined stress test runs in Phases 6–7, where this plan repeats it.)
- A fresh backup restores into isolation; representative public/account/admin reads and evidence hashes verify.
- Previous application artifact rollback is rehearsed.

## 7. Phase 3 — public design foundation

1. Finish the high-fidelity responsive concept at 320/390/768/1440, including home, promo catalog, campaign/list+original brochure, product, watchlist, shopping, profile, sign-in/import, and admin review.
2. Preserve the prototype's warm pink/gold identity, price legibility, illustrations, and brochure-evidence loop. Replace tiny text/targets, five-items/four-columns navigation, fixed desktop phone frame, and ambiguous save/bookmark actions.
3. Extract reviewed design tokens and shared React components; retain Tailwind v4/TanStack/Query conventions. Do not port the prototype's global `innerHTML` renderer.
4. Prove selective SSR on Bun for one campaign and one product. If TanStack Start cannot run cleanly on the pinned runtime, use Vite prerendering + Hono public shells rather than adding Node solely for SSR.
5. Build public route-level loading/empty/error/stale/expired/withdrawn states and fixture matrix before wiring live data.
6. Implement local guest region/language/watch/list storage and its versioned namespace. No anonymous saved-state API.
7. Implement account sign-in return path and explicit import preview; no silent merge/overwrite or premature local deletion.
8. Add id/en resources, WCAG 2.2 AA checks, keyboard/screen-reader passes, reduced motion, responsive visual tests, and PWA cache-privacy/validity tests.

**C1 owner review:** approve tokens, responsive screenshots, truth copy, empty-state launch, public rehosted brochure presentation, and accessibility results.

## 8. Phase 4 — Superindo discovery and gold corpus

1. Seed only Superindo `manual_only`; every other source `disabled` and absent from admin manual pickers.
2. Retain the existing host allowlist, hub/gallery parser, and fetch primitives after fixture verification.
3. Emit campaign, revision, page, region, validity, source URL, content hash, and coverage manifest for both current hubs.
4. Replace silent `maxPages` slicing with `coverage_limit_exceeded` before paid extraction. Unexpected zero pages, missing pages, duplicate URLs, changed selectors, and rotation/deferral are blockers.
5. Upload immutable source/page evidence and verify hashes before novelty advances. Reprocess reads frozen bytes without refetching.
6. Freeze Campaign A and independently label every printed priced tile, no-price region, and deliberate omission. Capture name/brand/size/pack/form/variant, price roles/literal text, member/original, promo/quantity/date conditions, evidence, and expected identity disposition.
7. Version the labeling guide and adjudicate disagreements. OCR output is never its own label source.

**Exit:** complete immutable corpus + gold labels + coverage report. No model call or publication is implied.

## 9. Phase 5 — extraction, evaluation, review, and publication

### Pipeline PRs after RumaQ contract merges

For each contract change: merge RumaQ first, then `./scripts/sync-contract.sh <sha>` in the pipeline PR.

1. Add discover/extract/reprocess/publish command separation and stable run IDs/events/checkpoints.
2. Add prompt/model/pipeline release registry bindings and strict structured output. Persist every raw paid response before parsing, including malformed/discarded calls.
3. Reuse pure IDR/date/unit/promo validators. Add region/cross-month/date/evidence/tile lineage and explicit rejection codes.
4. Make embeddings candidate generation only. Replace auto-solo and verifier-null/YES auto-acceptance with private identity candidates/review tasks.
5. Move category decision/research out of offer acceptance. Canonical category remains nullable; research cannot self-clear.
6. Add provider calls/cost ledger/allocation, missing-cost markers, review minutes, accepted denominators, and per-store/run/campaign reports.
7. Make publication consume only an approved batch/manifest/idempotency key. No OCR/matching/research during publish.
8. Quarantine malformed spool artifacts; unrelated success cannot retire unacknowledged/corrupt evidence.

### Evaluation

- Run the current OCR route + structured prompt against frozen gold first.
- Evaluate a revised evidence-first prompt and at most one justified alternative route/reasoning configuration at a time. Do not launch a broad model shootout.
- If whole-page extraction cannot meet critical-field/coverage acceptance, test detect-then-extract tiling; do not hide missing tiles with self-reported recall.
- Same-model reruns measure nondeterminism. Cross-model agreement is not correctness.
- Select on accepted critical-field/identity accuracy, then coverage, latency, and measured cost.

### Admin review

Build separate coverage/extraction/identity/category/publication queues, evidence zoom/crop highlighting, parser/raw-response diff, named decisions, optimistic concurrency, and publication preview. “Leave uncategorized” is successful. No bulk approval of proposed new identities.

**C2 owner authorization:** approve the frozen corpus, exact models/prompts, expected call count, and emergency gross-spend stop before any paid evaluation. This is an experiment safety stop, not an accuracy-driven page truncation.

## 10. Phase 6 — new-site release and Campaign A

1. Verify the legacy app at **`rumaq-v1.ahaqqu.com`**, including auth/API/PWA and its existing Worker binding.
2. Switch **`rumaq.ahaqqu.com`** to the new VPS application. Before approved data, show the honest empty catalog and working public/account flows.
3. Stop legacy scheduled writes. Keep legacy D1/R2 untouched and never read it from v2.
4. Complete Campaign A review. Every candidate has a coded disposition; every published offer has named approval, evidence, region, validity, and conditions.
5. Publish the approved batch atomically and reconcile ingest receipts, DB versions, public APIs/SSR, evidence, cache purge, and UI cards/details/list totals.
6. Verify expiry/stale behavior, guest local state, sign-in/import, privacy, accessibility, and responsive browser matrix.
7. Produce the Campaign A quality/cost/operations report, including exclusions and corrections. Unknown cost is unknown, not zero.

**C3 owner sign:** accept/reject Campaign A and authorize Campaign B. Superindo remains manual-only; every other store remains disabled.

### Rollback boundary

Before v2 accepts user writes, the main hostname can return to legacy. After v2 user writes, rollback means the previous v2 artifact/DB recovery or a maintenance page; never silently return users to stale legacy state.

## 11. Phase 7 — Campaign B and scheduled operation

1. Discover a distinct fresh source campaign and manifest; reprocessing Campaign A does not count.
2. Repeat complete page/tile accounting and human-gated identity/exception/publication review.
3. Prove campaign rollover, expiry at the WIB boundary, stale removal, correction/withdrawal, and cache invalidation.
4. Compare prompt/model/parser/output against Campaign A and frozen gold. Any material source change or model/prompt change follows the recertification rule in the design.
5. Repeat combined-host load, backup/restore, rollback, monitoring, and alert verification.
6. Produce the combined two-campaign quality/cost/review-time report.

**C4 owner sign:** only this signature permits:

- Superindo `scheduled` mode;
- automatic publication policy for known approved identities, if separately approved;
- manual-only enablement of one next store.

Do not infer auto-publication from scheduling. They are separate switches.

## 12. Phases 8–10 — household modules, next stores, retirement

### Household modules

Order by owner value, one at a time: Pantry, Receipts & history, Tasks, Calendar, Documents. Each receives fresh schema/UI, default-off plugin enablement, household authorization, retention/export/purge, notification and AI/platform cost review. Do not block the promo core on these modules.

### Next store

Select using user value, source health, expected coverage, identity complexity, and measured Superindo cost/capacity. Similarity does not waive evidence. Repeat discovery → immutable corpus → extraction evaluation → review → two complete campaigns before another store. Do not show “coming soon” consumer cards.

### Legacy retirement

After owner approval and a verified new backup/restore/deploy chain:

- remove old D1 bindings, migrations, route/query implementation, and Cloudflare application deploy/preview cleanup only when no longer needed;
- retain/replace D1 backup with the proven PG backup path before deleting the old workflow;
- decide archival/deletion of old D1/R2 and the unused prepared `rumaq-v2` D1 explicitly;
- update ARCHITECTURE, BACKEND/FRONTEND_CONVENTIONS, README, generated API, VPS resources, and pipeline docs;
- mark phase-08's “complete rewrite out of scope” and old Figma/guest-access tickets superseded/closed with links to delivered v2 artifacts;
- remove completed MANUAL_ACTIONS entries rather than leaving stale instructions.

## 13. Cross-repo PR order

| Order                                                                                                                                   | Repository                             | Work                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1                                                                                                                                       | RumaQ                                  | Docs-only research/design/plan PR.                                                              |
| 2                                                                                                                                       | BayiQ/template/forks/AutQ/other owners | Independent Actions reduction PRs/settings checks; no dependency on app rewrite.                |
| 3                                                                                                                                       | RumaQ + vps                            | Freeze legacy and prepare `rumaq-v1` hostname before changing the main deployment path.         |
| 4                                                                                                                                       | RumaQ                                  | Scope rule, `server/` + PG test gate, vocabulary kernel, PG migrations (§6).                    |
| 5\1Interleaved with the RumaQ slices (§6): database and roles, the three units and the deploy contract early; nginx and backup later.\2 |
| \1; the v2 deploy entrypoint early (R10).\3                                                                                             |
| 7                                                                                                                                       | RumaQ-pipeline                         | Sync contract; Superindo discovery/evidence first, then extraction/registry/review integration. |
| 8                                                                                                                                       | RumaQ                                  | Responsive public shell and admin review vertical slices against contract fixtures.             |
| 9                                                                                                                                       | RumaQ + vps                            | Main/v1 hostname release after QA; Campaign A approved publication.                             |
| 10                                                                                                                                      | RumaQ-pipeline + RumaQ                 | Campaign B, schedule/next-store gate, then repeat per store.                                    |

No PR merges with red relevant checks. The private billing wall must be resolved or explicitly worked around through a trustworthy existing CI path; disabling required checks is not an option.

## 14. Test and verification policy

- RumaQ: `./scripts/test.sh unit backend`, `./scripts/test.sh unit frontend`, `./scripts/test.sh unit server` (the v2 PostgreSQL gate; confirmed by the owner on 2026-11-28 — see §6; the suite exists from R2), scoped/full automation-local as the slice requires, style/check/docs gates, PR smoke, and post-deploy smoke.
- Pipeline: `./scripts/test.sh unit groceries-scraper`, contract-sync/parity, style, deterministic frozen-byte replay, and no network/paid calls in ordinary CI.
- VPS: `bash tests/run.sh`, `bin/check-secrets`, `bin/plan`, and the applicable dry-run/container gates.
- Live model evaluations are manual, owner-authorized, versioned, and separately reported—not hidden in PR CI.
- Every live QA run follows `docs/QA.md` with one tracking ticket and triaged findings.
- A successful scrape command, HTTP 200, ingest receipt, or exit 0 is operational evidence only, never quality acceptance.

## 15. Program acceptance

The program is not done when the new UI merely renders. It is done when:

1. Main serves the new promo-first app and v1 is isolated on its subdomain.
2. Public users can browse approved current offers/evidence without login; account and household data remain private.
3. Every public current offer satisfies the accepted-version, validity, complete-campaign, public-source query.
4. No auto-solo, unresolved identity, self-approved category, silent truncation, lowest-price conflict guess, or evidence-less publication path remains.
5. Guest local watch/list and explicit account import work without silent data loss.
6. Superindo has two owner-signed complete campaign reports and measured cost before scheduling/next-store expansion.
7. PostgreSQL backup, isolated restore, deployment rollback, public load, cache expiry, and host-capacity gates have real evidence.
8. Household modules remain optional/default-off until individually approved.
9. The P0 Actions waste is gone and remaining automation has a documented distinct purpose.
10. Legacy runtime/data/workflows are retired only by explicit owner decision after v2 verification.

## 16. Immediate next checkpoint

The plan is approved (C0, 2026-11-28) and Phases 0–1 are closed. The current checkpoint is Phase 2 (§6), tracked in [v2-program-state.md](v2-program-state.md) and on Delivery Kanban under [#763](https://github.com/ahaqqu/RumaQ/issues/763):

1. Wave A: R1 (the scope rule) and R2 (`server/` and the real-PostgreSQL gate) are implemented, reviewed and held for approval as a pair.
2. Then waves B–E per §6 and addendum §12. Every slice pull request is held for the owner's approval before it merges.
3. Keep all scraping disabled and make no paid model calls until C2.
