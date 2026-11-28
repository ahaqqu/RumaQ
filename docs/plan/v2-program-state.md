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

C0 is approved and [#761](https://github.com/ahaqqu/RumaQ/issues/761) (Phase 0) is the active issue. Continue the post-approval checkpoint:

1. Prepare and verify `rumaq-v1.ahaqqu.com` on the existing legacy Worker before touching the main deployment path. Google sign-in requires the v1 callback owner action recorded on #761.
2. Stop legacy scheduled and on-demand scraping through the controlled VPS/config path; keep the old code and data available for v1.
3. Run Phase 1 Actions reduction (Wave 1A) under [#762](https://github.com/ahaqqu/RumaQ/issues/762) as the first independent implementation work.
4. Remove the stale prepared `rumaq-v2` D1 manual action (MANUAL_ACTIONS T) only once the PostgreSQL gate is exercised.

Completed: #759 merged; phase issues #761–#771 are linked with dependencies and Kanban status; annotated tag `rumaq-v1-freeze` points to `10ea2629713a73a53eb17295421b8d78049557e3`.

## Artifacts

| Artifact                                                           | What it is                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| [v2-ground-up-plan.md](v2-ground-up-plan.md)                       | 10 phases, gates C0–C6, PR order, test policy              |
| [v2-design.md](v2-design.md)                                       | Reconciled product + PostgreSQL/Bun/Hono architecture      |
| [v2-pipeline-audit.md](v2-pipeline-audit.md)                       | Pipeline, prompt/model, accuracy, and cost evidence        |
| [v2-actions-audit.md](v2-actions-audit.md)                         | Portfolio Actions inventory and retain/consolidate/disable |
| [v2-infrastructure-evaluation.md](v2-infrastructure-evaluation.md) | Cloudflare/D1 vs VPS/PostgreSQL decision record            |
| [#759](https://github.com/ahaqqu/RumaQ/pull/759)                   | Merged docs PR carrying this program                       |
| [#761–#771](https://github.com/ahaqqu/RumaQ/issues/761)            | Phase issues and dependency chain; #761 is active          |
| Tag `rumaq-v1-freeze`                                              | Legacy freeze at `10ea262`                                 |
| [#748](https://github.com/ahaqqu/RumaQ/pull/748)                   | v2 mobile concept prototype (visual reference only)        |
| Pipeline #219 / PR #223                                            | Reset/pause work to reconcile, not to finish               |
| RumaQ #753 / PR #754                                               | Legacy fill-loop reset/wipe (merged; not the v2 loop)      |

Owner inbox note: `docs/MANUAL_ACTIONS.md` is gitignored and does not travel, so every open owner action must also be named on #758.

## Log

- 2026-11-26 — Five v2 research/design/plan documents committed and PR #759 opened; `ci` and `smoke` green, normal docs review posted no findings. Awaiting C0 including the disclosure decision.
- 2026-11-27 — Branch rebased onto `main` after #760 pruned obsolete docs (removes the stale `docs/plan/phase-*`, `docs/features/*`, `docs/design/*` tree). Added this state file as the cross-harness resume point.
- 2026-11-28 — Owner approved C0, including explicit acceptance of the audit disclosure scope. The approved next checkpoint is docs merge, child-issue tracking, legacy freeze/safety, and Actions Wave 1A; C2–C6 remain separately gated.
- 2026-11-28 — #759 merged and its main deploy succeeded. Created phase issues #761–#771 with dependencies; only Phase 0 (#761) is In Progress. Published annotated legacy freeze tag `rumaq-v1-freeze` at `10ea262`. Preparing the v1 Worker hostname without changing the canonical main hostname.
