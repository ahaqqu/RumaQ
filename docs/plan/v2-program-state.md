# RumaQ v2 — program state

> Resume point for the v2 program ([#758](https://github.com/ahaqqu/RumaQ/issues/758)). Read this file first, in any session, with any harness or model.
> Program source: `main` · Planning PR: [#759](https://github.com/ahaqqu/RumaQ/pull/759) (merged) · Last updated: 2026-11-28

## Resume protocol

1. Branch from `main` into a dedicated worktree for each implementation slice; never commit directly to `main`.
2. Read this file, then [v2-ground-up-plan.md](v2-ground-up-plan.md), and the [design](v2-design.md) before any implementation.
3. `gh pr view 759 --comments` and `gh issue view 758 --comments` hold the planning record; the active phase issue holds implementation decisions.
4. Execute only the **Next action** below, and only once the **Current gate** is signed. No implementation, deploy, paid model call, or live scrape before C0.
5. Before stopping: commit, push, and update **Current gate**, **Next action**, and **Log** in this file.

Working state lives in git and GitHub. Harness-local state (`~/.agents/manager/...`, chat history, local inboxes) does not travel between harnesses, models, or machines.

## Current gate

**C0 — owner plan approval: approved.** On 2026-11-28 the owner approved C0, including the plan and the disclosure of selected private-repository Actions metadata and private-pipeline operational details in this public repository.

Post-C0 implementation may proceed only within the approved phase gates. Paid Superindo evaluation still requires C2; production publication, scheduling, next-store enablement, and household modules retain their separate gates.

## Gates

| Gate | Unlocks                                                               | Status   |
| ---- | --------------------------------------------------------------------- | -------- |
| C0   | Plan approval; child issues; legacy freeze; Phase 1 Actions reduction | Approved |
| C1   | Responsive public design foundation                                   | After C0 |
| C2   | Paid Superindo extraction/OCR pilot                                   | After C0 |
| C3   | New site on `rumaq.ahaqqu.com` plus Campaign A publication            | After C2 |
| C4   | Superindo `scheduled` mode and manual enablement of one next store    | After C3 |
| C5   | Next-store certification (repeat the whole program per store)         | After C4 |
| C6   | Each optional household module, approved one at a time                | After C3 |

## Next action

Phase 0 (safety) and Phase 1 (Actions spend stop) are complete. [#763](https://github.com/ahaqqu/RumaQ/issues/763) (Phase 2, fresh platform core) is the active issue and has no owner gate in front of it.

1. Phase 2 PR order (plan §6): contract vocabulary major → PostgreSQL 17 baseline → module skeleton → AutQ OIDC spike → evidence/R2 → ingest+outbox → source registry/publication → public read repositories. Host work stays in `ahaqqu/vps`.
2. Owner action X2: sign in at `https://rumaq-v1.ahaqqu.com` and confirm the existing household is intact. X1 is done and Google accepts both redirect URIs.
3. Remove the stale prepared `rumaq-v2` D1 manual action (MANUAL_ACTIONS T) only once the PostgreSQL gate is exercised.

**Visibility constraint:** the public switch is temporary. AutQ, DokumenQ, RumaQ-pipeline and vps return to private, so their spend matters again. Measured after Phase 1: ≈1,125 billed min/month against the 2,000 ceiling (vps ~490 at 4.4 min/run, AutQ ~340, DokumenQ ~215, pipeline ~80), and none of the four has a sub-daily scheduled workflow. RumaQ, the template, KajianQ and BayiQ stay public and do not bill.

Completed: #759 merged; phase issues #761–#771 linked with dependencies and Kanban status; annotated tag `rumaq-v1-freeze` at `10ea2629713a73a53eb17295421b8d78049557e3`; `rumaq-v1.ahaqqu.com` attached to the legacy Worker and answering (`/api/health` → 200, TLS valid) with the canonical host unchanged; legacy scraping paused on the box (`rumaq-scraper.timer` disabled + inactive, no NEXT, agent inactive) by the applier's declarative `disable_now` action; event-driven dependency auto-merge merged into the source template and verified live; Actions spend trimmed in all four private-bound repositories; dormant-fork Actions disabled on `no-mistakes` and `laradock-sidemaya`; `wni-series` deploy left as a guarded `workflow_dispatch` scaffold.

## Artifacts

| Artifact                                                                     | What it is                                                 |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [v2-ground-up-plan.md](v2-ground-up-plan.md)                                 | 10 phases, gates C0–C6, PR order, test policy              |
| [v2-design.md](v2-design.md)                                                 | Reconciled product + PostgreSQL/Bun/Hono architecture      |
| [v2-pipeline-audit.md](v2-pipeline-audit.md)                                 | Pipeline, prompt/model, accuracy, and cost evidence        |
| [v2-actions-audit.md](v2-actions-audit.md)                                   | Portfolio Actions inventory and retain/consolidate/disable |
| [v2-infrastructure-evaluation.md](v2-infrastructure-evaluation.md)           | Cloudflare/D1 vs VPS/PostgreSQL decision record            |
| [#759](https://github.com/ahaqqu/RumaQ/pull/759)                             | Merged docs PR carrying this program                       |
| [#761–#771](https://github.com/ahaqqu/RumaQ/issues/761)                      | Phase issues and dependency chain; #761 is active          |
| [#772](https://github.com/ahaqqu/RumaQ/pull/772)                             | v1 coexistence hostname (merged; host live)                |
| [vps #52](https://github.com/ahaqqu/vps/pull/52)                             | Declarative `disable_now` scraping pause (merged; applied) |
| [template #178](https://github.com/ahaqqu/agentic-project-template/pull/178) | Event-driven dependency auto-merge (merged)                |
| Tag `rumaq-v1-freeze`                                                        | Legacy freeze at `10ea262`                                 |
| [#748](https://github.com/ahaqqu/RumaQ/pull/748)                             | v2 mobile concept prototype (visual reference only)        |
| Pipeline #219 / PR #223                                                      | Reset/pause work to reconcile, not to finish               |
| RumaQ #753 / PR #754                                                         | Legacy fill-loop reset/wipe (merged; not the v2 loop)      |

Owner inbox note: `docs/MANUAL_ACTIONS.md` is gitignored and does not travel, so every open owner action must also be named on #758.

## Log

- 2026-11-26 — Five v2 research/design/plan documents committed and PR #759 opened; `ci` and `smoke` green, normal docs review posted no findings. Awaiting C0 including the disclosure decision.
- 2026-11-27 — Branch rebased onto `main` after #760 pruned obsolete docs (removes the stale `docs/plan/phase-*`, `docs/features/*`, `docs/design/*` tree). Added this state file as the cross-harness resume point.
- 2026-11-28 — Owner approved C0, including explicit acceptance of the audit disclosure scope. The approved next checkpoint is docs merge, child-issue tracking, legacy freeze/safety, and Actions Wave 1A; C2–C6 remain separately gated.
- 2026-11-28 — #759 merged and its main deploy succeeded. Created phase issues #761–#771 with dependencies; only Phase 0 (#761) is In Progress. Published annotated legacy freeze tag `rumaq-v1-freeze` at `10ea262`. Preparing the v1 Worker hostname without changing the canonical main hostname.
- 2026-11-28 — Phase 0 prepared end to end. RumaQ #772 (v1 hostname) is green with a clean thermos review; vps #52 adds a journaled `disable_now` applier action that disables **and stops** the nightly timer and Scrape Now agent (27 test files, 661 doc checks green locally) but its private-repo CI cannot start — jobs fail with zero executed steps, the account-wide quota wall. Wave 1A: template #178 replaces scheduled polling with event-driven auto-merge while keeping grouped-update parity (green, C1 noted); BayiQ polling and Template Sync disabled by settings; Actions disabled on two dormant forks; wni's guarded deploy scaffold left alone. No merge, deploy, or paid run was performed.
- 2026-11-28 — Owner made the repositories public, which retired the private-repo Actions quota wall; CI now executes real steps. Phase 0 closed: RumaQ #772 (88bbdc4) deployed both Worker custom domains — `rumaq-v1.ahaqqu.com` answers `/api/health` 200 with a valid certificate and the canonical host is unchanged; vps #52 (41fc408) merged on green CI and the applier applied the pause at 07:30 CET (`rumaq-scraper.timer` disabled + inactive with no NEXT, `rumaq-scraper-agent.service` inactive, `vps-apply.service` `Result=success`); template #178 (899ef48) merged. Verified the auto-merge workflow live by reopening Dependabot PR #175: `pull_request_target` fired, metadata resolved `semver-minor`, auto-merge was armed, and the merge correctly stayed blocked because that PR breaks the build (`zod/v4/core`, `zod-to-json-schema` unresolvable). No paid model call, data deletion, or main-hostname change.
- 2026-11-28 — Phase 1 closed with measured numbers rather than estimates: vps CI fell from 8–10 to 4.4 job-min per run after the parallel fixture diet, AutQ runs `push` on `main` only with cancel-in-progress, DokumenQ skips every lane for docs-only changes, and RumaQ-pipeline's Dependabot moved from daily to weekly (#224). The four private-bound repositories total ≈1,125 billed min/month against the 2,000 ceiling; vps, AutQ and DokumenQ have no scheduled workflows at all. Security-cadence work was deliberately not done: the scanners fail on real advisories, so the fix is dependency repair, not a quieter schedule.
