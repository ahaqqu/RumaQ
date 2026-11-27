# RumaQ v2 — program state

> Resume point for the v2 program ([#758](https://github.com/ahaqqu/RumaQ/issues/758)). Read this file first, in any session, with any harness or model.
> Branch: `docs/v2-ground-up-plan` · PR: [#759](https://github.com/ahaqqu/RumaQ/pull/759) · Last updated: 2026-11-27

## Resume protocol

1. Work on the PR branch in a dedicated worktree (this machine: `/home/ahaqqu/Projects/RumaQ-wt-v2-docs`); never on `main`.
2. Read this file, then [v2-ground-up-plan.md](v2-ground-up-plan.md), and the [design](v2-design.md) before any implementation.
3. `gh pr view 759 --comments` and `gh issue view 758 --comments` hold the human record and decisions.
4. Execute only the **Next action** below, and only once the **Current gate** is signed. No implementation, deploy, paid model call, or live scrape before C0.
5. Before stopping: commit, push, and update **Current gate**, **Next action**, and **Log** in this file.

Working state lives in git and GitHub. Harness-local state (`~/.agents/manager/...`, chat history, local inboxes) does not travel between harnesses, models, or machines.

## Current gate

**C0 — owner plan approval: pending.** The five documents are complete and green. The owner must say "approve plan" and explicitly accept that the audits publish selected private-repository Actions metadata and private-pipeline operational details in this public repository.

No implementation PR, deploy, paid evaluation, workflow disablement, or live scrape until C0.

## Gates

| Gate | Unlocks                                                               | Status   |
| ---- | --------------------------------------------------------------------- | -------- |
| C0   | Plan approval; child issues; legacy freeze; Phase 1 Actions reduction | Pending  |
| C1   | Responsive public design foundation                                   | After C0 |
| C2   | Paid Superindo extraction/OCR pilot                                   | After C0 |
| C3   | New site on `rumaq.ahaqqu.com` plus Campaign A publication            | After C2 |
| C4   | Superindo `scheduled` mode and manual enablement of one next store    | After C3 |
| C5   | Next-store certification (repeat the whole program per store)         | After C4 |
| C6   | Each optional household module, approved one at a time                | After C3 |

## Next action

Waiting on C0. On approval, in order (plan §4 and §16):

1. Create child issues under #758, one per phase, with dependencies recorded and `Plan` as entry step; move only the active one to `In Progress`.
2. Freeze legacy with an annotated tag and prepare `rumaq-v1.ahaqqu.com` before touching the main deployment path.
3. Stop legacy scheduled scraping through the controlled VPS/config path; keep the old data.
4. Remove the stale prepared `rumaq-v2` D1 manual action (MANUAL_ACTIONS T) once the PostgreSQL gate is exercised.
5. Run Phase 1 Actions reduction (Wave 1A) as the first independent implementation work.

Do not open a second docs PR; extend #759.

## Artifacts

| Artifact                                                           | What it is                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| [v2-ground-up-plan.md](v2-ground-up-plan.md)                       | 10 phases, gates C0–C6, PR order, test policy              |
| [v2-design.md](v2-design.md)                                       | Reconciled product + PostgreSQL/Bun/Hono architecture      |
| [v2-pipeline-audit.md](v2-pipeline-audit.md)                       | Pipeline, prompt/model, accuracy, and cost evidence        |
| [v2-actions-audit.md](v2-actions-audit.md)                         | Portfolio Actions inventory and retain/consolidate/disable |
| [v2-infrastructure-evaluation.md](v2-infrastructure-evaluation.md) | Cloudflare/D1 vs VPS/PostgreSQL decision record            |
| [#759](https://github.com/ahaqqu/RumaQ/pull/759)                   | Docs PR carrying this program                              |
| [#748](https://github.com/ahaqqu/RumaQ/pull/748)                   | v2 mobile concept prototype (visual reference only)        |
| Pipeline #219 / PR #223                                            | Reset/pause work to reconcile, not to finish               |
| RumaQ #753 / PR #754                                               | Legacy fill-loop reset/wipe (merged; not the v2 loop)      |

Owner inbox note: `docs/MANUAL_ACTIONS.md` is gitignored and does not travel, so every open owner action must also be named on #758.

## Log

- 2026-11-26 — Five v2 research/design/plan documents committed and PR #759 opened; `ci` and `smoke` green, normal docs review posted no findings. Awaiting C0 including the disclosure decision.
- 2026-11-27 — Branch rebased onto `main` after #760 pruned obsolete docs (removes the stale `docs/plan/phase-*`, `docs/features/*`, `docs/design/*` tree). Added this state file as the cross-harness resume point.
