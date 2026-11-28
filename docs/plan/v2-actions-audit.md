# RumaQ v2 — GitHub Actions portfolio audit and disposition

> Read-only audit for [#758](https://github.com/ahaqqu/RumaQ/issues/758), as of 2026-11-26T12:52Z. Scope: all 39 repositories visible under `ahaqqu`; default-branch workflow YAML, Dependabot configuration, registered Actions workflows, and recent runs. No workflow, repository setting, billing setting, or file was changed.

## 1. Totals and billing context

- **39 owned repositories**, none archived.
- **59 current workflow YAML files across 16 repositories**.
- Seven repositories have Dependabot configuration/dynamic entries.
- **23 repositories have no workflow YAML** and need no Actions reduction.
- KajianQ has three stale Actions registrations whose default-branch YAML is already gone.
- `laradock-sidemaya` has two YAML files not registered in Actions.

The private-repository Actions payment/spending-limit wall began around 2026-11-25. Pipeline PR #223's failed `ci` run has zero job steps; that is consistent with the billing wall and is not a product/test failure. Reduction work must not be presented as a fix for billing, and failed jobs must not be rerun blindly.

## 2. Prioritized changes

| Priority | Repository / workflow                               | Finding                                                                                                                                        | Planned disposition                                                                                                                                                                                                                             |
| -------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | BayiQ `dependabot-auto-merge.yml`                   | Runs every 15 minutes: **96/day, about 2,880/30 days**, with contents/PR write.                                                                | Disable the schedule immediately in the approved Actions wave. If auto-merge is still wanted, replace it with the proven event-driven `pull_request_target` + metadata pattern, then delete the polling implementation.                         |
| P0       | `no-mistakes`, `laradock-sidemaya`                  | Dormant forks; zero runs. Fork workflows can create releases/Pages or consume a large matrix if enabled. Laradock schedules are upstream-only. | Disable Actions repository-wide. Do not delete upstream YAML and create fork-sync drift unless intentionally diverging.                                                                                                                         |
| P0       | Template and BayiQ `template-sync.yml`              | Weekly schedules fail; BayiQ has an older implementation.                                                                                      | Disable/guard self-sync in the source template; disable BayiQ sync until updated and fixed. Retain distributable template files where downstream repositories need them.                                                                        |
| P1       | AutQ `ci.yml`                                       | `push` on every branch plus `pull_request` duplicates same-repo work in a private billed repository.                                           | Restrict push CI to `main`; retain PR coverage and staging/production deploy separation.                                                                                                                                                        |
| P1       | Template, KajianQ, BayiQ Dependabot auto-merge      | Weekly/daily/15-minute polling reimplement the same task.                                                                                      | Consolidate on RumaQ's event-driven pattern. Preserve least-privilege permissions and require relevant checks.                                                                                                                                  |
| P1       | RumaQ-pipeline Dependabot Bun updates               | Daily version-update PRs invoke private CI.                                                                                                    | Move routine version updates to weekly. Keep security alerts/security updates conceptually separate.                                                                                                                                            |
| P1       | RumaQ, template, KajianQ, BayiQ vulnerability scans | Daily OSV/Bun scans coexist with Dependabot; some template/BayiQ scans fail at OSV-Scanner.                                                    | Triage failures first. Consolidate to Dependabot security coverage + CI on lockfile changes + weekly/manual scanner where it adds value. Do not remove a scanner before establishing whether it found vulnerabilities or suffered a tool error. |
| P2       | `wni-series` `deploy.yml`                           | Guarded, never-run scaffold; no scheduled spend.                                                                                               | Disable until Phase 0 exists; retain YAML as the intended future deployment path.                                                                                                                                                               |
| P2       | Legacy `haqita`                                     | PR-only CI, no schedule/current spend; web tests are nonblocking.                                                                              | If retired, disable Actions/archive rather than delete history. If revived, make the web lane a real gate.                                                                                                                                      |
| P2       | KajianQ token permissions                           | Default workflow token is write and can approve reviews; several workflows omit explicit permissions.                                          | Set explicit least-privilege permissions during the next edit. This is security hygiene, not schedule reduction.                                                                                                                                |

## 3. Active core repositories

### RumaQ — retain the distinct gates

Eleven workflows:

| Workflow                    | Role                                                            | Decision                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit.yml`                 | Daily Bun audit, safe-update tests, auto PR/issue lifecycle.    | Retain manual/security replacement; weekly cadence is reasonable after dependency/security consolidation.                                     |
| `auto-merge-dependabot.yml` | Event-driven minor/patch squash auto-merge.                     | Retain as the canonical pattern.                                                                                                              |
| `backup.yml`                | Daily D1 -> R2 export, verification, retention, failure issues. | Retain while D1 exists. Replace with an equivalent tested PostgreSQL backup/restore workflow before D1 is retired.                            |
| `ci.yml`                    | PR offline CI and scoped Lighthouse.                            | Retain; repair the current cf/vite-plugin toolchain mismatch rather than bypassing the gate.                                                  |
| `cleanup-branch.yml`        | Deletes branch preview Worker on PR close.                      | Retain while branch Workers exist.                                                                                                            |
| `deploy.yml`                | Main CI then the single Cloudflare deploy entrypoint.           | Retain until the approved infrastructure cutover; then replace with the VPS app deploy path, not an additional writer.                        |
| `pr-e2e-smoke.yml`          | Scoped critical local E2E on PRs.                               | Retain; not redundant with full nightly or production smoke.                                                                                  |
| `preview.yml`               | On-demand branch Worker preview.                                | Retain as on-demand.                                                                                                                          |
| `publish-test-images.yml`   | Digest-keyed GHCR test images.                                  | Retain while Docker automation uses the images.                                                                                               |
| `smoke.yml`                 | Six-hourly production smoke, freshness, and issue lifecycle.    | Retain function; after the public rewrite, consider daily versus six-hourly based on measured alerting value rather than deleting the signal. |
| `test-automation.yml`       | Daily full Docker integration/E2E completeness.                 | Retain; deliberately broader than PR smoke.                                                                                                   |

RumaQ's routine Bun version updates can move from daily to weekly after checking security-update behavior. No current RumaQ workflow is an obvious safe deletion.

### RumaQ-pipeline — retain three distinct workflows

- `ci.yml`: PR/scoped offline gate; retain.
- `contract-drift.yml`: weekly vendored-contract check; retain.
- `deploy-vps.yml`: main/dispatch deploy through `scripts/deploy.sh groceries vps`; retain.

This VPS deploy is not a duplicate of RumaQ's application deployment. Only routine dependency cadence is an obvious reduction.

### DokumenQ

PR/main Rust and JS/integration lanes test different behavior. Retain. Setup/build duplication can be optimized later, but do not remove the real Rust-server JS integration or cargo-deny advisory coverage.

### AutQ

Retain staging auto-deploy and manual/main-gated production promotion. Restrict duplicate CI branch pushes as above. Do not collapse staging and production into one path.

### vps

Retain ShellCheck, applier fixtures/root tests, nginx/logrotate/secret-shape validation, PR plan rendering, and the separate write-comment job. The separation between untrusted plan rendering and the write token is deliberate.

## 4. Other maintained products

| Repository                 | Current automation                                                                                     | Decision                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentic-project-template` | CI, E2E, polling Dependabot merge, manual CF deploy/provision/staging, self-sync, daily OSV.           | Retain CI/E2E; event-drive dependency merge; guard self-sync; triage OSV; manual scaffolds have no schedule cost and may remain distributable files.                   |
| `KajianQ`                  | CI, E2E, reusable VPS deploy, staging/eval/security, restore drill, daily OSV, daily Dependabot merge. | Retain CI/E2E/deploy/staging/restore; event-drive merge; consolidate vulnerability cadence; leave already-absent stale workflow history alone.                         |
| `wni-series`               | CI and guarded manual deploy scaffold.                                                                 | Retain CI/Dependabot; disable deploy until ready.                                                                                                                      |
| `KisahQ`                   | PR-only typecheck/story/tests/build/Wrangler dry-run.                                                  | Retain.                                                                                                                                                                |
| `BayiQ`                    | CI/E2E/deploy/provision/staging plus 15-minute merge, weekly sync, daily OSV.                          | If dormant, pause all three schedules and routine version updates while retaining manual CI/deploy. If active, replace polling and fix sync/scanner before reenabling. |
| `gunbatte`                 | Filtered CI then `workflow_run` VPS deploy.                                                            | Retain; no schedule.                                                                                                                                                   |
| `homepage`                 | CI then `workflow_run` VPS deploy.                                                                     | Retain.                                                                                                                                                                |
| `TepuQ`                    | Main unit/build/Pages deploy then live Playwright smoke.                                               | Retain both; post-deploy E2E is not duplicate PR smoke.                                                                                                                |

## 5. Dormant forks and legacy repositories

- `no-mistakes`: disable Actions repo-wide. Its release/docs/signature workflows are upstream-specific and inappropriate to run accidentally in the fork.
- `laradock-sidemaya`: disable Actions repo-wide. Existing scheduled/docs jobs are upstream-only and have never run in the fork.
- `haqita`: disable/archive if formally retired; otherwise retain PR-only tests and fix the nonblocking web gate.
- No Actions work is needed in the 23 repositories without workflow YAML: BukuCeritaQ, AgenQ, gunbatte-balls, tech-interview, DARS, MemoriQ, task-scheduler, haqita-server, haqita-pipeline, haqita-database, agentic-engineering, fantasy-football-copilot, sidemaya, sidemaya-backup, venue-rendezvous-ui, venue-landlord, venue-rendezvous, testing-github, GDPRDeleteAPI, asisten, spring-framework, Jenkins, and self-checkout.

## 6. Delete versus disable rules

- **Disable a workflow** to stop all triggers while preserving YAML and history.
- **Remove only `schedule`** when manual/PR triggers should continue.
- **Delete YAML** only after its replacement is proven or the path is intentionally retired. This does not delete old runs/logs/artifacts.
- **Never delete run history for cost reduction.** It does not stop future spend and destroys evidence.
- **Dependabot version updates and security updates are different.** Removing `.github/dependabot.yml` stops scheduled version PRs; it is not the security-alert control.
- Prefer repository-level Actions disablement for dormant forks over deleting upstream files.
- No reduction may bypass required product checks, deployment smoke, backup verification, or restore drills.

## 7. Execution waves after owner approval

1. **Immediate spend stop:** BayiQ 15-minute polling; dormant forks; failing template/BayiQ sync schedules; wni deploy scaffold if desired.
2. **Event-driven dependency wave:** template, KajianQ, BayiQ; weekly private pipeline/RumaQ routine version updates. Verify auto-merge still waits for relevant checks.
3. **CI dedupe:** AutQ push-to-main only; inspect other duplicate branch/PR triggers before changing them.
4. **Security consolidation:** triage failing scanners, then weekly/manual cadence and lockfile CI without weakening Dependabot security coverage.
5. **RumaQ architecture-dependent cleanup:** replace D1 backup and Cloudflare deploy/cleanup only after the new PostgreSQL/VPS backup, restore, deployment, preview, and rollback paths pass live verification.
6. **Dormant-product decision:** owner marks BayiQ/haqita active or retired; apply archive/disable only after that decision.

Each repository gets its own PR and checks. Repository settings changes and their verification are recorded separately; no direct-to-main workflow edits.
